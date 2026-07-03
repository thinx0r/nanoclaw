/**
 * Google Sheets MCP Server for NanoClaw  (Fraid / Operations)
 * Dependency-free — uses native https + crypto + fs (Node 18+)
 * Key: /workspace/extra/patchbox/.mcp-secrets/<group>/google-sheets-key.json
 *
 * Purpose: read/write an Operations planning Sheet to obtain a delivery date.
 * The core flow is `sheets_delivery_date`: it ATOMICALLY (under a per-spreadsheet
 * file lock on the shared /workspace/extra/patchbox mount) writes the input
 * parameter cells, lets the Sheet recompute, and reads back the delivery-date
 * output cell. The lock serializes concurrent containers so two requests never
 * clobber each other's parameters mid-calculation.
 *
 * Scope: https://www.googleapis.com/auth/spreadsheets (read + write).
 *
 * Allowlist: GOOGLE_SHEETS_ALLOWED_IDS (comma-separated spreadsheet IDs). If set,
 * only those IDs may be touched. If empty/unset, all IDs the SA can access are
 * allowed (lock down via this env once the Operations Sheet ID is known).
 *
 * Tools: sheets_read, sheets_write, sheets_delivery_date
 */

import fs from 'fs';
import https from 'https';
import crypto from 'crypto';

const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';

interface SAKey { client_email: string; private_key: string; project_id?: string; token_uri?: string; }

