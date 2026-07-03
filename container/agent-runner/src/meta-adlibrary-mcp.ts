/**
 * Meta Ad Library API MCP Server for NanoClaw
 * Dependency-free — uses native https (Node 18+)
 * Token: /workspace/extra/patchbox/.mcp-secrets/<group>/meta-adlibrary-token
 *
 * Read-only — competitor ad intelligence via the public Ad Library (/ads_archive).
 * Requires a USER access token from an account that completed Meta identity
 * confirmation (facebook.com/ID) + the steps at facebook.com/ads/library/api.
 *
 * Tool: meta_adlibrary_search
 */

import fs from 'fs';
import https from 'https';

const API_VERSION = 'v21.0';
const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';
const TOKEN = (() => {
  if (process.env.META_ADLIBRARY_TOKEN) return process.env.META_ADLIBRARY_TOKEN;
  try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/meta-adlibrary-token`, 'utf8').trim(); } catch { return ''; }
})();

// Sensible default field set for commercial competitor ads. (impressions/spend/
// demographics are only populated for political & issue ads, so they are omitted.)
const DEFAULT_FIELDS = [
  'id', 'page_id', 'page_name',
  'ad_creative_bodies', 'ad_creative_link_titles', 'ad_creative_link_descriptions', 'ad_creative_link_captions',
  'ad_snapshot_url', 'ad_delivery_start_time', 'ad_delivery_stop_time',
  'publisher_platforms', 'languages', 'currency',
].join(',');

function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const val = Array.isArray(v) ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${encodeURIComponent(val)}`);
  }
  return parts.join('&');
}

async function api(endpoint: string): Promise<unknown> {
  const sep = endpoint.includes('?') ? '&' : '?';
  const path = `/${API_VERSION}${endpoint}${sep}access_token=${TOKEN}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'graph.facebook.com', path, method: 'GET' },
      (res) => {
        let d = '';
        res.on('data', (c) => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.error) reject(new Error(`Meta Ad Library API ${parsed.error.code}: ${parsed.error.message}`));
            else resolve(parsed);
          } catch { reject(new Error(`Non-JSON response: ${d.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'meta_adlibrary_search',
    description: 'Search the public Meta/Facebook Ad Library for competitor ads. Returns live and past ads with creative text, snapshot URL, run dates and platforms. Provide search_terms (keyword/brand) and/or search_page_ids (specific advertiser pages). Commercial ads are only returned for the countries they were actually served in — keep ad_reached_countries set to the markets you care about (default ["DE"]).',
    inputSchema: {
      type: 'object',
      properties: {
        search_terms: { type: 'string', description: 'Keyword / brand / phrase to search ad text for (e.g. a competitor name or product). Optional if search_page_ids is given.' },
        search_page_ids: { type: 'array', items: { type: 'string' }, description: 'Specific advertiser Page IDs to restrict the search to (optional). Use the page_id from a previous result to pull all ads of one competitor.' },
        ad_reached_countries: { type: 'array', items: { type: 'string' }, description: 'ISO country codes the ads reached (default ["DE"]). Commercial ads only appear for the countries they were served in.' },
        ad_type: { type: 'string', description: 'Ad category (default ALL). ALL = commercial + political; the other values narrow to a regulated category.', enum: ['ALL', 'POLITICAL_AND_ISSUE_ADS', 'EMPLOYMENT_ADS', 'HOUSING_ADS', 'FINANCIAL_PRODUCTS_AND_SERVICES_ADS'] },
        ad_active_status: { type: 'string', description: 'Filter by run status (default ALL).', enum: ['ALL', 'ACTIVE', 'INACTIVE'] },
        publisher_platforms: { type: 'array', items: { type: 'string', enum: ['FACEBOOK', 'INSTAGRAM', 'AUDIENCE_NETWORK', 'MESSENGER', 'WHATSAPP', 'THREADS'] }, description: 'Restrict to specific platforms (optional).' },
        media_type: { type: 'string', description: 'Restrict to a creative media type (optional).', enum: ['ALL', 'IMAGE', 'MEME', 'VIDEO', 'NONE'] },
        limit: { type: 'number', description: 'Max ads to return per page (default 25, max 100).' },
        after: { type: 'string', description: 'Pagination cursor (paging.cursors.after from a previous response) to fetch the next page.' },
        fields: { type: 'string', description: 'Comma-separated field override (optional). Defaults to a competitor-analysis field set.' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'meta_adlibrary_search': {
      if (!args.search_terms && !(Array.isArray(args.search_page_ids) && args.search_page_ids.length)) {
        throw new Error('Provide at least search_terms or search_page_ids.');
      }
      const rawLimit = typeof args.limit === 'number' ? args.limit : 25;
      const query = buildQuery({
        search_terms: args.search_terms,
        search_page_ids: args.search_page_ids,
        ad_reached_countries: (Array.isArray(args.ad_reached_countries) && args.ad_reached_countries.length) ? args.ad_reached_countries : ['DE'],
        ad_type: args.ad_type || 'ALL',
        ad_active_status: args.ad_active_status || 'ALL',
        publisher_platforms: args.publisher_platforms,
        media_type: args.media_type,
        limit: Math.min(Math.max(1, rawLimit), 100),
        after: args.after,
        fields: args.fields || DEFAULT_FIELDS,
      });
      const data = await api(`/ads_archive?${query}`);
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
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'meta-adlibrary-mcp', version: '1.0.0' } };
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
