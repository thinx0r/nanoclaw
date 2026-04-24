/**
 * Meta Marketing API MCP Server for NanoClaw
 * Dependency-free — uses native https (Node 18+)
 * Token: /workspace/extra/patchbox/.mcp-secrets/<group>/meta-ads-token
 *
 * Read tools: meta_get_ad_accounts, meta_get_campaigns, meta_get_adsets,
 *             meta_get_ads, meta_get_insights
 * Write tools (require Alex approval before use): meta_create_campaign,
 *             meta_update_campaign
 */

import fs from 'fs';
import https from 'https';

const API_VERSION = 'v21.0';
const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';
const TOKEN = (() => {
  if (process.env.META_ADS_TOKEN) return process.env.META_ADS_TOKEN;
  try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/meta-ads-token`, 'utf8').trim(); } catch { return ''; }
})();

async function api(endpoint: string, method = 'GET', body?: Record<string, unknown>): Promise<unknown> {
  const sep = endpoint.includes('?') ? '&' : '?';
  const path = `/${API_VERSION}${endpoint}${sep}access_token=${TOKEN}`;
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const req = https.request(
      { hostname: 'graph.facebook.com', path, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.error) reject(new Error(`Meta API ${parsed.error.code}: ${parsed.error.message}`));
            else resolve(parsed);
          } catch { reject(new Error(`Non-JSON response: ${d.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'meta_get_ad_accounts',
    description: 'List all Meta ad accounts the system user has access to, with account IDs and names',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'meta_get_campaigns',
    description: 'List campaigns for a Meta ad account with status, objective, and daily/lifetime budget',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Ad account ID (e.g. act_123456789)' },
        status_filter: { type: 'string', description: 'Filter by status: ACTIVE, PAUSED, ARCHIVED, ALL (default: ALL)', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'ALL'] },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'meta_get_adsets',
    description: 'List ad sets for a campaign or account with targeting, budget, and status',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Ad account ID (e.g. act_123456789)' },
        campaign_id: { type: 'string', description: 'Filter by campaign ID (optional)' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'meta_get_ads',
    description: 'List individual ads with creative details and status',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Ad account ID (e.g. act_123456789)' },
        adset_id: { type: 'string', description: 'Filter by ad set ID (optional)' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'meta_get_insights',
    description: 'Get performance metrics (impressions, clicks, spend, ROAS, CTR, CPM, CPC, reach) for account, campaign, adset, or ad level',
    inputSchema: {
      type: 'object',
      properties: {
        object_id: { type: 'string', description: 'Account ID (act_X), campaign ID, adset ID, or ad ID' },
        level: { type: 'string', description: 'Aggregation level: account, campaign, adset, ad', enum: ['account', 'campaign', 'adset', 'ad'] },
        date_preset: { type: 'string', description: 'Date range preset (default: last_30d)', enum: ['today', 'yesterday', 'last_3d', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month', 'last_quarter'] },
        time_increment: { type: 'number', description: 'Break down by N days (1=daily, 7=weekly, omit for total)' },
      },
      required: ['object_id', 'level'],
    },
  },
  {
    name: 'meta_create_campaign',
    description: 'Create a new Meta ad campaign. REQUIRES explicit Alex approval before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Ad account ID (e.g. act_123456789)' },
        name: { type: 'string', description: 'Campaign name' },
        objective: { type: 'string', description: 'Campaign objective', enum: ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION'] },
        status: { type: 'string', description: 'Initial status (default: PAUSED for safety)', enum: ['ACTIVE', 'PAUSED'] },
        daily_budget: { type: 'number', description: 'Daily budget in account currency cents (e.g. 1000 = €10.00)' },
        lifetime_budget: { type: 'number', description: 'Lifetime budget in account currency cents (mutually exclusive with daily_budget)' },
        special_ad_categories: { type: 'array', items: { type: 'string' }, description: 'Required if campaign is for housing, employment, credit, or social issues. Pass [] if none.' },
      },
      required: ['account_id', 'name', 'objective', 'special_ad_categories'],
    },
  },
  {
    name: 'meta_update_campaign',
    description: 'Update an existing campaign — change name, status, or budget. REQUIRES explicit Alex approval before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID to update' },
        name: { type: 'string', description: 'New campaign name (optional)' },
        status: { type: 'string', description: 'New status (optional)', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'] },
        daily_budget: { type: 'number', description: 'New daily budget in cents (optional)' },
        lifetime_budget: { type: 'number', description: 'New lifetime budget in cents (optional)' },
      },
      required: ['campaign_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'meta_get_ad_accounts': {
      const data = await api('/me/adaccounts?fields=id,name,account_status,currency,timezone_name,spend_cap,amount_spent');
      return JSON.stringify(data, null, 2);
    }
    case 'meta_get_campaigns': {
      const statusFilter = args.status_filter === 'ALL' || !args.status_filter ? '' : `&effective_status=["${args.status_filter}"]`;
      const data = await api(`/${args.account_id}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time${statusFilter}`);
      return JSON.stringify(data, null, 2);
    }
    case 'meta_get_adsets': {
      const campaignFilter = args.campaign_id ? `&campaign_id=${args.campaign_id}` : '';
      const data = await api(`/${args.account_id}/adsets?fields=id,name,status,campaign_id,daily_budget,lifetime_budget,billing_event,optimization_goal,targeting,start_time,end_time${campaignFilter}`);
      return JSON.stringify(data, null, 2);
    }
    case 'meta_get_ads': {
      const adsetFilter = args.adset_id ? `&adset_id=${args.adset_id}` : '';
      const data = await api(`/${args.account_id}/ads?fields=id,name,status,adset_id,campaign_id,creative{id,name,thumbnail_url},created_time${adsetFilter}`);
      return JSON.stringify(data, null, 2);
    }
    case 'meta_get_insights': {
      const preset = args.date_preset || 'last_30d';
      const fields = 'impressions,clicks,spend,reach,ctr,cpm,cpc,cpp,actions,action_values,purchase_roas,frequency,unique_clicks,cost_per_unique_click';
      const increment = args.time_increment ? `&time_increment=${args.time_increment}` : '';
      const data = await api(`/${args.object_id}/insights?fields=${fields}&date_preset=${preset}&level=${args.level}${increment}`);
      return JSON.stringify(data, null, 2);
    }
    case 'meta_create_campaign': {
      const body: Record<string, unknown> = {
        name: args.name,
        objective: args.objective,
        status: args.status || 'PAUSED',
        special_ad_categories: args.special_ad_categories || [],
      };
      if (args.daily_budget) body.daily_budget = args.daily_budget;
      if (args.lifetime_budget) body.lifetime_budget = args.lifetime_budget;
      const data = await api(`/${args.account_id}/campaigns`, 'POST', body);
      return JSON.stringify(data, null, 2);
    }
    case 'meta_update_campaign': {
      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      if (args.status) body.status = args.status;
      if (args.daily_budget) body.daily_budget = args.daily_budget;
      if (args.lifetime_budget) body.lifetime_budget = args.lifetime_budget;
      const data = await api(`/${args.campaign_id}`, 'POST', body);
      return JSON.stringify(data, null, 2);
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
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'meta-ads-mcp', version: '1.0.0' } };
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
