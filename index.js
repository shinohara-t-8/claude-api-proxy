const http = require('http');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const secretClient = new SecretManagerServiceClient();
const PORT = Number(process.env.PORT) || 8080;
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || 't8studio-infra-jp';

/**
 * ツールID → Secret Manager のシークレット名
 * 環境変数 TOOL_SECRET_MAP があれば JSON で上書き可能
 * 例: {"altplus":"claude-api-key-altplus","design-search":"claude-api-key-design-search"}
 */
const DEFAULT_TOOL_SECRET_MAP = {
  altplus: 'claude-api-key-altplus',
  'design-search': 'claude-api-key-design-search',
  syomen: 'claude-api-key-syomen',
};

function loadToolSecretMap() {
  if (process.env.TOOL_SECRET_MAP) {
    try {
      const parsed = JSON.parse(process.env.TOOL_SECRET_MAP);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      console.error('Invalid TOOL_SECRET_MAP JSON, using defaults');
    }
  }
  return DEFAULT_TOOL_SECRET_MAP;
}

const TOOL_SECRET_MAP = loadToolSecretMap();

/** @type {Map<string, string>} toolId → apiKey */
const cachedApiKeys = new Map();

/**
 * ツールIDに対応する Claude API キーを Secret Manager から取得
 * キーの値はコード・ログに一切書かない
 */
async function getApiKeyForTool(toolId) {
  if (cachedApiKeys.has(toolId)) {
    return cachedApiKeys.get(toolId);
  }

  const secretName = TOOL_SECRET_MAP[toolId];
  if (!secretName) {
    const err = new Error(`Unknown tool id: ${toolId}`);
    err.statusCode = 400;
    throw err;
  }

  const name = `projects/${PROJECT_ID}/secrets/${secretName}/versions/latest`;
  const [version] = await secretClient.accessSecretVersion({ name });
  const key = version.payload.data.toString('utf8').trim();

  if (!key) {
    throw new Error(`Secret is empty: ${secretName}`);
  }

  cachedApiKeys.set(toolId, key);
  return key;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tool-Id');
  res.setHeader('Access-Control-Max-Age', '3600');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function resolveToolId(req, body) {
  const headerId = req.headers['x-tool-id'];
  if (typeof headerId === 'string' && headerId.trim()) {
    return headerId.trim();
  }
  if (body && typeof body.tool_id === 'string' && body.tool_id.trim()) {
    return body.tool_id.trim();
  }
  return null;
}

/**
 * ブラウザ/サーバー → Cloud Run → Claude API の中継
 * 必須: X-Tool-Id ヘッダー（または body.tool_id）
 * ボディは Anthropic Messages API と同じ形式
 */
async function handleProxy(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    sendJson(res, 200, {
      ok: true,
      tools: Object.keys(TOOL_SECRET_MAP),
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { error: 'JSON body is required' });
    return;
  }

  const toolId = resolveToolId(req, body);
  if (!toolId) {
    sendJson(res, 400, {
      error: 'X-Tool-Id header (or body.tool_id) is required',
      tools: Object.keys(TOOL_SECRET_MAP),
    });
    return;
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: 'body.messages (array) is required' });
    return;
  }

  try {
    const apiKey = await getApiKeyForTool(toolId);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-haiku-4-5-20251001',
        max_tokens: body.max_tokens || 2048,
        messages: body.messages,
        ...(body.system ? { system: body.system } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      }),
    });

    const data = await anthropicRes.json();
    sendJson(res, anthropicRes.status, data);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    console.error('claudeProxy error:', err && err.message ? err.message : err);
    sendJson(res, status, {
      error: status === 400 ? err.message : 'Proxy failed',
    });
  }
}

const server = http.createServer((req, res) => {
  handleProxy(req, res).catch((err) => {
    console.error('unhandled error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Proxy failed' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`claude-api-proxy listening on port ${PORT}`);
  console.log(`registered tools: ${Object.keys(TOOL_SECRET_MAP).join(', ')}`);
});
