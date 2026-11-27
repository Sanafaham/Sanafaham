import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRedeemHandler, deriveAccessToken } from '../api/redeem.js';

const PRODUCT = 'prod_ABC123==';
const SECRET = 'test-secret-do-not-use';
const KEY = 'AAAA1111-BBBB2222-CCCC3333-DDDD4444';

// In-memory stand-in for private Vercel Blob with the same no-overwrite rule.
function memoryBlob() {
  const store = new Map();
  return {
    store,
    async get(path) {
      if (!store.has(path)) return null;
      return { statusCode: 200, stream: new Blob([store.get(path)]).stream() };
    },
    async put(path, body, opts) {
      await new Promise(r => setTimeout(r, 1));
      if (opts.allowOverwrite === false && store.has(path)) throw new Error('BlobAlreadyExists');
      store.set(path, body);
      return { pathname: path };
    }
  };
}

function gumroad(purchaseOverrides = {}, { success = true, status = 200, calls } = {}) {
  return async (url, init) => {
    if (calls) calls.push(String(init.body));
    return new Response(JSON.stringify(success
      ? { success: true, uses: 0, purchase: { id: 'pur_1', product_id: PRODUCT, license_key: KEY, refunded: false, chargebacked: false, ...purchaseOverrides } }
      : { success: false, message: 'That license does not exist for the provided product.' }), { status });
  };
}

const env = { BLOB_READ_WRITE_TOKEN: 'blob', GUMROAD_PRODUCT_ID: PRODUCT, OPEN_WHEN_REDEEM_SECRET: SECRET };

async function call(handler, { method = 'POST', body = { licenseKey: KEY } } = {}) {
  const res = { code: 0, json: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.code = code; return res; };
  res.json = data => { res.body = data; return res; };
  await handler({ method, body }, res);
  return res;
}

function entitlements(blob) {
  return [...blob.store.keys()].filter(k => k.startsWith('entitlements/'));
}

test('valid purchase unlocks exactly one gift in the existing entitlement format', async () => {
  const blob = memoryBlob();
  const calls = [];
  const h = createRedeemHandler({ blob, fetchImpl: gumroad({}, { calls }), env });
  const r = await call(h);
  assert.equal(r.code, 200);
  const token = deriveAccessToken(SECRET, 'pur_1');
  assert.equal(r.body.accessPath, '/?access=' + encodeURIComponent(token));
  assert.equal(r.headers['Cache-Control'], 'no-store');
  // Gumroad was asked not to count uses, and for this exact product.
  assert.match(calls[0], /increment_uses_count=false/);
  assert.match(calls[0], /product_id=prod_ABC123%3D%3D/);
  const keys = entitlements(blob);
  assert.equal(keys.length, 1);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal(keys[0], 'entitlements/' + hash + '.json');
  const e = JSON.parse(blob.store.get(keys[0]));
  // Same shape /api/access and /api/gifts already require.
  assert.equal(e.version, 1);
  assert.equal(e.tokenHash, hash);
  assert.equal(e.status, 'unused');
  assert.ok(e.giftId);
  // Raw token and license key are never stored.
  assert.ok(!blob.store.get(keys[0]).includes(token));
  assert.ok(!blob.store.get(keys[0]).includes(KEY));
});

test('redeeming the same key again returns the same link and creates no duplicate', async () => {
  const blob = memoryBlob();
  const h = createRedeemHandler({ blob, fetchImpl: gumroad(), env });
  const a = await call(h);
  const b = await call(h, { body: { licenseKey: ' ' + KEY.toLowerCase() + ' ' } });
  assert.equal(a.body.accessPath, b.body.accessPath);
  assert.equal(entitlements(blob).length, 1);
});

test('two redeem requests at the same moment still make one entitlement', async () => {
  const blob = memoryBlob();
  const h = createRedeemHandler({ blob, fetchImpl: gumroad(), env });
  const [a, b] = await Promise.all([call(h), call(h)]);
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.equal(a.body.accessPath, b.body.accessPath);
  assert.equal(entitlements(blob).length, 1);
});

test('once the gift is created, the key cannot unlock a second gift but points to the first', async () => {
  const blob = memoryBlob();
  const h = createRedeemHandler({ blob, fetchImpl: gumroad(), env });
  await call(h);
  const [path] = entitlements(blob);
  const e = JSON.parse(blob.store.get(path));
  blob.store.set(path, JSON.stringify({ ...e, status: 'used', usedAt: new Date().toISOString() }));

  const pending = await call(h);
  assert.equal(pending.code, 409);
  assert.equal(pending.body.giftPath, undefined);
  assert.equal(pending.body.accessPath, undefined);

  blob.store.set('gifts/' + e.giftId + '.json', JSON.stringify({ version: 1, id: e.giftId }));
  const r = await call(h);
  assert.equal(r.code, 409);
  assert.equal(r.body.used, true);
  assert.equal(r.body.giftPath, '/?gift=' + e.giftId);
  assert.equal(r.body.accessPath, undefined);
});

