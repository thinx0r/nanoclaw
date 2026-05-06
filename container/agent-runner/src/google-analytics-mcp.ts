/**
 * Google Analytics Data API (GA4) + Search Console MCP Server for NanoClaw
 * Dependency-free — uses native https (Node 18+) with JWT auth
 * Credentials: /workspace/extra/patchbox/.mcp-secrets/<group>/ga-service-account.json
 *
 * Tools: ga_run_report, ga_get_realtime, ga_list_dimensions_metrics,
 *        sc_run_report, sc_list_sites
 */

import fs from 'fs';
import https from 'https';
import crypto from 'crypto';

const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';
const DEFAULT_PROPERTY_ID = '311848504';
// Known properties: 311848504 = patchbox.com, 534365651 = patchdocs.io

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

function loadServiceAccount(): ServiceAccount {
  const envKey = process.env.GA_SERVICE_ACCOUNT_JSON;
  if (envKey) return JSON.parse(envKey);
  const path = `/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/ga-service-account.json`;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`GA service account not found at ${path}`);
  }
}

function base64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken(): Promise<string> {
  const sa = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = base64url(sign.sign(sa.private_key));
  const jwt = `${sigInput}.${signature}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.access_token) resolve(parsed.access_token);
            else reject(new Error(`Token error: ${d.slice(0, 300)}`));
          } catch {
            reject(new Error(`Non-JSON token response: ${d.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function gaPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const token = await getAccessToken();
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'analyticsdata.googleapis.com',
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.error) reject(new Error(`GA API ${parsed.error.code}: ${parsed.error.message}`));
            else resolve(parsed);
          } catch {
            reject(new Error(`Non-JSON response: ${d.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function gaGet(path: string): Promise<unknown> {
  const token = await getAccessToken();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'analyticsdata.googleapis.com',
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.error) reject(new Error(`GA API ${parsed.error.code}: ${parsed.error.message}`));
            else resolve(parsed);
          } catch {
            reject(new Error(`Non-JSON response: ${d.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function scRequest(hostname: string, path: string, method = 'GET', body?: Record<string, unknown>): Promise<unknown> {
  const token = await getAccessToken();
  const bodyStr = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) reject(new Error(`Search Console API ${parsed.error.code}: ${parsed.error.message}`));
          else resolve(parsed);
        } catch {
          reject(new Error(`Non-JSON response: ${d.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'ga_run_report',
    description: 'Run a GA4 analytics report. Returns dimensions and metrics for the given property and date range.',
    inputSchema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: `GA4 property ID. Known: 311848504 = patchbox.com (default), 534365651 = patchdocs.io` },
        date_ranges: {
          type: 'array',
          description: 'Date ranges, e.g. [{"startDate":"30daysAgo","endDate":"today"}]',
          items: {
            type: 'object',
            properties: {
              startDate: { type: 'string', description: 'e.g. 30daysAgo, 2024-01-01' },
              endDate: { type: 'string', description: 'e.g. today, 2024-01-31' },
            },
            required: ['startDate', 'endDate'],
          },
        },
        dimensions: {
          type: 'array',
          description: 'Dimensions to break down by, e.g. ["date","pagePath","country","deviceCategory","sessionSource"]',
          items: { type: 'string' },
        },
        metrics: {
          type: 'array',
          description: 'Metrics to fetch, e.g. ["sessions","activeUsers","pageviews","bounceRate","averageSessionDuration","newUsers","engagementRate"]',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Max rows to return (default: 50, max: 250)' },
        order_by_metric: { type: 'string', description: 'Order results by this metric descending (optional)' },
      },
      required: ['dimensions', 'metrics'],
    },
  },
  {
    name: 'ga_get_realtime',
    description: 'Get real-time GA4 data — active users right now, broken down by page or country.',
    inputSchema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: `GA4 property ID. Known: 311848504 = patchbox.com (default), 534365651 = patchdocs.io` },
        dimensions: {
          type: 'array',
          description: 'Dimensions, e.g. ["unifiedScreenName","country","deviceCategory"]',
          items: { type: 'string' },
        },
        metrics: {
          type: 'array',
          description: 'Metrics, e.g. ["activeUsers"] (default)',
          items: { type: 'string' },
        },
      },
      required: [],
    },
  },
  {
    name: 'ga_list_dimensions_metrics',
    description: 'List all available GA4 dimensions and metrics for a property (useful for discovering what data is available).',
    inputSchema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: `GA4 property ID. Known: 311848504 = patchbox.com (default), 534365651 = patchdocs.io` },
      },
      required: [],
    },
  },
  {
    name: 'sc_run_report',
    description: 'Query Google Search Console search analytics — clicks, impressions, CTR, and average position for a site. Supports breakdown by query, page, country, device, date.',
    inputSchema: {
      type: 'object',
      properties: {
        site_url: {
          type: 'string',
          description: 'Site URL exactly as registered in Search Console, e.g. "sc-domain:patchbox.com" or "https://patchdocs.io/"',
        },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: 28 days ago)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
        dimensions: {
          type: 'array',
          description: 'Break down by: query, page, country, device, date (e.g. ["query"] for top search terms)',
          items: { type: 'string', enum: ['query', 'page', 'country', 'device', 'date'] },
        },
        row_limit: { type: 'number', description: 'Max rows (default: 50, max: 25000)' },
        dimension_filter_query: { type: 'string', description: 'Filter results to rows where "query" contains this string (optional)' },
        dimension_filter_page: { type: 'string', description: 'Filter results to rows where "page" contains this string (optional)' },
      },
      required: ['site_url'],
    },
  },
  {
    name: 'sc_list_sites',
    description: 'List all sites registered in Google Search Console that the service account can access.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

function formatReport(data: Record<string, unknown>): string {
  const dimHeaders = ((data.dimensionHeaders || []) as { name: string }[]).map((h) => h.name);
  const metHeaders = ((data.metricHeaders || []) as { name: string }[]).map((h) => h.name);
  const rows = (data.rows || []) as { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];

  if (rows.length === 0) return 'No data returned for this query.';

  const result: Record<string, string>[] = rows.map((row) => {
    const obj: Record<string, string> = {};
    dimHeaders.forEach((h, i) => { obj[h] = row.dimensionValues[i]?.value ?? ''; });
    metHeaders.forEach((h, i) => { obj[h] = row.metricValues[i]?.value ?? ''; });
    return obj;
  });

  return JSON.stringify({ rowCount: data.rowCount || rows.length, rows: result }, null, 2);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const propertyId = (args.property_id as string) || DEFAULT_PROPERTY_ID;

  switch (name) {
    case 'ga_run_report': {
      const body: Record<string, unknown> = {
        dateRanges: args.date_ranges || [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: ((args.dimensions as string[]) || []).map((n) => ({ name: n })),
        metrics: ((args.metrics as string[]) || []).map((n) => ({ name: n })),
        limit: Math.min((args.limit as number) || 50, 250),
      };
      if (args.order_by_metric) {
        body.orderBys = [{ metric: { metricName: args.order_by_metric }, desc: true }];
      }
      const data = await gaPost(`/v1beta/properties/${propertyId}:runReport`, body);
      return formatReport(data as Record<string, unknown>);
    }
    case 'ga_get_realtime': {
      const body = {
        dimensions: ((args.dimensions as string[]) || ['unifiedScreenName']).map((n) => ({ name: n })),
        metrics: ((args.metrics as string[]) || ['activeUsers']).map((n) => ({ name: n })),
      };
      const data = await gaPost(`/v1beta/properties/${propertyId}:runRealtimeReport`, body);
      return formatReport(data as Record<string, unknown>);
    }
    case 'ga_list_dimensions_metrics': {
      const data = await gaGet(`/v1beta/properties/${propertyId}/metadata`);
      const d = data as { dimensions?: { apiName: string; uiName: string }[]; metrics?: { apiName: string; uiName: string }[] };
      const dims = (d.dimensions || []).map((x) => ({ apiName: x.apiName, uiName: x.uiName }));
      const mets = (d.metrics || []).map((x) => ({ apiName: x.apiName, uiName: x.uiName }));
      return JSON.stringify({ dimensions: dims, metrics: mets }, null, 2);
    }
    case 'sc_run_report': {
      const siteUrl = args.site_url as string;
      const encodedSite = encodeURIComponent(siteUrl);
      const today = new Date().toISOString().split('T')[0];
      const daysAgo28 = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];
      const body: Record<string, unknown> = {
        startDate: (args.start_date as string) || daysAgo28,
        endDate: (args.end_date as string) || today,
        dimensions: (args.dimensions as string[]) || ['query'],
        rowLimit: Math.min((args.row_limit as number) || 50, 25000),
      };
      const filters: { dimension: string; operator: string; expression: string }[] = [];
      if (args.dimension_filter_query) filters.push({ dimension: 'query', operator: 'includesIgnoringCase', expression: args.dimension_filter_query as string });
      if (args.dimension_filter_page) filters.push({ dimension: 'page', operator: 'includesIgnoringCase', expression: args.dimension_filter_page as string });
      if (filters.length > 0) body.dimensionFilterGroups = [{ filters }];
      const data = await scRequest('searchconsole.googleapis.com', `/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`, 'POST', body);
      const d = data as { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] };
      if (!d.rows || d.rows.length === 0) return 'No data found for this query.';
      const dims = (args.dimensions as string[]) || ['query'];
      const rows = d.rows.map((r) => {
        const obj: Record<string, string | number> = {};
        dims.forEach((dim, i) => { obj[dim] = r.keys[i]; });
        obj.clicks = r.clicks;
        obj.impressions = r.impressions;
        obj.ctr = Math.round(r.ctr * 10000) / 100;
        obj.position = Math.round(r.position * 10) / 10;
        return obj;
      });
      return JSON.stringify({ rowCount: rows.length, rows }, null, 2);
    }
    case 'sc_list_sites': {
      const data = await scRequest('searchconsole.googleapis.com', '/webmasters/v3/sites');
      const d = data as { siteEntry?: { siteUrl: string; permissionLevel: string }[] };
      return JSON.stringify(d.siteEntry || [], null, 2);
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
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'google-analytics-mcp', version: '1.0.0' } };
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
