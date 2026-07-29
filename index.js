const http = require('http');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const secretClient = new SecretManagerServiceClient();
const PORT = Number(process.env.PORT) || 8080;
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || 't8studio-infra-jp';
const SECRET_NAME = process.env.CLAUDE_SECRET_NAME || 'claude-api-key';

/** @type {string|null} */
let cachedApiKey = null;

/**
 * Secret Manager から Claude API キーを取得（プロセス内キャッシュ）
 * キーの値はコード・ログに一切書かない
 */
async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;

  const name = `projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest`;
  const [version] = await secretClient.accessSecretVersion({ name });
  const key = version.payload.data.toString('utf8').trim();

  if (!key) {
    throw new Error('Secret is empty');
  }

  cachedApiKey = key;
  return cachedApiKey;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

/**
 * ブラウザ → Cloud Run → Claude API の中継
 * リクエストボディは Anthropic Messages API と同じ形式をそのまま渡す
 */
async function handleProxy(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    sendJson(res, 200, { ok: true });
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

  if (!body.messages || !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: 'body.messages (array) is required' });
    return;
  }

  try {
    const apiKey = await getApiKey();

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
    console.error('claudeProxy error:', err && err.message ? err.message : err);
    sendJson(res, 500, { error: 'Proxy failed' });
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
});