const KEY: SAKey | null = (() => {
  const raw = process.env.GOOGLE_SHEETS_KEY
    || (() => { try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/google-sheets-key.json`, 'utf8'); } catch { return ''; } })();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
})();

// Optional spreadsheet-ID allowlist. Comma-separated. Empty = allow all the SA can reach.
const ALLOWED_IDS: string[] = (process.env.GOOGLE_SHEETS_ALLOWED_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Locks live on the SHARED patchbox mount so they serialize ACROSS containers.
const LOCK_DIR = '/workspace/extra/patchbox/.locks';
const LOCK_TIMEOUT_MS = 30000;   // max wait to acquire a lock
const LOCK_STALE_MS = 90000;     // a lock older than this is considered abandoned
// Default settle time between writing inputs and reading the recomputed output.
const DEFAULT_SETTLE_MS = 700;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function httpsJson(opts: https.RequestOptions, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const parsed = d ? JSON.parse(d) : {};
          if (parsed.error) {
            const msg = parsed.error.message || parsed.error_description || JSON.stringify(parsed.error);
            reject(new Error(`Google API ${res.statusCode}: ${msg}`));
          } else resolve(parsed);
        } catch { reject(new Error(`Non-JSON response (${res.statusCode}): ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Service-account OAuth2 (JWT bearer) ----------------------------------
let cachedToken: { value: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (!KEY) throw new Error('No Google service-account key configured.');
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.value;

  const tokenUri = KEY.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: KEY.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(KEY.private_key));
  const jwt = `${header}.${claim}.${sig}`;

  const form = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`;
  const u = new URL(tokenUri);
  const res = await httpsJson({
    hostname: u.hostname, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
  }, form);
  if (!res.access_token) throw new Error('No access_token in token response.');
  cachedToken = { value: res.access_token, exp: now + (res.expires_in || 3600) };
  return res.access_token;
}

// --- Sheets API helpers ---------------------------------------------------
function assertAllowed(spreadsheetId: string): void {
  if (!spreadsheetId || !/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) {
    throw new Error(`Invalid spreadsheet_id: ${JSON.stringify(spreadsheetId)}`);
  }
  if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(spreadsheetId)) {
    throw new Error(`spreadsheet_id not on allowlist. Allowed: ${ALLOWED_IDS.join(', ') || '(none configured)'}`);
  }
}

const SHEETS_HOST = 'sheets.googleapis.com';

async function valuesGet(spreadsheetId: string, range: string, render = 'FORMATTED_VALUE'): Promise<string[][]> {
  const token = await getAccessToken();
  const path = `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
    + `?valueRenderOption=${encodeURIComponent(render)}&dateTimeRenderOption=FORMATTED_STRING`;
  const res = await httpsJson({ hostname: SHEETS_HOST, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  return (res.values as string[][]) || [];
}

async function valuesUpdate(spreadsheetId: string, range: string, values: unknown[][]): Promise<void> {
  const token = await getAccessToken();
  const body = JSON.stringify({ values });
  const path = `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
    + `?valueInputOption=USER_ENTERED`;
  await httpsJson({
    hostname: SHEETS_HOST, path, method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

// --- Cross-container file lock (dependency-free) ---------------------------
async function withLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch {}
  const safeKey = lockKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  const lockPath = `${LOCK_DIR}/sheets-${safeKey}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = -1;
  for (;;) {
    try { fd = fs.openSync(lockPath, 'wx'); break; }
    catch {
      // Reap a stale lock left behind by a crashed container.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch {}
      if (Date.now() > deadline) throw new Error(`Could not acquire Sheet lock within ${LOCK_TIMEOUT_MS}ms (another request is in progress).`);
      await sleep(200);
    }
  }
  try {
    try { fs.writeSync(fd, `${process.pid} ${_GROUP}`); } catch {}
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

// --- Tools ----------------------------------------------------------------
const TOOLS = [
  {
    name: 'sheets_read',
    description: 'Read a cell range from an Operations Google Sheet (read-only). Returns a 2D array of values as displayed in the Sheet (FORMATTED_VALUE by default). Use to inspect current inputs, headers, or the delivery-date cell without changing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The Google Sheets spreadsheet ID (from its URL).' },
        range: { type: 'string', description: 'A1-notation range incl. tab, e.g. "Planung!A1:B10" or a single cell "Planung!B9".' },
        render: { type: 'string', description: 'FORMATTED_VALUE (default, as displayed) or UNFORMATTED_VALUE (raw numbers/serials).' },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  {
    name: 'sheets_write',
    description: 'Write values to a cell range in an Operations Google Sheet (USER_ENTERED — strings/numbers/dates are parsed like manual entry). ONLY write defined input-parameter cells. For the normal delivery-date flow use sheets_delivery_date instead, which locks and reads the result for you.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The Google Sheets spreadsheet ID.' },
        range: { type: 'string', description: 'A1-notation range incl. tab, e.g. "Planung!B2".' },
        values: { type: 'array', description: '2D array of row arrays, e.g. [["Patchcatch Solo"]] for a single cell, or [["A","B"],["C","D"]] for a block.', items: { type: 'array', items: {} } },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  {
    name: 'sheets_delivery_date',
    description: 'PRIMARY TOOL. Atomically and under a per-spreadsheet lock: write the given input parameters into their cells, let the Sheet recompute, then read back the delivery-date output cell. Returns the delivery date exactly as the Sheet computes it (never estimated). The lock serializes concurrent requests so parameters never collide. Always report the returned date together with the inputs you set.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The Google Sheets spreadsheet ID.' },
        inputs: {
          type: 'array',
          description: 'The input parameters to write, each {range, value}. range is A1-notation for a single input cell (e.g. "Planung!B2"); value is the parameter value (string/number).',
          items: {
            type: 'object',
            properties: {
              range: { type: 'string', description: 'A1-notation single cell incl. tab, e.g. "Planung!B3".' },
              value: { description: 'The value to write (string or number).' },
            },
            required: ['range', 'value'],
          },
        },
        output_range: { type: 'string', description: 'A1-notation of the delivery-date output cell to read after recompute, e.g. "Planung!B9".' },
        settle_ms: { type: 'number', description: `Optional ms to wait between writing inputs and reading the output, to let the Sheet recompute (default ${DEFAULT_SETTLE_MS}).` },
      },
      required: ['spreadsheet_id', 'inputs', 'output_range'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'sheets_read': {
      const id = String(args.spreadsheet_id || '');
      const range = String(args.range || '');
      assertAllowed(id);
      if (!range) throw new Error('range is required.');
      const render = typeof args.render === 'string' ? args.render : 'FORMATTED_VALUE';
      const values = await valuesGet(id, range, render);
      return JSON.stringify({ spreadsheet_id: id, range, values }, null, 2);
    }

    case 'sheets_write': {
      const id = String(args.spreadsheet_id || '');
      const range = String(args.range || '');
      assertAllowed(id);
      if (!range) throw new Error('range is required.');
      if (!Array.isArray(args.values)) throw new Error('values must be a 2D array.');
      await withLock(id, async () => { await valuesUpdate(id, range, args.values as unknown[][]); });
      return JSON.stringify({ ok: true, spreadsheet_id: id, range, written: args.values }, null, 2);
    }

    case 'sheets_delivery_date': {
      const id = String(args.spreadsheet_id || '');
      assertAllowed(id);
      const inputs = args.inputs as { range: string; value: unknown }[] | undefined;
      const outputRange = String(args.output_range || '');
      if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('inputs must be a non-empty array of {range, value}.');
      if (!outputRange) throw new Error('output_range is required.');
      for (const it of inputs) {
        if (!it || typeof it.range !== 'string' || !it.range) throw new Error('each input needs a string range.');
      }
      const settle = typeof args.settle_ms === 'number' && args.settle_ms >= 0 ? Math.min(args.settle_ms, 10000) : DEFAULT_SETTLE_MS;

      const result = await withLock(id, async () => {
        // Write each input cell (USER_ENTERED so dates/numbers parse naturally).
        for (const it of inputs) {
          await valuesUpdate(id, it.range, [[it.value]]);
        }
        // Let the Sheet recompute dependent formulas before reading the output.
        await sleep(settle);
        const out = await valuesGet(id, outputRange, 'FORMATTED_VALUE');
        return out;
      });

      const cell = (result[0] && result[0][0] != null) ? String(result[0][0]) : '';
      const looksEmpty = cell.trim() === '';
      const looksError = /^#(REF|VALUE|DIV\/0|N\/A|NAME|NULL|NUM|ERROR)/i.test(cell.trim());
      return JSON.stringify({
        spreadsheet_id: id,
        inputs_written: inputs,
        output_range: outputRange,
        delivery_date: cell,
        ok: !looksEmpty && !looksError,
        warning: looksEmpty ? 'Output cell is empty — do NOT report this as a date; escalate to Operations.'
          : looksError ? `Output cell returned a spreadsheet error (${cell}) — do NOT report as a date; escalate to Operations.`
          : undefined,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try { await handle(JSON.parse(line)); } catch {}
  }
});

async function handle(req: { id?: unknown; method: string; params?: unknown }) {
  const { id, method, params } = req;
  try {
    let result: unknown;
    switch (method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'google-sheets-mcp', version: '1.0.0' } };
        break;
      case 'notifications/initialized': return;
      case 'tools/list': result = { tools: TOOLS }; break;
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
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
  }
}

function send(obj: unknown) { process.stdout.write(JSON.stringify(obj) + '\n'); }
