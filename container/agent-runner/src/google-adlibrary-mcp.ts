/**
 * Google Ads Transparency Center MCP Server for NanoClaw
 * Dependency-free — uses native https + crypto (Node 18+)
 * Key: /workspace/extra/patchbox/.mcp-secrets/<group>/google-adlibrary-key.json
 *
 * Read-only competitor ad intelligence. Source = the materialized DWH tables in
 * `bytehub-1337.grw_dwh_us` (Location US), NOT the public BigQuery dataset:
 *   - d_competitor_creative          (1 row / creative — curated competitor attrs)
 *   - f_competitor_creative_region   (1 row / creative × region — flattened, no UNNEST)
 *   - vw_competitor_overview         (per-competitor rollup)
 * The competitor universe is curated centrally (Google Sheet → allowlist → DWH);
 * aim only READS — it never maintains its own list and never writes these tables.
 * Queries run in Location US and are BILLED to the SA's project (botland-494015).
 *
 * Tools: google_adlibrary_search, google_adlibrary_overview
 */

import fs from 'fs';
import https from 'https';
import crypto from 'crypto';

const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';

interface SAKey { client_email: string; private_key: string; project_id: string; token_uri?: string; }

const KEY: SAKey | null = (() => {
  const raw = process.env.GOOGLE_ADLIBRARY_KEY
    || (() => { try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/google-adlibrary-key.json`, 'utf8'); } catch { return ''; } })();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
})();

// Materialized competitor DWH (bytehub-1337), Location US. region_stats is already
// flattened into f_competitor_creative_region — no UNNEST needed.
const DWH = 'bytehub-1337.grw_dwh_us';
const T_CREATIVE = `${DWH}.d_competitor_creative`;
const T_REGION = `${DWH}.f_competitor_creative_region`;
const V_OVERVIEW = `${DWH}.vw_competitor_overview`;
const QUERY_LOCATION = 'US';
// Cost guard: a single query may never bill more than ~50 GB scanned.
const MAX_BYTES_BILLED = String(50 * 1024 * 1024 * 1024);

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function httpsJson(opts: https.RequestOptions, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
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
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
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

// --- BigQuery query -------------------------------------------------------
interface QueryParam { name: string; parameterType: { type: string }; parameterValue: { value: string }; }

async function bqQuery(sql: string, params: QueryParam[]): Promise<any> {
  if (!KEY) throw new Error('No Google service-account key configured.');
  const token = await getAccessToken();
  const body = JSON.stringify({
    query: sql,
    useLegacySql: false,
    // The DWH tables live in US — pin the job location so it never routes to EU.
    location: QUERY_LOCATION,
    parameterMode: 'NAMED',
    queryParameters: params,
    maximumBytesBilled: MAX_BYTES_BILLED,
    timeoutMs: 55000,
    maxResults: 1000,
  });
  const base = {
    hostname: 'bigquery.googleapis.com',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) },
  };
  let res = await httpsJson({ ...base, path: `/bigquery/v2/projects/${KEY.project_id}/queries`, method: 'POST' }, body);

  // Poll if the job didn't finish within timeoutMs.
  const jobId = res.jobReference?.jobId;
  const loc = res.jobReference?.location || QUERY_LOCATION;
  let tries = 0;
  while (!res.jobComplete && jobId && tries < 10) {
    tries++;
    await new Promise((r) => setTimeout(r, 2000));
    const locQ = loc ? `&location=${encodeURIComponent(loc)}` : '';
    res = await httpsJson({
      hostname: 'bigquery.googleapis.com',
      path: `/bigquery/v2/projects/${KEY.project_id}/queries/${jobId}?timeoutMs=30000${locQ}`,
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!res.jobComplete) throw new Error('BigQuery job did not complete in time.');
  return res;
}

// BigQuery returns rows as {f:[{v}, ...]} aligned with schema.fields. Flatten.
function shapeRows(res: any): Record<string, unknown>[] {
  const fields: { name: string }[] = res.schema?.fields || [];
  const rows: { f: { v: unknown }[] }[] = res.rows || [];
  return rows.map((row) => {
    const o: Record<string, unknown> = {};
    fields.forEach((fld, i) => { o[fld.name] = row.f[i]?.v ?? null; });
    return o;
  });
}

const TOOLS = [
  {
    name: 'google_adlibrary_search',
    description: 'Search the curated competitor ad set (materialized from the Google Ads Transparency Center into the bytehub DWH) for individual creatives. Returns one row per creative+region with the curated competitor/produkt/priority labels, advertiser identity, creative URL, ad format, the served region, first/last-shown dates (longevity) and a times-shown range (reach proxy). The competitor universe is curated centrally — only tracked competitors are present, so all filters are optional; with none given it returns the most recently shown creatives across all tracked competitors. Filter by competitor (curated name), advertiser_name (disclosed), advertiser_id, produkt, region_code or ad_format_type.',
    inputSchema: {
      type: 'object',
      properties: {
        competitor: { type: 'string', description: 'Curated competitor name to match (case-insensitive substring), as maintained in the allowlist.' },
        produkt: { type: 'string', description: 'Curated product label to match (case-insensitive substring).' },
        advertiser_name: { type: 'string', description: 'Disclosed advertiser / brand name to match (case-insensitive substring).' },
        advertiser_id: { type: 'string', description: 'Exact Google advertiser ID to pull all ads of one advertiser.' },
        region_code: { type: 'string', description: 'ISO country code the ad was served in (e.g. "DE"). Omit to return all served regions.' },
        ad_format_type: { type: 'string', description: 'Restrict to a creative format (exact match, e.g. TEXT / IMAGE / VIDEO).' },
        priority: { type: 'string', description: 'Restrict to a curated priority tier (exact match).' },
        active_since: { type: 'string', description: 'Only creatives last shown on or after this date (YYYY-MM-DD). Use to focus on currently/recently running ads.' },
        limit: { type: 'number', description: 'Max rows to return (default 25, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'google_adlibrary_overview',
    description: 'Per-competitor rollup from the curated competitor DWH (vw_competitor_overview): for each competitor/produkt it returns the number of advertisers, creatives and regions plus the overall first/last-shown dates and the data last-refresh timestamp. Use for a quick landscape view before drilling into individual creatives with google_adlibrary_search. All filters optional.',
    inputSchema: {
      type: 'object',
      properties: {
        competitor: { type: 'string', description: 'Curated competitor name to match (case-insensitive substring).' },
        priority: { type: 'string', description: 'Restrict to a curated priority tier (exact match).' },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 200).' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'google_adlibrary_search': {
      const rawLimit = typeof args.limit === 'number' ? args.limit : 25;
      const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 100);

      const where: string[] = [];
      const params: QueryParam[] = [
        { name: 'lim', parameterType: { type: 'INT64' }, parameterValue: { value: String(limit) } },
      ];
      const addLike = (col: string, pname: string, val: string) => {
        where.push(`LOWER(${col}) LIKE @${pname}`);
        params.push({ name: pname, parameterType: { type: 'STRING' }, parameterValue: { value: `%${val.toLowerCase()}%` } });
      };
      const addEq = (col: string, pname: string, val: string, type = 'STRING') => {
        where.push(`${col} = @${pname}`);
        params.push({ name: pname, parameterType: { type }, parameterValue: { value: val } });
      };

      if (typeof args.competitor === 'string' && args.competitor.trim()) addLike('d.competitor', 'comp', args.competitor.trim());
      if (typeof args.produkt === 'string' && args.produkt.trim()) addLike('d.produkt', 'prod', args.produkt.trim());
      if (typeof args.advertiser_name === 'string' && args.advertiser_name.trim()) addLike('d.advertiser_disclosed_name', 'name', args.advertiser_name.trim());
      if (typeof args.advertiser_id === 'string' && args.advertiser_id.trim()) addEq('d.advertiser_id', 'advid', args.advertiser_id.trim());
      if (typeof args.region_code === 'string' && args.region_code.trim()) addEq('f.region_code', 'region', args.region_code.trim().toUpperCase());
      if (typeof args.ad_format_type === 'string' && args.ad_format_type.trim()) addEq('d.ad_format_type', 'fmt', args.ad_format_type.trim().toUpperCase());
      if (typeof args.priority === 'string' && args.priority.trim()) addEq('d.priority', 'prio', args.priority.trim());
      if (typeof args.active_since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.active_since)) {
        where.push('f.last_shown >= @since');
        params.push({ name: 'since', parameterType: { type: 'DATE' }, parameterValue: { value: args.active_since } });
      }

      const sql = `
        SELECT
          d.competitor, d.produkt, d.priority,
          d.advertiser_id, d.advertiser_disclosed_name, d.advertiser_legal_name, d.advertiser_location,
          d.creative_id, d.creative_page_url, d.ad_format_type, d.topic,
          f.region_code, f.first_shown, f.last_shown,
          f.times_shown_lower_bound, f.times_shown_upper_bound
        FROM \`${T_CREATIVE}\` d
        JOIN \`${T_REGION}\` f USING (advertiser_id, creative_id)
        ${where.length ? `WHERE ${where.join('\n          AND ')}` : ''}
        ORDER BY f.last_shown DESC
        LIMIT @lim`;

      const res = await bqQuery(sql, params);
      const rows = shapeRows(res);
      return JSON.stringify({
        total_rows: rows.length,
        bytes_processed: res.totalBytesProcessed || null,
        ads: rows,
      }, null, 2);
    }
    case 'google_adlibrary_overview': {
      const rawLimit = typeof args.limit === 'number' ? args.limit : 50;
      const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 200);

      const where: string[] = [];
      const params: QueryParam[] = [
        { name: 'lim', parameterType: { type: 'INT64' }, parameterValue: { value: String(limit) } },
      ];
      if (typeof args.competitor === 'string' && args.competitor.trim()) {
        where.push('LOWER(competitor) LIKE @comp');
        params.push({ name: 'comp', parameterType: { type: 'STRING' }, parameterValue: { value: `%${args.competitor.trim().toLowerCase()}%` } });
      }
      if (typeof args.priority === 'string' && args.priority.trim()) {
        where.push('priority = @prio');
        params.push({ name: 'prio', parameterType: { type: 'STRING' }, parameterValue: { value: args.priority.trim() } });
      }

      const sql = `
        SELECT produkt, competitor, priority, advertisers, creatives, regions,
               first_shown, last_shown,
               FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', last_refresh, 'UTC') AS last_refresh
        FROM \`${V_OVERVIEW}\`
        ${where.length ? `WHERE ${where.join('\n          AND ')}` : ''}
        ORDER BY last_shown DESC
        LIMIT @lim`;

      const res = await bqQuery(sql, params);
      const rows = shapeRows(res);
      return JSON.stringify({
        total_rows: rows.length,
        bytes_processed: res.totalBytesProcessed || null,
        competitors: rows,
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
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'google-adlibrary-mcp', version: '2.0.0' } };
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