test('invalid key is rejected and stores nothing', async () => {
  const blob = memoryBlob();
  const h = createRedeemHandler({ blob, fetchImpl: gumroad({}, { success: false, status: 404 }), env });
  const r = await call(h);
  assert.equal(r.code, 403);
  assert.equal(blob.store.size, 0);
});

for (const [name, override] of [['refunded', { refunded: true }], ['chargebacked', { chargebacked: true }], ['disputed', { disputed: true }]]) {
  test(name + ' purchase cannot create a gift', async () => {
    const blob = memoryBlob();
    const h = createRedeemHandler({ blob, fetchImpl: gumroad(override), env });
    const r = await call(h);
    assert.equal(r.code, 403);
    assert.equal(blob.store.size, 0);
  });
}

test('a key from a different Gumroad product is rejected', async () => {
  const blob = memoryBlob();
  const h = createRedeemHandler({ blob, fetchImpl: gumroad({ product_id: 'other_product' }), env });
  const r = await call(h);
  assert.equal(r.code, 403);
  assert.equal(blob.store.size, 0);
});

test('Gumroad being down gives a retryable error and stores nothing', async () => {
  const blob = memoryBlob();
  const h = createRedeemHandler({ blob, fetchImpl: async () => { throw new Error('network'); }, env });
  const r = await call(h);
  assert.equal(r.code, 502);
  assert.equal(blob.store.size, 0);
});

test('missing configuration fails closed', async () => {
  for (const missing of ['BLOB_READ_WRITE_TOKEN', 'GUMROAD_PRODUCT_ID', 'OPEN_WHEN_REDEEM_SECRET']) {
    const blob = memoryBlob();
    const h = createRedeemHandler({ blob, fetchImpl: gumroad(), env: { ...env, [missing]: '' } });
    const r = await call(h);
    assert.equal(r.code, 500, missing);
    assert.equal(blob.store.size, 0);
  }
});

test('empty or junk input never reaches Gumroad', async () => {
  const calls = [];
  const h = createRedeemHandler({ blob: memoryBlob(), fetchImpl: gumroad({}, { calls }), env });
  for (const body of [{}, { licenseKey: '' }, { licenseKey: '<script>' }, { licenseKey: 123 }]) {
    const r = await call(h, { body });
    assert.equal(r.code, 400);
  }
  assert.equal(calls.length, 0);
});

test('only POST is allowed', async () => {
  const h = createRedeemHandler({ blob: memoryBlob(), fetchImpl: gumroad(), env });
  const r = await call(h, { method: 'GET' });
  assert.equal(r.code, 405);
});

test('tokens cannot be guessed without the server secret', () => {
  assert.notEqual(deriveAccessToken(SECRET, 'pur_1'), deriveAccessToken('another-secret', 'pur_1'));
  assert.notEqual(deriveAccessToken(SECRET, 'pur_1'), deriveAccessToken(SECRET, 'pur_2'));
});

test('a different spelling of the same purchase maps to the same single gift', async () => {
  const blob = memoryBlob();
  const h = createRedeemHandler({ blob, fetchImpl: gumroad(), env });
  const a = await call(h);
  const b = await call(h, { body: { licenseKey: KEY.replace(/-/g, '') } });
  assert.equal(a.body.accessPath, b.body.accessPath);
  assert.equal(entitlements(blob).length, 1);
});

for (const status of [500, 503, 429]) {
  test('Gumroad ' + status + ' is a retryable error, not "invalid key"', async () => {
    const blob = memoryBlob();
    const h = createRedeemHandler({ blob, fetchImpl: async () => new Response('{}', { status }), env });
    const r = await call(h);
    assert.equal(r.code, 502);
    assert.equal(blob.store.size, 0);
  });
}

test('a purchase with no product id or no sale id is rejected', async () => {
  for (const override of [{ product_id: undefined }, { id: undefined }, { id: '' }]) {
    const blob = memoryBlob();
    const h = createRedeemHandler({ blob, fetchImpl: gumroad(override), env });
    const r = await call(h);
    assert.equal(r.code, 403);
    assert.equal(blob.store.size, 0);
  }
});

test('Gumroad check has a timeout', async () => {
  let signal;
  const h = createRedeemHandler({ blob: memoryBlob(), fetchImpl: async (u, init) => { signal = init.signal; return gumroad()(u, init); }, env });
  await call(h);
  assert.ok(signal instanceof AbortSignal);
});
