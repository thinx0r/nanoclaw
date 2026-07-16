/**
 * Drive-Sync MCP Server — on-demand Google-Drive sync trigger.
 *
 * Every 15 minutes a cron job on the host (drive-sync-all.sh) syncs each
 * bot's IN/OUT dirs with the shared Google Drive. That's fine for
 * background refresh, but when a bot has just written a fresh report to
 * OUT/ and Alex wants to see it in Drive *now*, waiting up to 15 min is
 * painful. This server lets any bot trigger a sync for its own drive
 * space on demand.
 *
 * Architecture: file-trigger IPC. The bot (inside a container) writes a
 * .req file into the repo's shared-memory/drive-sync-requests/ directory,
 * which is bind-mounted from /opt/patchbox/ on the host. A systemd.path
 * unit on the host watches that directory; the paired service runs
 * drive-sync-processor.sh which invokes rclone with root credentials
 * and writes a matching .resp file the bot can read. The MCP tool hides
 * this round-trip behind a single call.
 *
 * Why not rclone inside the container: the rclone config (with the
 * gdrive OAuth token) lives in /root/.config/rclone/rclone.conf on the
 * host. Mounting that into every container would spread a sensitive
 * credential too wide. The on-demand processor keeps rclone + its
 * credentials on the host, same as the existing 15-min cron job.
 *
 * Agent identity: auto-derived from ASSISTANT_NAME env, same pattern as
 * fleet-memory-mcp. A bot can only sync its own drive directory. No
 * impersonation.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const REQ_DIR = process.env.DRIVE_SYNC_REQ_DIR
    || '/workspace/extra/patchbox/shared-memory/drive-sync-requests';

const SELF = (process.env.ASSISTANT_NAME || '').trim().toLowerCase();
if (!SELF) {
    process.stderr.write('[drive-sync-mcp] FATAL: ASSISTANT_NAME env var not set\n');
    process.exit(2);
}

// Known bots the host processor understands. Keep in sync with the
// LOCAL_DIR map in setup/scripts/drive-sync-processor.sh.
const KNOWN_BOTS = new Set(['aiden', 'aim', 'dr-data', 'kim', 'kirsten', 'sheldon']);
if (!KNOWN_BOTS.has(SELF)) {
    process.stderr.write(`[drive-sync-mcp] FATAL: ASSISTANT_NAME="${SELF}" is not in the known-bots list; update drive-sync-processor.sh and drive-sync-mcp.ts together\n`);
    process.exit(2);
}

// Poll interval and default deadline. rclone on a small-ish drive
// finishes in a few hundred ms; we cap at 60s and return a pending
// status if the processor hasn't written .resp by then. The host
// processor logs continue regardless — nothing is lost.
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;  // 10 min — matches the service's TimeoutStartSec

interface ResponsePayload {
    status: 'completed' | 'failed' | 'pending' | 'timeout';
    exit_code?: number;
    duration_ms?: number;
    stdout_tail?: string;
    stderr_tail?: string;
    processed_at?: string;
    timed_out_after_ms?: number;
    request_id?: string;
}

async function triggerSync(direction: string, timeoutMs: number): Promise<ResponsePayload> {
    if (!['pull', 'push', 'both'].includes(direction)) {
        throw new Error(`invalid direction "${direction}" — must be one of: pull, push, both`);
    }
    if (!fs.existsSync(REQ_DIR)) {
        throw new Error(`request directory does not exist: ${REQ_DIR} — run setup/scripts/install-drive-sync-on-demand.sh on the host`);
    }

    const reqId = `${SELF}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const reqPath = path.join(REQ_DIR, `${reqId}.req`);
    const respPath = path.join(REQ_DIR, `${reqId}.resp`);

    const requestedAt = new Date().toISOString();
    fs.writeFileSync(reqPath, JSON.stringify({
        bot: SELF,
        direction,
        requested_by: SELF,
        requested_at: requestedAt,
    }, null, 2));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(respPath)) {
            try {
                const raw = fs.readFileSync(respPath, 'utf8');
                const parsed = JSON.parse(raw) as ResponsePayload;
                // Keep the response file briefly in case caller wants to
                // re-read; the request dir is auto-cleaned by a periodic
                // cleanup task (or can be manually truncated).
                return { ...parsed, request_id: reqId };
            } catch (err) {
                return {
                    status: 'failed',
                    exit_code: -1,
                    stderr_tail: `failed to parse response JSON: ${err instanceof Error ? err.message : String(err)}`,
                    request_id: reqId,
                };
            }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return {
        status: 'timeout',
        timed_out_after_ms: timeoutMs,
        stderr_tail: `no response within ${timeoutMs}ms; the sync may still be running on the host — check /var/log/nanoclaw-drive-sync.log`,
        request_id: reqId,
    };
}

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'drive_sync',
        description:
            'Trigger a Google Drive sync for THIS bot right now, instead of waiting for the next 15-min cron run. Useful right after writing a report to /workspace/extra/drive/OUT/ that Alex needs to see in Drive immediately, or when you need the freshest IN/ content before starting a task. Returns status, duration, and a log tail. The agent is auto-derived from ASSISTANT_NAME; you can only sync your own drive directory.',
        inputSchema: {
            type: 'object',
            properties: {
                direction: {
                    type: 'string',
                    description: 'pull = Drive → local (refresh IN/), push = local → Drive (publish OUT/), both = sync both directions (default)',
                    enum: ['pull', 'push', 'both'],
                },
                timeout_ms: {
                    type: 'number',
                    description: 'How long to wait for completion before returning "timeout" status (default 60000, max 600000). The sync keeps running on the host even if the tool call times out — check /var/log/nanoclaw-drive-sync.log for the final result.',
                },
            },
            required: [],
        },
    },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
        case 'drive_sync': {
            const direction = (args.direction as string | undefined) ?? 'both';
            let timeoutMs = Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                timeoutMs = DEFAULT_TIMEOUT_MS;
            }
            timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
            const result = await triggerSync(direction, timeoutMs);
            return JSON.stringify(result, null, 2);
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
        try { await handle(JSON.parse(line)); } catch { /* malformed JSON — drop silently */ }
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
                    serverInfo: { name: 'drive-sync-mcp', version: '1.0.0' },
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
