// Local test server for browser checks. Serves the static files and routes /api/* to the real
// handlers backed by the in-memory store. Never touches Vercel Blob.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryStore } from '../helpers.mjs';
import { makeAccessHandler } from '../../api/access.js';
import { makeGiftsHandler } from '../../api/gifts.js';
import { makeAdminAccessHandler } from '../../api/admin/access.js';
import { makeSessionHandler } from '../../api/admin/session.js';
import { makeHistoryHandler } from '../../api/admin/history.js';
import { makeRevokeHandler } from '../../api/admin/revoke.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };

export function startServer({ port = 0, store = memoryStore({ maxDelayMs: 1 }) } = {}) {
  const getStore = () => store;
  const readGift = async (p) => { const r = await store.read(p); return r && r.data; };
  const routes = {
    '/api/access': makeAccessHandler({ getStore }),
    '/api/gifts': makeGiftsHandler({ getStore, readGift }),
    '/api/admin/access': makeAdminAccessHandler({ getStore }),
    '/api/admin/session': makeSessionHandler({ getStore }),
    '/api/admin/history': makeHistoryHandler({ getStore }),
    '/api/admin/revoke': makeRevokeHandler({ getStore })
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const handler = routes[url.pathname];
    if (handler) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      let body;
      if (type.includes('application/json')) { try { body = JSON.parse(text); } catch { body = {}; } }
      else if (type.includes('urlencoded')) body = Object.fromEntries(new URLSearchParams(text));
      const vreq = { method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams), body };
      const vres = {
        setHeader: (k, v) => res.setHeader(k, v),
        status: (c) => { res.statusCode = c; return vres; },
        json: (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return vres; },
        end: () => { res.end(); return vres; }
      };
      server.requests.push({ method: req.method, url: req.url });
      return handler(vreq, vres);
    }
    server.requests.push({ method: req.method, url: req.url });
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Referrer-Policy', url.pathname === '/owner.html' ? 'same-origin' : 'no-referrer'); // mirrors vercel.json
    fs.createReadStream(file).pipe(res);
  });
  server.requests = [];
  server.store = store;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
