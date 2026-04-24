/**
 * OpenAI MCP Server for NanoClaw
 * Dependency-free — uses native https (Node 18+)
 * Tools: dalle_generate_image
 */

import fs from 'fs';
import https from 'https';
import path from 'path';

const _GROUP = process.env.NANOCLAW_GROUP_FOLDER || '';
const TOKEN = process.env.OPENAI_API_KEY || (() => {
  try { return fs.readFileSync(`/workspace/extra/patchbox/.mcp-secrets/${_GROUP}/openai-token`, 'utf8').trim(); } catch { return ''; }
})();

async function httpsPost(hostname: string, p: string, headers: Record<string, string>, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: p, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function httpsGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function dalleGenerate(prompt: string, outputPath: string, size: string = '1024x1024', model: string = 'dall-e-3'): Promise<string> {
  const response_format = model === 'dall-e-3' ? { response_format: 'b64_json' } : {};
  const body = JSON.stringify({ model, prompt, n: 1, size, ...response_format });
  const response = await httpsPost(
    'api.openai.com', '/v1/images/generations',
    { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body
  ) as { error?: { message: string }; data?: Array<{ b64_json: string }> };

  if (response.error) throw new Error(response.error.message);
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data in response');

  const imageData = Buffer.from(b64, 'base64');
  const dir = path.dirname(outputPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, imageData);
  return `Image saved to ${outputPath} (${imageData.length} bytes)`;
}

const TOOLS = [
  {
    name: 'dalle_generate_image',
    description: 'Generate an image using DALL-E 3 and save it to a file path',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image description / prompt' },
        output_path: { type: 'string', description: 'Absolute file path where the image will be saved (e.g. /workspace/extra/web/images/banner.png)' },
        size: { type: 'string', description: 'Image size. dall-e-3: 1024x1024, 1792x1024, 1024x1792. gpt-image-2: 1024x1024, 1536x1024, 1024x1536', enum: ['1024x1024', '1792x1024', '1024x1792', '1536x1024', '1024x1536'] },
        model: { type: 'string', description: 'Model to use (default: dall-e-3)', enum: ['dall-e-3', 'gpt-image-2'] },
      },
      required: ['prompt', 'output_path'],
    },
  },
];

async function callTool(name: string, args: Record<string, string>): Promise<string> {
  switch (name) {
    case 'dalle_generate_image':
      return await dalleGenerate(args.prompt, args.output_path, args.size, args.model);
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
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'openai-mcp', version: '1.0.0' } };
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
