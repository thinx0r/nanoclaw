/**
 * Slack MCP Server for NanoClaw
 * Dependency-free — uses native fetch (Node 18+)
 * Tools: add_reaction, remove_reaction, get_messages, get_thread_replies, post_message, get_user_info
 */

import fs from 'fs';
const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';
const TOKEN = process.env.SLACK_BOT_TOKEN || (() => { try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/slack-token`,'utf8').trim(); } catch { return ''; } })();

// Accepts a Slack ts / epoch ("1749999999.000200"), an ISO date ("2026-06-01")
// or ISO datetime and returns epoch seconds as string for oldest/latest params.
function toSlackTs(v: string): string {
  if (/^\d+(\.\d+)?$/.test(v)) return v;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`Invalid date/timestamp: ${v} (use ISO date like 2026-06-01 or a Slack ts)`);
  return String(ms / 1000);
}

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name?: string; count?: number }>;
}
interface HistoryPage {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

function compactMessage(m: SlackMessage) {
  return {
    ts: m.ts,
    user: m.user || m.username || m.bot_id,
    text: m.text,
    ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
    ...(m.reply_count ? { reply_count: m.reply_count } : {}),
    ...(m.reactions?.length ? { reactions: m.reactions.map(r => ({ name: r.name, count: r.count })) } : {}),
  };
}

// Pages through conversations.history/replies until `total` messages are
// collected or the window is exhausted. Slack caps limit at ~200 per page.
async function fetchPaged(method: string, base: Record<string, string>, total: number, startCursor?: string): Promise<string> {
  const messages: SlackMessage[] = [];
  let cursor = startCursor || '';
  let hasMore = false;
  while (messages.length < total) {
    const page = await slackApi(method, {
      ...base,
      limit: String(Math.min(total - messages.length, 200)),
      ...(cursor ? { cursor } : {}),
    }) as HistoryPage;
    messages.push(...(page.messages || []));
    cursor = page.response_metadata?.next_cursor || '';
    hasMore = Boolean(page.has_more && cursor);
    if (!hasMore) break;
  }
  return JSON.stringify({
    message_count: messages.length,
    has_more: hasMore,
    ...(hasMore ? { next_cursor: cursor } : {}),
    messages: messages.map(compactMessage),
  }, null, 2);
}

// GET variant for read methods that don't accept JSON bodies (e.g. users.info).
async function slackApiGet(method: string, params: Record<string, string>): Promise<unknown> {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

async function slackApi(method: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

const TOOLS = [
  {
    name: 'slack_add_reaction',
    description: 'Add an emoji reaction to a Slack message',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (e.g. C0AS3DKL8SK)' },
        timestamp: { type: 'string', description: 'Message timestamp (e.g. 1234567890.123456)' },
        emoji: { type: 'string', description: 'Emoji name without colons (e.g. thumbsup, white_check_mark)' },
      },
      required: ['channel', 'timestamp', 'emoji'],
    },
  },
  {
    name: 'slack_get_messages',
    description: 'Get messages from a Slack channel or DM (newest first). Supports the FULL channel history: use oldest/latest to set a time window (ISO date or Slack ts) and limit up to 1000 messages per call; pages internally. Returns compact messages (ts, user, text, thread_ts, reply_count, reactions) — use slack_get_thread_replies for thread contents.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (e.g. C... or D...)' },
        limit: { type: 'number', description: 'Max messages to retrieve (default 50, max 1000)' },
        oldest: { type: 'string', description: 'Only messages after this point — ISO date (2026-06-01), ISO datetime, or Slack ts (optional)' },
        latest: { type: 'string', description: 'Only messages before this point — same formats as oldest (optional)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call\'s next_cursor (optional)' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'slack_get_thread_replies',
    description: 'Get all replies of a Slack thread (thread replies do NOT appear in channel history). Pass the parent message ts as thread_ts.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (e.g. C... or D...)' },
        thread_ts: { type: 'string', description: 'Timestamp of the thread parent message' },
        limit: { type: 'number', description: 'Max messages to retrieve (default 100, max 1000)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call\'s next_cursor (optional)' },
      },
      required: ['channel', 'thread_ts'],
    },
  },
  {
    name: 'slack_remove_reaction',
    description: 'Remove an emoji reaction from a Slack message',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        timestamp: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['channel', 'timestamp', 'emoji'],
    },
  },
  {
    name: 'slack_get_user_info',
    description: 'Resolve Slack user IDs to real names (users.info). Pass one or more comma-separated user IDs; returns id, real_name, display_name (plus is_bot/deleted flags) per user. IDs that cannot be resolved come back with an error field — in that case show the raw <@ID> mention in your output and say the name could not be resolved. NEVER guess or invent a name.',
    inputSchema: {
      type: 'object',
      properties: {
        user_ids: { type: 'string', description: 'One or more Slack user IDs, comma-separated (e.g. "U02RY0M2L,U078XREKBNZ"). Max 100 per call.' },
      },
      required: ['user_ids'],
    },
  },
  {
    name: 'slack_post_message',
    description: 'Post a message to a Slack channel or DM',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (e.g. C... or D...)' },
        text: { type: 'string', description: 'Message text (supports mrkdwn)' },
        thread_ts: { type: 'string', description: 'Thread timestamp to reply in thread (optional)' },
      },
      required: ['channel', 'text'],
    },
  },
];

async function callTool(name: string, args: Record<string, string>): Promise<string> {
  switch (name) {
    case 'slack_add_reaction':
      return JSON.stringify(await slackApi('reactions.add', { channel: args.channel, timestamp: args.timestamp, name: args.emoji }), null, 2);
    case 'slack_get_messages': {
      const total = Math.min(Number(args.limit) || 50, 1000);
      const base: Record<string, string> = { channel: args.channel };
      if (args.oldest) base.oldest = toSlackTs(args.oldest);
      if (args.latest) base.latest = toSlackTs(args.latest);
      return fetchPaged('conversations.history', base, total, args.cursor);
    }
    case 'slack_get_thread_replies': {
      const total = Math.min(Number(args.limit) || 100, 1000);
      return fetchPaged('conversations.replies', { channel: args.channel, ts: args.thread_ts }, total, args.cursor);
    }
    case 'slack_remove_reaction':
      return JSON.stringify(await slackApi('reactions.remove', { channel: args.channel, timestamp: args.timestamp, name: args.emoji }), null, 2);
    case 'slack_get_user_info': {
      const ids = args.user_ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
      const users = [];
      for (const id of ids) {
        try {
          const data = await slackApiGet('users.info', { user: id }) as {
            user?: { name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string } };
          };
          const u = data.user || {};
          users.push({
            id,
            real_name: u.real_name || u.profile?.real_name || null,
            display_name: u.profile?.display_name || u.name || null,
            ...(u.is_bot ? { is_bot: true } : {}),
            ...(u.deleted ? { deleted: true } : {}),
          });
        } catch (err) {
          users.push({ id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return JSON.stringify({ users }, null, 2);
    }
    case 'slack_post_message': {
      const body: Record<string, string> = { channel: args.channel, text: args.text };
      if (args.thread_ts) body.thread_ts = args.thread_ts;
      return JSON.stringify(await slackApi('chat.postMessage', body), null, 2);
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
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slack-mcp', version: '1.0.0' } };
        break;
      case 'notifications/initialized': return;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'tools/call': {
        const p = params as { name: string; arguments: Record<string, string> };
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
