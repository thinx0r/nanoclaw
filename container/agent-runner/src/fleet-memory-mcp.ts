/**
 * Fleet Memory MCP Server — shared activity/decision/blocker log for the bot fleet.
 *
 * All five bots (AIden, AIm, KIm, Kirsten, Sheldon) write into the same SQLite
 * file via this server. Kirsten reads from it to build the morning briefing.
 * This replaces the `agents/<bot>/memory/diary.md` discipline-based pattern
 * with an enforced tool call — writes happen as a side-effect of task
 * completion, not as "please remember to update the diary" markdown edits.
 *
 * Architecture: see playbook/FLEET-MEMORY.md.
 *
 * DB location (inside container): /workspace/extra/patchbox/shared-memory/fleet.db
 * Schema: shared-memory/fleet-schema.sql
 *
 * The MCP server runs as a child process of the agent-runner. stdio transport
 * with JSON-RPC, following the same pattern as openai-mcp.ts and meta-ads-mcp.ts.
 *
 * Agent identity is taken from `ASSISTANT_NAME` env (lowercased). We do NOT
 * accept an explicit `agent` argument — a bot can only log under its own
 * identity. This prevents accidental (or intentional) impersonation.
 *
 * Read tools are unrestricted: any bot can query the full fleet log. Writes
 * are limited to the calling bot's own identity.
 *
 * SQLite binding: uses Node.js's built-in `node:sqlite` (DatabaseSync). This
 * is an experimental module in Node 22.x so the server must be launched with
 * `NODE_OPTIONS=--experimental-sqlite` (set in the mcpServers env block in
 * the canonical agent-runner index.ts). No npm dependency needed — the
 * nanoclaw-agent Docker image does not have better-sqlite3 and adding it
 * would require rebuilding the image.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

// ── Configuration ───────────────────────────────────────────────────────────

const DB_PATH = process.env.FLEET_MEMORY_DB
    || '/workspace/extra/patchbox/shared-memory/fleet.db';

// Normalise ASSISTANT_NAME to a stable agent ID. The env value is whatever
// the .env is set to (e.g. "AIden", "KIm", "Sheldon"); we use lowercase
// throughout the DB so queries are case-insensitive.
const SELF = (process.env.ASSISTANT_NAME || '').trim().toLowerCase();

if (!SELF) {
    // Fail loudly at startup rather than silently logging under an empty
    // agent name. The agent-runner will see this on stderr and the MCP
    // handshake will fail, which surfaces quickly in container logs.
    process.stderr.write('[fleet-memory-mcp] FATAL: ASSISTANT_NAME env var is not set\n');
    process.exit(2);
}

// ── DB setup ────────────────────────────────────────────────────────────────

const db = openDb(DB_PATH);

function openDb(dbPath: string): InstanceType<typeof DatabaseSync> {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        process.stderr.write(`[fleet-memory-mcp] FATAL: DB directory does not exist: ${dir}\n`);
        process.exit(2);
    }
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`[fleet-memory-mcp] FATAL: fleet.db does not exist at ${dbPath} — run setup/scripts/init-fleet-db.sh first\n`);
        process.exit(2);
    }
    const handle = new DatabaseSync(dbPath);
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA foreign_keys = ON');
    // Verify schema is present. If fleet_events table is missing the DB is
    // uninitialised — refuse to run rather than silently creating tables.
    const row = handle.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_events'"
    ).get();
    if (!row) {
        process.stderr.write(`[fleet-memory-mcp] FATAL: fleet.db at ${dbPath} is missing fleet_events table — run init-fleet-db.sh\n`);
        process.exit(2);
    }
    return handle;
}

// ── Prepared statements ─────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
    INSERT INTO fleet_events
        (agent, event_type, summary, details, classification, severity, needs_input_from, metadata)
    VALUES
        (@agent, @event_type, @summary, @details, @classification, @severity, @needs_input_from, @metadata)
`);

const stmtQuery = db.prepare(`
    SELECT id, agent, event_type, summary, details, classification,
           severity, needs_input_from, metadata, created_at
    FROM fleet_events
    WHERE created_at >= @since
      AND (@agent IS NULL OR agent = @agent)
      AND (@event_type IS NULL OR event_type = @event_type)
    ORDER BY created_at DESC
    LIMIT @limit
`);

const stmtSnapshot = db.prepare(`
    SELECT agent, event_type, COUNT(*) AS count
    FROM fleet_events
    WHERE created_at >= @since
    GROUP BY agent, event_type
    ORDER BY agent, event_type
`);

// ── Tool handlers ───────────────────────────────────────────────────────────

// insertEvent accepts the raw MCP args object (Record<string, unknown>)
// and validates every field before reaching SQLite. This keeps the trust
// boundary at one place; the SQL CHECK constraints are defence-in-depth.

function requireString(args: Record<string, unknown>, key: string, minLen = 1): string {
    const v = args[key];
    if (typeof v !== 'string' || v.trim().length < minLen) {
        throw new Error(`"${key}" is required and must be a non-empty string`);
    }
    return v.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
    const v = args[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
    return v;
}

function optionalObject(args: Record<string, unknown>, key: string): string | null {
    const v = args[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object') throw new Error(`"${key}" must be an object`);
    return JSON.stringify(v);
}

function validClassification(c: unknown): string {
    const allowed = new Set(['public', 'internal', 'confidential', 'secret']);
    if (c === undefined || c === null) return 'internal';
    if (typeof c !== 'string' || !allowed.has(c)) {
        throw new Error(`invalid classification "${String(c)}" — must be one of: ${[...allowed].join(', ')}`);
    }
    return c;
}

function validSeverity(s: unknown): string {
    const allowed = new Set(['low', 'medium', 'high', 'critical']);
    if (typeof s !== 'string' || !allowed.has(s)) {
        throw new Error(`severity is required for blockers and must be one of: ${[...allowed].join(', ')}`);
    }
    return s;
}

function insertEvent(
    event_type: 'activity' | 'decision' | 'blocker',
    args: Record<string, unknown>
): { id: number; created_at: string } {
    const info = stmtInsert.run({
        agent: SELF,
        event_type,
        summary: requireString(args, 'summary'),
        details: optionalString(args, 'details'),
        classification: validClassification(args.classification),
        severity: event_type === 'blocker' ? validSeverity(args.severity) : null,
        needs_input_from: optionalString(args, 'needs_input_from'),
        metadata: optionalObject(args, 'metadata'),
    });
    const row = db.prepare('SELECT id, created_at FROM fleet_events WHERE id = ?')
        .get(info.lastInsertRowid) as { id: number; created_at: string };
    return row;
}

function parseSince(since?: string): string {
    if (!since) {
        // Default: last 24 hours.
        return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }
    // Accept either ISO 8601 or a relative shortcut like "24h" / "7d" / "1h".
    const rel = /^(\d+)([hd])$/.exec(since);
    if (rel) {
        const n = parseInt(rel[1], 10);
        const ms = rel[2] === 'h' ? n * 3600_000 : n * 86400_000;
        return new Date(Date.now() - ms).toISOString();
    }
    // Validate ISO 8601 by parsing.
    const d = new Date(since);
    if (isNaN(d.getTime())) {
        throw new Error(`invalid since value "${since}" — use ISO 8601 or "<n>h" / "<n>d"`);
    }
    return d.toISOString();
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'fleet_log_activity',
        description:
            'Record a completed activity by THIS bot. Call this at the end of any non-trivial task — a customer response sent, a deploy completed, a brief drafted, a decision reached, a bot coordination done. One-line summary + optional details. The agent is auto-derived from ASSISTANT_NAME; you cannot log on behalf of another bot.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'One-line headline of what you just did (≤120 chars recommended)' },
                details: { type: 'string', description: 'Optional longer description, markdown allowed' },
                classification: {
                    type: 'string',
                    description: 'Data classification (default: internal)',
                    enum: ['public', 'internal', 'confidential', 'secret'],
                },
                metadata: { type: 'object', description: 'Free-form JSON object for structured fields (e.g. ticket_id, campaign_id)' },
            },
            required: ['summary'],
        },
    },
    {
        name: 'fleet_log_decision',
        description:
            'Record a decision THIS bot has made or communicated (draft approved, brief handed off, escalation routed). Use for decisions that affect other bots or future briefings — not every internal micro-choice.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'One-line headline of the decision' },
                details: { type: 'string', description: 'Context + reasoning, markdown allowed' },
                classification: {
                    type: 'string',
                    description: 'Data classification (default: internal)',
                    enum: ['public', 'internal', 'confidential', 'secret'],
                },
                metadata: { type: 'object', description: 'Free-form JSON' },
            },
            required: ['summary', 'details'],
        },
    },
    {
        name: 'fleet_log_blocker',
        description:
            'Record that THIS bot is blocked and needs input. This will surface in the next leadership briefing. Always include severity + who needs to unblock you.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'What you need to proceed' },
                details: { type: 'string', description: 'Full context of the blocker' },
                severity: {
                    type: 'string',
                    description: 'low = inconvenient, medium = slows progress, high = stuck, critical = fleet-impacting',
                    enum: ['low', 'medium', 'high', 'critical'],
                },
                needs_input_from: { type: 'string', description: 'Alex, Kirsten, another bot, or a team member — who unblocks you?' },
                classification: {
                    type: 'string',
                    description: 'Data classification (default: internal)',
                    enum: ['public', 'internal', 'confidential', 'secret'],
                },
                metadata: { type: 'object', description: 'Free-form JSON' },
            },
            required: ['summary', 'severity', 'needs_input_from'],
        },
    },
    {
        name: 'fleet_query',
        description:
            'Read events from the fleet log. Use for cross-bot coordination (e.g. "what did AIm do this week?") or when you need context before a response. Read access is unrestricted across all bots.',
        inputSchema: {
            type: 'object',
            properties: {
                since: {
                    type: 'string',
                    description: 'ISO 8601 timestamp or relative shortcut like "24h", "7d". Default: "24h" (last 24 hours).',
                },
                agent: {
                    type: 'string',
                    description: 'Filter to a specific bot (lowercase: aiden, aim, kim, kirsten, sheldon). Omit for all bots.',
                },
                event_type: {
                    type: 'string',
                    description: 'Filter by event type. Omit for all.',
                    enum: ['activity', 'decision', 'blocker'],
                },
                limit: { type: 'number', description: 'Max rows to return (default 100, max 500)' },
            },
            required: [],
        },
    },
    {
        name: 'fleet_snapshot',
        description:
            'Aggregate counts of events per bot per type within a time window — lightweight summary for the morning briefing. Use this first, then fleet_query for details on specific bots.',
        inputSchema: {
            type: 'object',
            properties: {
                since: {
                    type: 'string',
                    description: 'ISO 8601 or relative shortcut like "24h". Default: "24h".',
                },
            },
            required: [],
        },
    },
];

// ── Tool dispatch ───────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
        case 'fleet_log_activity': {
            const row = insertEvent('activity', args);
            return JSON.stringify({ ok: true, ...row, agent: SELF, event_type: 'activity' }, null, 2);
        }
        case 'fleet_log_decision': {
            const row = insertEvent('decision', args);
            return JSON.stringify({ ok: true, ...row, agent: SELF, event_type: 'decision' }, null, 2);
        }
        case 'fleet_log_blocker': {
            const row = insertEvent('blocker', args);
            return JSON.stringify({ ok: true, ...row, agent: SELF, event_type: 'blocker' }, null, 2);
        }
        case 'fleet_query': {
            const sinceIso = parseSince(args.since as string | undefined);
            const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
            const rows = stmtQuery.all({
                since: sinceIso,
                agent: (args.agent as string | undefined)?.toLowerCase() ?? null,
                event_type: (args.event_type as string | undefined) ?? null,
                limit,
            }) as Array<{ metadata: string | null } & Record<string, unknown>>;
            // Re-hydrate metadata JSON for readability
            for (const r of rows) {
                if (r.metadata) {
                    try { r.metadata = JSON.parse(r.metadata as string); } catch { /* leave as string */ }
                }
            }
            return JSON.stringify({ since: sinceIso, count: rows.length, events: rows }, null, 2);
        }
        case 'fleet_snapshot': {
            const sinceIso = parseSince(args.since as string | undefined);
            const rows = stmtSnapshot.all({ since: sinceIso }) as Array<{ agent: string; event_type: string; count: number }>;
            // Reshape to { [agent]: { activity, decision, blocker } }
            const byAgent: Record<string, Record<string, number>> = {};
            for (const r of rows) {
                byAgent[r.agent] = byAgent[r.agent] || { activity: 0, decision: 0, blocker: 0 };
                byAgent[r.agent][r.event_type] = r.count;
            }
            return JSON.stringify({ since: sinceIso, snapshot: byAgent }, null, 2);
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

// ── MCP stdio loop ──────────────────────────────────────────────────────────

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
        if (!line.trim()) continue;
        try { await handle(JSON.parse(line)); } catch { /* malformed JSON — drop silently, MCP spec */ }
    }
});

async function handle(req: { id?: unknown; method: string; params?: unknown }) {
    const { id, method, params } = req;
    try {
        let result: unknown;
        switch (method) {
            case 'initialize':
                result = {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'fleet-memory-mcp', version: '1.0.0' },
                };
                break;
            case 'notifications/initialized':
                return;
            case 'tools/list':
                result = { tools: TOOLS };
                break;
            case 'tools/call': {
                const p = params as { name: string; arguments: Record<string, unknown> };
                result = { content: [{ type: 'text', text: await callTool(p.name, p.arguments || {}) }] };
                break;
            }
            default:
                if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Not found: ${method}` } });
                return;
        }
        if (id !== undefined) send({ jsonrpc: '2.0', id, result });
    } catch (err) {
        if (id !== undefined) send({
            jsonrpc: '2.0', id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
    }
}

function send(obj: unknown) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}
