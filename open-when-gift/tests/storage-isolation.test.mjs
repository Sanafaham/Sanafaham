// Preview storage isolation: Preview uses only the isolated store, never the production token,
// and fails closed before any storage request when its configuration is missing or wrong.
// Production and local behaviour are unchanged. All network traffic is intercepted locally.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { resolveStorage, storeFromEnv, StorageConfigError } from '../lib/store.js';
import { adminSecret, createSession, SESSION_COOKIE } from '../lib/owner-auth.js';
import { makeAccessHandler } from '../api/access.js';
import { makeGiftsHandler } from '../api/gifts.js';
import { makeAdminAccessHandler } from '../api/admin/access.js';
import { makeSessionHandler } from '../api/admin/session.js';
import { makeHistoryHandler } from '../api/admin/history.js';
import { makeStoreIdentityHandler } from '../api/admin/store.js';
import { mockReq, mockRes } from './helpers.mjs';

const PROD_TOKEN = 'vercel_blob_rw_ProdStore111_' + 'p'.repeat(30);
const PREVIEW_TOKEN = 'vercel_blob_rw_TQCRdDGoQxIfwASk_' + 'q'.repeat(30);
const OTHER_TOKEN = 'vercel_blob_rw_SomeOther999_' + 'r'.repeat(30);
const PROD_SECRET = 'P'.repeat(40);
const PREVIEW_SECRET = 'V'.repeat(40);

const previewEnv = (over = {}) => ({
  VERCEL_ENV: 'preview',
  BLOB_READ_WRITE_TOKEN: PROD_TOKEN,
  OW_PREVIEW_READ_WRITE_TOKEN: PREVIEW_TOKEN,
  OW_PREVIEW_STORE_ID: 'store_TQCRdDGoQxIfwASk',
  OPEN_WHEN_ADMIN_SECRET: PROD_SECRET,
  OW_PREVIEW_ADMIN_SECRET: PREVIEW_SECRET,
  ...over
});
const ENV_KEYS = ['VERCEL_ENV', 'BLOB_READ_WRITE_TOKEN', 'OW_PREVIEW_READ_WRITE_TOKEN', 'OW_PREVIEW_STORE_ID', 'OPEN_WHEN_ADMIN_SECRET', 'OW_PREVIEW_ADMIN_SECRET', 'OPEN_WHEN_PRODUCTION_STORE_ID'];
function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const restore = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

// Records every outgoing request host; answers reads with 404 and refuses everything else.
async function watchNetwork(fn) {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const hosts = [];
  agent.get((origin) => { hosts.push(String(origin).toLowerCase()); return true; })
    .intercept({ path: () => true, method: () => true })
    .reply(404, 'not found')
    .persist();
  setGlobalDispatcher(agent);
  try { await fn(); } finally { setGlobalDispatcher(previous); await agent.close(); }
  return hosts;
}
const call = async (handler, req) => { const res = mockRes(); await handler(req, res); return res; };

// ----- resolveStorage -------------------------------------------------------------------

test('Preview uses only the isolated token when it matches the Preview store', () => {
  const r = resolveStorage(previewEnv());
  assert.equal(r.token, PREVIEW_TOKEN);
  assert.equal(r.storeId, 'store_TQCRdDGoQxIfwASk');
  assert.equal(r.environment, 'preview');
  assert.equal(resolveStorage(previewEnv({ OW_PREVIEW_STORE_ID: 'TQCRdDGoQxIfwASk' })).token, PREVIEW_TOKEN);
});

test('Preview never falls back to the production token', () => {
  for (const missing of [undefined, '']) {
    assert.throws(() => resolveStorage(previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: missing })), (e) => e instanceof StorageConfigError && /token is not configured/.test(e.message));
  }
  assert.throws(() => resolveStorage(previewEnv({ OW_PREVIEW_STORE_ID: undefined })), /store ID is not configured/);
  assert.throws(() => resolveStorage(previewEnv({ OW_PREVIEW_STORE_ID: '  ' })), /store ID is not configured/);
});

test('Preview refuses a token from a different store', () => {
  assert.throws(() => resolveStorage(previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: OTHER_TOKEN })), /does not belong to the Preview store/);
  assert.throws(() => resolveStorage(previewEnv({ OW_PREVIEW_STORE_ID: 'store_SomethingElse1' })), /does not belong to the Preview store/);
});

test('Preview refuses tokens it cannot verify', () => {
  for (const t of ['not-a-token', 'vercel_blob_rw__x', 'vercel_blob_client_TQCRdDGoQxIfwASk_x', 'Bearer ' + PREVIEW_TOKEN]) {
    assert.throws(() => resolveStorage(previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: t })), /cannot be verified/, t);
  }
});

test('Preview refuses the production token even when the Preview variables point at it', () => {
  // Production token copied into the Preview variable, with the Preview store ID edited to match.
  assert.throws(() => resolveStorage(previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: PROD_TOKEN, OW_PREVIEW_STORE_ID: 'store_ProdStore111' })), /production Blob store/);
  // Explicit production store ID guard still applies.
  const env = previewEnv({ BLOB_READ_WRITE_TOKEN: undefined, OPEN_WHEN_PRODUCTION_STORE_ID: 'store_TQCRdDGoQxIfwASk' });
  assert.throws(() => resolveStorage(env), /production Blob store/);
});

