import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { memoryStore, mockReq, mockRes, giftPayload, giftKeys } from './helpers.mjs';
import { makeAccessHandler } from '../api/access.js';
import { makeGiftsHandler } from '../api/gifts.js';
import { makeAdminAccessHandler } from '../api/admin/access.js';
import { makeSessionHandler } from '../api/admin/session.js';
import { makeHistoryHandler } from '../api/admin/history.js';
import { makeRevokeHandler } from '../api/admin/revoke.js';
import { createSession, SESSION_COOKIE, IP_LIMIT, GLOBAL_LIMIT } from '../lib/owner-auth.js';
import { storeFromEnv, storeIdOfToken } from '../lib/store.js';
import { tokenHash } from '../lib/entitlements.js';

const SECRET = 'S'.repeat(20) + crypto.randomBytes(16).toString('hex'); // 52 chars
process.env.OPEN_WHEN_ADMIN_SECRET = SECRET;
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_abc';

const HOST = 'open-when-gift.vercel.app';
const same = { host: HOST, origin: 'https://' + HOST };
const ownerHeaders = (cookie, extra = {}) => ({ ...same, cookie: SESSION_COOKIE + '=' + cookie, 'x-open-when-owner': '1', 'content-type': 'application/json', ...extra });

function app(store, now = () => Date.now()) {
  const getStore = () => store;
  return {
    access: makeAccessHandler({ getStore, now }),
    gifts: makeGiftsHandler({ getStore, now, readGift: async (p) => { const r = await store.read(p); return r && r.data; } }),
    issue: makeAdminAccessHandler({ getStore, now }),
    session: makeSessionHandler({ getStore, now }),
    history: makeHistoryHandler({ getStore, now }),
    revoke: makeRevokeHandler({ getStore, now })
  };
}
async function call(handler, req) { const res = mockRes(); await handler(req, res); return res; }

async function issueViaHeader(a) {
  const res = await call(a.issue, mockReq({ method: 'POST', headers: { 'x-open-when-admin': SECRET }, body: { reference: '#7' } }));
  assert.equal(res.statusCode, 201);
  return res.body;
}

test('existing secret-header issuance still works and wrong headers are refused', async () => {
  const a = app(memoryStore());
  const body = await issueViaHeader(a);
  assert.match(body.accessPath, /^\/\?access=[A-Za-z0-9_-]{43}$/);
  assert.equal(body.reference, '#7');
  const bad = await call(a.issue, mockReq({ method: 'POST', headers: { 'x-open-when-admin': SECRET + 'x' } }));
  assert.equal(bad.statusCode, 401);
  const none = await call(a.issue, mockReq({ method: 'POST' }));
  assert.equal(none.statusCode, 401);
});

