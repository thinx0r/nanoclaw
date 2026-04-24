/**
 * ClickUp MCP Server for NanoClaw
 * Dependency-free — uses native fetch (Node 18+)
 * Tools: get_task, get_task_comments, post_comment, list_tasks
 */

const BASE = 'https://api.clickup.com/api/v2';
import fs from 'fs';
const _GROUP_CU = process.env.NANOCLAW_GROUP_FOLDER || '';
const TOKEN = process.env.CLICKUP_TOKEN || (() => { try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP_CU}/clickup-token`,'utf8').trim(); } catch { return ''; } })();

async function cu(path: string, opts: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${text}`);
  return JSON.parse(text);
}

const TOOLS = [
  {
    name: 'clickup_get_task',
    description: 'Get full details of a ClickUp task including description and status',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'clickup_get_task_comments',
    description: 'Get all comments on a ClickUp task',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'clickup_post_comment',
    description: 'Post a comment on a ClickUp task',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, comment_text: { type: 'string' } },
      required: ['task_id', 'comment_text'],
    },
  },
  {
    name: 'clickup_list_tasks',
    description: 'List tasks in a ClickUp list, optionally filtered by status',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by status names e.g. ["open","in progress"]' },
        page: { type: 'number' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'clickup_create_task',
    description: 'Create a new task in a ClickUp list',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'ID of the list to create the task in' },
        name: { type: 'string', description: 'Task name' },
        description: { type: 'string', description: 'Task description (optional)' },
        status: { type: 'string', description: 'Task status (optional)' },
        priority: { type: 'number', description: '1=urgent, 2=high, 3=normal, 4=low (optional)' },
      },
      required: ['list_id', 'name'],
    },
  },
  {
    name: 'clickup_update_task',
    description: 'Update an existing ClickUp task — name, description, status or priority',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'number', description: '1=urgent, 2=high, 3=normal, 4=low' },
      },
      required: ['task_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'clickup_get_task':
      return JSON.stringify(await cu(`/task/${args.task_id}`), null, 2);
    case 'clickup_get_task_comments':
      return JSON.stringify(await cu(`/task/${args.task_id}/comment`), null, 2);
    case 'clickup_post_comment': {
      const result = await cu(`/task/${args.task_id}/comment`, {
        method: 'POST',
        body: JSON.stringify({ comment_text: args.comment_text }),
      });
      return JSON.stringify(result, null, 2);
    }
    case 'clickup_list_tasks': {
      const params = new URLSearchParams({ page: String(args.page || 0) });
      if (Array.isArray(args.statuses)) {
        (args.statuses as string[]).forEach(s => params.append('statuses[]', s));
      }
      return JSON.stringify(await cu(`/list/${args.list_id}/task?${params}`), null, 2);
    }
    case 'clickup_create_task': {
      const body: Record<string, unknown> = { name: args.name };
      if (args.description) body.description = args.description;
      if (args.status) body.status = args.status;
      if (args.priority) body.priority = args.priority;
      return JSON.stringify(await cu(`/list/${args.list_id}/task`, {
        method: 'POST',
        body: JSON.stringify(body),
      }), null, 2);
    }
    case 'clickup_update_task': {
      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      if (args.description) body.description = args.description;
      if (args.status) body.status = args.status;
      if (args.priority !== undefined) body.priority = args.priority;
      return JSON.stringify(await cu(`/task/${args.task_id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }), null, 2);
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
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'clickup-mcp', version: '1.0.0' } };
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