test('Production and local behaviour is unchanged', () => {
  const prod = resolveStorage({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: PROD_TOKEN, OW_PREVIEW_READ_WRITE_TOKEN: PREVIEW_TOKEN, OW_PREVIEW_STORE_ID: 'store_TQCRdDGoQxIfwASk' });
  assert.equal(prod.token, PROD_TOKEN);
  assert.equal(prod.environment, 'production');
  assert.equal(resolveStorage({ BLOB_READ_WRITE_TOKEN: PROD_TOKEN }).token, PROD_TOKEN);
  // Production never validated the token format and still does not.
  assert.equal(resolveStorage({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'legacy-format' }).token, 'legacy-format');
  assert.throws(() => resolveStorage({ VERCEL_ENV: 'production' }), /Blob storage is not configured/);
  assert.throws(() => storeFromEnv({ VERCEL_ENV: 'production' }), /Blob storage is not configured/);
});

test('error messages never contain token values', () => {
  const cases = [previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: OTHER_TOKEN }), previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: 'garbage-secret-value' }), previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: PROD_TOKEN, OW_PREVIEW_STORE_ID: 'ProdStore111' })];
  for (const env of cases) {
    try { resolveStorage(env); assert.fail('should throw'); } catch (e) {
      for (const secret of [PROD_TOKEN, PREVIEW_TOKEN, OTHER_TOKEN, 'garbage-secret-value', 'p'.repeat(30), 'r'.repeat(30)]) assert.ok(!e.message.includes(secret));
    }
  }
});

// ----- endpoints fail closed before any storage request --------------------------------

test('misconfigured Preview: every endpoint fails closed with zero storage requests', async () => {
  const broken = [
    previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: undefined }),
    previewEnv({ OW_PREVIEW_STORE_ID: undefined }),
    previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: OTHER_TOKEN }),
    previewEnv({ OW_PREVIEW_READ_WRITE_TOKEN: PROD_TOKEN, OW_PREVIEW_STORE_ID: 'store_ProdStore111' })
  ];
  for (const env of broken) {
    await withEnv(env, async () => {
      const cookie = createSession(PREVIEW_SECRET);
      const owner = { host: 'x.vercel.app', origin: 'https://x.vercel.app', cookie: SESSION_COOKIE + '=' + cookie, 'x-open-when-owner': '1' };
      const results = {};
      const hosts = await watchNetwork(async () => {
        results.access = await call(makeAccessHandler(), mockReq({ method: 'POST', body: { token: 'a'.repeat(43) } }));
        results.load = await call(makeGiftsHandler(), mockReq({ method: 'GET', query: { id: 'abc' } }));
        results.save = await call(makeGiftsHandler(), mockReq({ method: 'POST', body: { id: 'x', accessToken: 'a'.repeat(43), edition: 'son', recipient: 'A', sender: 'B', messages: Array(24).fill('m') } }));
        results.issue = await call(makeAdminAccessHandler(), mockReq({ method: 'POST', headers: { 'x-open-when-admin': PREVIEW_SECRET } }));
        results.login = await call(makeSessionHandler(), mockReq({ method: 'POST', headers: { host: 'x.vercel.app', origin: 'https://x.vercel.app' }, body: { password: PREVIEW_SECRET } }));
        results.history = await call(makeHistoryHandler(), mockReq({ headers: owner }));
        results.identity = await call(makeStoreIdentityHandler(), mockReq({ headers: owner }));
      });
      assert.deepEqual(hosts, [], 'no storage request was made');
      assert.ok(results.access.statusCode >= 500);
      assert.equal(results.load.statusCode, 500);
      assert.equal(results.save.statusCode, 500);
      assert.equal(results.issue.statusCode, 500);
      assert.equal(results.login.headers.location, '/owner.html?login=wait');
      assert.equal(results.login.headers['set-cookie'], undefined);
      assert.equal(results.history.statusCode, 500);
      assert.equal(results.identity.statusCode, 503);
      const all = JSON.stringify(results);
      for (const secret of [PROD_TOKEN, PREVIEW_TOKEN, OTHER_TOKEN]) assert.ok(!all.includes(secret), 'no token in any response');
    });
  }
});

test('configured Preview: reads go only to the isolated store host, never production', async () => {
  await withEnv(previewEnv(), async () => {
    let res;
    const hosts = await watchNetwork(async () => {
      res = await call(makeGiftsHandler(), mockReq({ method: 'GET', query: { id: 'does-not-exist' } }));
    });
    assert.equal(res.statusCode, 404);
    assert.ok(hosts.length >= 1);
    for (const h of hosts) {
      assert.equal(h, 'https://tqcrddgoqxifwask.private.blob.vercel-storage.com');
      assert.ok(!h.includes('prodstore111'));
    }
  });
});

