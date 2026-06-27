import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createServer as createViteServer } from 'vite';

const require = createRequire(import.meta.url);
const port = Number(process.env.PORT || 3000);

loadEnvFile('.env.local');
loadEnvFile('.env');

const apiHandlers = {
  '/api/config': require('../api/config.js'),
  '/api/sync': require('../api/sync.js'),
  '/api/parse': require('../api/parse.js'),
  '/api/import-workouts': require('../api/import-workouts.js'),
  '/api/oura': require('../api/oura.js'),
};

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa',
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${port}`}`);
  const handler = apiHandlers[url.pathname];
  if (handler) {
    await runApiHandler(handler, req, res);
    return;
  }
  vite.middlewares(req, res);
});

server.listen(port, 'localhost', () => {
  console.log(`Strength Log local dev: http://localhost:${port}/`);
  console.log('Frontend + local /api functions are running from this process.');
});

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n');
    if (!process.env[key]) process.env[key] = value;
  }
}

async function runApiHandler(handler, req, res) {
  req.query = Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams.entries());
  req.body = await readBody(req);
  addVercelResponseHelpers(res);
  try {
    await handler(req, res);
  } catch (error) {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      if (!chunks.length) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      if (type.includes('application/json')) {
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
        return;
      }
      resolve(text);
    });
  });
}

function addVercelResponseHelpers(res) {
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = data => {
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
    return res;
  };
}