test('buyer journey through the endpoints: create, refresh-recover, never a second gift', async () => {
  const store = memoryStore();
  const a = app(store);
  const { accessToken } = await issueViaHeader(a);

  let res = await call(a.access, mockReq({ method: 'POST', body: { token: accessToken } }));
  assert.deepEqual(res.body, { valid: true, state: 'unused' });
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-store');

  res = await call(a.gifts, mockReq({ method: 'POST', body: { id: 'client-id', accessToken, ...giftPayload() } }));
  assert.equal(res.statusCode, 201);
  const id = res.body.id;
  assert.notEqual(id, 'client-id', 'gift ID comes from the entitlement, not the browser');

  // Refresh / reopen the original link: recovery, not creation.
  res = await call(a.access, mockReq({ method: 'POST', body: { token: accessToken } }));
  assert.deepEqual(res.body, { valid: false, state: 'created', giftId: id });

  res = await call(a.gifts, mockReq({ method: 'POST', body: { id: 'x', accessToken, ...giftPayload({ recipient: 'Mallory' }) } }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.state, 'created');
  assert.equal(giftKeys(store).length, 1);

  // Recipient link loads only the gift, through the unchanged GET API.
  res = await call(a.gifts, mockReq({ method: 'GET', query: { id } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recipient, 'Lou');
  assert.ok(!JSON.stringify(res.body).includes(accessToken));
  assert.ok(!JSON.stringify(res.body).includes(tokenHash(accessToken)));
});

test('legacy GET access check keeps its old contract for pages loaded before release', async () => {
  const a = app(memoryStore());
  const { accessToken } = await issueViaHeader(a);
  let res = await call(a.access, mockReq({ method: 'GET', query: { token: accessToken } }));
  assert.deepEqual(res.body, { valid: true });
  await call(a.gifts, mockReq({ method: 'POST', body: { id: 'x', accessToken, ...giftPayload() } }));
  res = await call(a.access, mockReq({ method: 'GET', query: { token: accessToken } }));
  assert.equal(res.statusCode, 409);
  res = await call(a.access, mockReq({ method: 'GET', query: { token: 'nope' } }));
  assert.equal(res.statusCode, 403);
});

test('gift validation is unchanged', async () => {
  const a = app(memoryStore());
  const { accessToken } = await issueViaHeader(a);
  const bad = [
    { id: 'x', accessToken, ...giftPayload({ edition: 'cat' }) },
    { id: 'x', accessToken, ...giftPayload({ sender: '' }) },
    { id: 'x', accessToken, ...giftPayload({ messages: Array(23).fill('m') }) },
    { id: 'x', accessToken, ...giftPayload({ messages: [...Array(23).fill('m'), ''] }) },
    { accessToken, ...giftPayload() },
    { id: 'x', ...giftPayload() }
  ];
  for (const body of bad) {
    const res = await call(a.gifts, mockReq({ method: 'POST', body }));
    assert.equal(res.statusCode, 400);
  }
});

// ----- owner authentication -----------------------------------------------------------------
async function login(a, password, headers = same) {
  return call(a.session, mockReq({ method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': headers['x-real-ip'] || '1.2.3.4' }, body: 'password=' + encodeURIComponent(password) }));
}

test('owner login sets a 24h HttpOnly Secure SameSite=Strict cookie scoped to /api/admin', async () => {
  const a = app(memoryStore());
  const res = await login(a, SECRET);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/owner.html');
  const c = res.headers['set-cookie'];
  assert.match(c, new RegExp('^' + SESSION_COOKIE + '=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;'));
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/admin', 'Max-Age=86400']) assert.ok(c.includes(part), part);
  assert.ok(!c.includes(SECRET));
});

test('wrong password, cross-site login and weak secrets are refused', async () => {
  const a = app(memoryStore());
  let res = await login(a, 'wrong');
  assert.equal(res.headers.location, '/owner.html?login=failed');
  assert.equal(res.headers['set-cookie'], undefined);

  res = await login(a, SECRET, { host: HOST, origin: 'https://evil.example' });
  assert.equal(res.headers.location, '/owner.html?login=failed');
  assert.equal(res.headers['set-cookie'], undefined);

  res = await login(a, SECRET, { host: HOST }); // no Origin, no Fetch Metadata
  assert.equal(res.headers['set-cookie'], undefined);

  res = await login(a, SECRET, { host: HOST, 'sec-fetch-site': 'same-origin' }); // Origin omitted but Fetch Metadata says same-origin
  assert.ok(res.headers['set-cookie']);

  res = await login(a, SECRET, { host: HOST, origin: 'null', 'sec-fetch-site': 'same-origin', 'x-real-ip': '9.9.9.1' });
  assert.ok(res.headers['set-cookie'], 'Origin: null with same-origin Fetch Metadata is accepted');
  res = await login(a, SECRET, { host: HOST, origin: 'null', 'x-real-ip': '9.9.9.2' });
  assert.equal(res.headers['set-cookie'], undefined, 'Origin: null alone is refused');
  res = await login(a, SECRET, { host: HOST, origin: 'null', 'sec-fetch-site': 'cross-site', 'x-real-ip': '9.9.9.3' });
  assert.equal(res.headers['set-cookie'], undefined, 'cross-site Fetch Metadata is refused');

  const saved = process.env.OPEN_WHEN_ADMIN_SECRET;
  process.env.OPEN_WHEN_ADMIN_SECRET = 'short-secret';
  try {
    res = await login(a, 'short-secret');
    assert.equal(res.headers.location, '/owner.html?login=disabled');
    assert.equal(res.headers['set-cookie'], undefined);
  } finally { process.env.OPEN_WHEN_ADMIN_SECRET = saved; }
});

test('login rate limiting: per-IP and global caps, counted before the password check', async () => {
  const store = memoryStore();
  const a = app(store);
  for (let i = 0; i < IP_LIMIT; i++) assert.equal((await login(a, 'wrong')).headers.location, '/owner.html?login=failed');
  // Even the correct password is refused once the IP is over the limit.
  const blocked = await login(a, SECRET);
  assert.equal(blocked.headers.location, '/owner.html?login=wait');
  assert.equal(blocked.headers['set-cookie'], undefined);
  // A different IP still works.
  assert.ok((await login(a, SECRET, { ...same, 'x-real-ip': '5.6.7.8' })).headers['set-cookie']);

  const store2 = memoryStore();
  const b = app(store2);
  for (let i = 0; i < GLOBAL_LIMIT; i++) await login(b, 'wrong', { ...same, 'x-real-ip': '10.0.0.' + i });
  const g = await login(b, SECRET, { ...same, 'x-real-ip': '10.9.9.9' });
  assert.equal(g.headers.location, '/owner.html?login=wait');
});

test('rate limiter fails closed when its counter cannot be written', async () => {
  const store = memoryStore();
  const broken = { ...store, create: async () => { throw new Error('down'); }, replace: async () => { throw new Error('down'); } };
  const a = app(broken);
  const res = await login(a, SECRET);
  assert.equal(res.headers.location, '/owner.html?login=wait');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('parallel login attempts cannot exceed the per-IP limit', async () => {
  const store = memoryStore();
  const a = app(store);
  const results = await Promise.all(Array.from({ length: 12 }, () => login(a, 'wrong')));
  const counted = results.filter((r) => r.headers.location === '/owner.html?login=failed').length;
  assert.ok(counted <= IP_LIMIT, 'checked ' + counted + ' passwords');
});

test('owner endpoints require session + same origin + owner header', async () => {
  const store = memoryStore();
  const a = app(store);
  const cookie = createSession(SECRET);
  await issueViaHeader(a);

  assert.equal((await call(a.history, mockReq({ headers: ownerHeaders(cookie) }))).statusCode, 200);
  assert.equal((await call(a.history, mockReq({ headers: { ...same, 'x-open-when-owner': '1' } }))).statusCode, 401);
  assert.equal((await call(a.history, mockReq({ headers: ownerHeaders(cookie, { 'x-open-when-owner': undefined }) }))).statusCode, 403);
  assert.equal((await call(a.history, mockReq({ headers: ownerHeaders(cookie, { origin: 'https://evil.example' }) }))).statusCode, 403);
  assert.equal((await call(a.history, mockReq({ headers: ownerHeaders(cookie + 'x') }))).statusCode, 401);
  const forged = cookie.split('.')[0] + '.' + crypto.randomBytes(32).toString('base64url');
  assert.equal((await call(a.history, mockReq({ headers: ownerHeaders(forged) }))).statusCode, 401);
  const expired = createSession(SECRET, Date.now() - 25 * 3600 * 1000);
  assert.equal((await call(a.history, mockReq({ headers: ownerHeaders(expired) }))).statusCode, 401);
  const otherSecret = createSession('X'.repeat(40));
  assert.equal((await call(a.history, mockReq({ headers: ownerHeaders(otherSecret) }))).statusCode, 401);

  // Issuing through the session needs all three as well.
  const ok = await call(a.issue, mockReq({ method: 'POST', headers: ownerHeaders(cookie), body: { reference: 'Order 12' } }));
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.body.reference, 'Order 12');
  const noHeader = await call(a.issue, mockReq({ method: 'POST', headers: ownerHeaders(cookie, { 'x-open-when-owner': undefined }) }));
  assert.equal(noHeader.statusCode, 401);
  const cross = await call(a.issue, mockReq({ method: 'POST', headers: ownerHeaders(cookie, { origin: 'https://evil.example' }) }));
  assert.equal(cross.statusCode, 401);
});

test('owner history, revoke and status flow through the endpoints', async () => {
  const store = memoryStore();
  const a = app(store);
  const cookie = createSession(SECRET);
  const one = (await call(a.issue, mockReq({ method: 'POST', headers: ownerHeaders(cookie), body: { reference: 'A1' } }))).body;
  const two = (await call(a.issue, mockReq({ method: 'POST', headers: ownerHeaders(cookie), body: { reference: 'A2' } }))).body;
  await call(a.gifts, mockReq({ method: 'POST', body: { id: 'x', accessToken: two.accessToken, ...giftPayload() } }));

  let hist = (await call(a.history, mockReq({ headers: ownerHeaders(cookie) }))).body.links;
  const row1 = hist.find((r) => r.reference === 'A1');
  const row2 = hist.find((r) => r.reference === 'A2');
  assert.equal(row1.status, 'unused');
  assert.equal(row2.status, 'used');
  assert.match(row2.giftPath, /^\/\?gift=/);
  assert.ok(!JSON.stringify(hist).includes(one.accessToken));
  assert.ok(!JSON.stringify(hist).includes(two.accessToken));

  const rv = await call(a.revoke, mockReq({ method: 'POST', headers: ownerHeaders(cookie), body: { id: row1.id } }));
  assert.equal(rv.statusCode, 200);
  const rv2 = await call(a.revoke, mockReq({ method: 'POST', headers: ownerHeaders(cookie), body: { id: row2.id } }));
  assert.equal(rv2.statusCode, 409);
  const noAuth = await call(a.revoke, mockReq({ method: 'POST', headers: { ...same, 'x-open-when-owner': '1' }, body: { id: row1.id } }));
  assert.equal(noAuth.statusCode, 401);

  const res = await call(a.access, mockReq({ method: 'POST', body: { token: one.accessToken } }));
  assert.equal(res.body.state, 'revoked');
  const cr = await call(a.gifts, mockReq({ method: 'POST', body: { id: 'x', accessToken: one.accessToken, ...giftPayload() } }));
  assert.equal(cr.statusCode, 403);

  hist = (await call(a.history, mockReq({ headers: ownerHeaders(cookie) }))).body.links;
  assert.equal(hist.find((r) => r.reference === 'A1').status, 'revoked');
});

test('logout clears the cookie', async () => {
  const a = app(memoryStore());
  const res = await call(a.session, mockReq({ method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=logout' }));
  assert.equal(res.statusCode, 303);
  assert.match(res.headers['set-cookie'], /Max-Age=0/);
});

test('preview deployments refuse the production store', async () => {
  assert.equal(storeIdOfToken('vercel_blob_rw_ABC123_secretpart'), 'ABC123');
  assert.throws(() => storeFromEnv({ VERCEL_ENV: 'preview', OPEN_WHEN_PRODUCTION_STORE_ID: 'store_ABC123', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_ABC123_x' }), /production Blob store/);
  assert.doesNotThrow(() => storeFromEnv({ VERCEL_ENV: 'preview', OPEN_WHEN_PRODUCTION_STORE_ID: 'ABC123', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_TEST999_x' }));
  assert.doesNotThrow(() => storeFromEnv({ VERCEL_ENV: 'production', OPEN_WHEN_PRODUCTION_STORE_ID: 'ABC123', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_ABC123_x' }));
});
