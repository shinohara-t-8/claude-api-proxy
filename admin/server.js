const http = require('http');
const fs = require('fs');
const path = require('path');
const { registerTool, listRegisteredTools } = require('./register');

const PORT = Number(process.env.ADMIN_PORT) || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // localhost only binding is set on listen; still reject non-local Host if forwarded oddly
  if (req.method === 'GET' && req.url.startsWith('/api/tools')) {
    try {
      sendJson(res, 200, { tools: listRegisteredTools() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/register') {
    try {
      const body = await readBody(req);
      const result = registerTool({
        toolId: body.toolId,
        apiKey: body.apiKey,
        push: Boolean(body.push),
      });
      sendJson(res, 200, result);
    } catch (err) {
      console.error('register failed:', err && err.message ? err.message : err);
      sendJson(res, 400, { ok: false, error: err.message || '登録に失敗しました' });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Claude Key Admin  (localhost only)');
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log('');
});