test('Production: reads still use the production token', async () => {
  await withEnv({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: PROD_TOKEN, OW_PREVIEW_READ_WRITE_TOKEN: PREVIEW_TOKEN, OW_PREVIEW_STORE_ID: 'store_TQCRdDGoQxIfwASk', OPEN_WHEN_ADMIN_SECRET: PROD_SECRET }, async () => {
    const hosts = await watchNetwork(async () => {
      const res = await call(makeGiftsHandler(), mockReq({ method: 'GET', query: { id: 'does-not-exist' } }));
      assert.equal(res.statusCode, 404);
    });
    for (const h of hosts) assert.equal(h, 'https://prodstore111.private.blob.vercel-storage.com');
  });
});

// ----- owner access on Preview ----------------------------------------------------------

test('Preview owner access uses only its own secret', () => {
  assert.equal(adminSecret(previewEnv()), PREVIEW_SECRET);
  assert.equal(adminSecret(previewEnv({ OW_PREVIEW_ADMIN_SECRET: undefined })), '', 'no fallback to the production secret');
  assert.equal(adminSecret(previewEnv({ OW_PREVIEW_ADMIN_SECRET: PROD_SECRET })), '', 'reusing the production secret is refused');
  assert.equal(adminSecret({ VERCEL_ENV: 'production', OPEN_WHEN_ADMIN_SECRET: PROD_SECRET, OW_PREVIEW_ADMIN_SECRET: PREVIEW_SECRET }), PROD_SECRET);
  assert.equal(adminSecret({ OPEN_WHEN_ADMIN_SECRET: PROD_SECRET }), PROD_SECRET);
});

test('a production owner session or secret does not work on Preview', async () => {
  await withEnv(previewEnv(), async () => {
    const owner = (secret) => ({ host: 'x.vercel.app', origin: 'https://x.vercel.app', cookie: SESSION_COOKIE + '=' + createSession(secret), 'x-open-when-owner': '1' });
    assert.equal((await call(makeStoreIdentityHandler(), mockReq({ headers: owner(PROD_SECRET) }))).statusCode, 401);
    const issue = await call(makeAdminAccessHandler({ getStore: () => { throw new Error('must not be reached'); } }), mockReq({ method: 'POST', headers: { 'x-open-when-admin': PROD_SECRET } }));
    assert.equal(issue.statusCode, 401);
  });
  await withEnv(previewEnv({ OW_PREVIEW_ADMIN_SECRET: undefined }), async () => {
    const res = await call(makeStoreIdentityHandler(), mockReq({ headers: { host: 'x.vercel.app', origin: 'https://x.vercel.app', cookie: SESSION_COOKIE + '=' + createSession(PROD_SECRET), 'x-open-when-owner': '1' } }));
    assert.equal(res.statusCode, 503, 'owner access disabled on Preview without its own secret');
  });
});

// ----- store identity check -------------------------------------------------------------

test('store identity check: owner-only, read-only, reports only the store ID', async () => {
  await withEnv(previewEnv(), async () => {
    const base = { host: 'x.vercel.app', origin: 'https://x.vercel.app' };
    const cookie = SESSION_COOKIE + '=' + createSession(PREVIEW_SECRET);
    let ok, anon, noHeader, cross;
    const hosts = await watchNetwork(async () => {
      ok = await call(makeStoreIdentityHandler(), mockReq({ headers: { ...base, cookie, 'x-open-when-owner': '1' } }));
      anon = await call(makeStoreIdentityHandler(), mockReq({ headers: { ...base, 'x-open-when-owner': '1' } }));
      noHeader = await call(makeStoreIdentityHandler(), mockReq({ headers: { ...base, cookie } }));
      cross = await call(makeStoreIdentityHandler(), mockReq({ headers: { ...base, cookie, origin: 'https://evil.example', 'x-open-when-owner': '1' } }));
    });
    assert.deepEqual(hosts, [], 'identity check makes no storage request');
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body, { ok: true, environment: 'preview', storeId: 'store_TQCRdDGoQxIfwASk' });
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(anon.statusCode, 401);
    assert.equal(noHeader.statusCode, 403);
    assert.equal(cross.statusCode, 403);
    for (const r of [ok, anon, noHeader, cross]) {
      const text = JSON.stringify(r.body);
      for (const secret of [PROD_TOKEN, PREVIEW_TOKEN, 'q'.repeat(30), 'p'.repeat(30), PREVIEW_SECRET, PROD_SECRET]) assert.ok(!text.includes(secret));
    }
    const post = await call(makeStoreIdentityHandler(), mockReq({ method: 'POST', headers: { ...base, cookie, 'x-open-when-owner': '1' } }));
    assert.equal(post.statusCode, 405);
  });
  await withEnv({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: PROD_TOKEN, OPEN_WHEN_ADMIN_SECRET: PROD_SECRET }, async () => {
    const res = await call(makeStoreIdentityHandler(), mockReq({ headers: { host: 'x', origin: 'https://x', cookie: SESSION_COOKIE + '=' + createSession(PROD_SECRET), 'x-open-when-owner': '1' } }));
    assert.deepEqual(res.body, { ok: true, environment: 'production', storeId: 'store_ProdStore111' });
  });
});


