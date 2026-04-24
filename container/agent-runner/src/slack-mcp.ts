/**
 * Slack MCP Server for NanoClaw
 * Dependency-free — uses native fetch (Node 18+)
 * Tools: add_reaction, remove_reaction
 */

import fs from 'fs';
const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';
const TOKEN = process.env.SLACK_BOT_TOKEN || (() => { try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/slack-token`,'utf8').trim(); } catch { return ''; } })();

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
    description: 'Get recent messages from a Slack channel or DM, including timestamps for reactions',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (e.g. C... or D...)' },
        limit: { type: 'number', description: 'Number of messages to retrieve (default 10, max 50)' },
      },
      required: ['channel'],
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
      const limit = Math.min(Number(args.limit) || 10, 50);
      return JSON.stringify(await slackApi('conversations.history', { channel: args.channel, limit: String(limit) }), null, 2);
    }
    case 'slack_remove_reaction':
      return JSON.stringify(await slackApi('reactions.remove', { channel: args.channel, timestamp: args.timestamp, name: args.emoji }), null, 2);
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
