/**
 * Seat routing for the Quiet Fleet seat migration (config-driven).
 *
 * Decides per agent whether Anthropic auth flows through the OneCLI gateway
 * (legacy: API key, per-token billing) or via a Claude subscription OAuth
 * token (CLAUDE_CODE_OAUTH_TOKEN), which bypasses OneCLI entirely.
 *
 * Config is read from <cwd>/seat-routing.json, so it is per bot instance:
 * each bot runs with WorkingDirectory=/opt/nanoclaw-<bot>, therefore a bot
 * with no file keeps the legacy OneCLI behaviour (zero change, fleet-safe).
 *
 * Supports the staged rollout without redesign:
 *  - Stufe 1: one shared token for every bot (top-level mode:"oauth").
 *  - Stufe 2: same shape, token swapped for a Premium-Seat login.
 *  - Stufe 3: per-agent overrides via the optional "agents" map.
 *
 * Fails safe: any misconfiguration falls back to OneCLI rather than leaving a
 * bot silently without credentials.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export type SeatMode = 'oauth' | 'onecli';

export interface SeatResolution {
  mode: SeatMode;
  /** Present only when mode === 'oauth'. Never logged. */
  token?: string;
}

interface SeatEntry {
  mode?: SeatMode;
  tokenFile?: string;
}

interface SeatConfig extends SeatEntry {
  agents?: Record<string, SeatEntry>;
}

/** Key used for the main group (agentIdentifier === undefined). */
const MAIN_KEY = '__main__';

let cachedConfig: SeatConfig | null | undefined;
const tokenCache = new Map<string, string>();

function loadConfig(): SeatConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const file = path.join(process.cwd(), 'seat-routing.json');
  try {
    if (!fs.existsSync(file)) {
      cachedConfig = null;
      return cachedConfig;
    }
    cachedConfig = JSON.parse(fs.readFileSync(file, 'utf8')) as SeatConfig;
    logger.info({ file }, 'Seat routing config loaded');
  } catch (err) {
    logger.warn(
      { file, err },
      'Seat routing config unreadable — defaulting to OneCLI',
    );
    cachedConfig = null;
  }
  return cachedConfig;
}

function readToken(tokenFile: string): string | undefined {
  const abs = path.isAbsolute(tokenFile)
    ? tokenFile
    : path.join(process.cwd(), tokenFile);
  const cached = tokenCache.get(abs);
  if (cached !== undefined) return cached || undefined;
  try {
    const token = fs.readFileSync(abs, 'utf8').trim();
    tokenCache.set(abs, token);
    return token || undefined;
  } catch (err) {
    logger.error({ tokenFile: abs, err }, 'Seat OAuth token file unreadable');
    tokenCache.set(abs, '');
    return undefined;
  }
}

/**
 * Resolve the Anthropic auth mode for one agent.
 * agentIdentifier === undefined means the main group.
 */
export function resolveSeat(agentIdentifier?: string): SeatResolution {
  const config = loadConfig();
  if (!config) return { mode: 'onecli' };

  const key = agentIdentifier ?? MAIN_KEY;
  const override = config.agents?.[key];
  const mode: SeatMode =
    (override?.mode ?? config.mode) === 'oauth' ? 'oauth' : 'onecli';
  if (mode !== 'oauth') return { mode: 'onecli' };

  const tokenFile = override?.tokenFile ?? config.tokenFile;
  if (!tokenFile) {
    logger.warn(
      { agentIdentifier },
      'Seat mode oauth but no tokenFile — falling back to OneCLI',
    );
    return { mode: 'onecli' };
  }
  const token = readToken(tokenFile);
  if (!token) {
    logger.error(
      { agentIdentifier },
      'Seat mode oauth but token missing — falling back to OneCLI',
    );
    return { mode: 'onecli' };
  }
  return { mode: 'oauth', token };
}
