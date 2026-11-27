import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { deriveAccessToken } from '../api/redeem.js';

const mockUrl = 'data:text/javascript,' + encodeURIComponent(
  'export const { get, put, del } = globalThis.openWhenTestBlob;'
);

const store = new Map();
let failure;
globalThis.openWhenTestBlob = {
  async get(path) {
    if (!store.has(path)) return null;
    return { statusCode: 200, stream: new Blob([store.get(path)]).stream() };
  },
  async put(path, data, options) {
    if (options.allowOverwrite === false && store.has(path)) throw new Error('Already exists');
    const mode = failure?.(path, JSON.parse(path.endsWith('.lock') ? 'null' : data));
    if (mode === 'before') throw new Error('Write failed');
    store.set(path, data);
    if (mode === 'after') throw new Error('Write response lost');
  },
  async del(path) {
    store.delete(path);
  }
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@vercel/blob' && /\/api\/(gifts|access)\.js$/.test(context.parentURL)) {
      return { url: mockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
const { default: save } = await import('../api/gifts.js');
const { default: access } = await import('../api/access.js');
hooks.deregister();

process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
const token = deriveAccessToken('test-secret', 'test-sale');
const hash = crypto.createHash('sha256').update(token).digest('hex');
const entitlementPath = 'entitlements/' + hash + '.json';
const lockPath = 'entitlement-locks/' + hash + '.lock';
const giftPath = 'gifts/reserved-gift.json';

function setup() {
  failure = undefined;
  store.clear();
  store.set(entitlementPath, JSON.stringify({
    version: 1, tokenHash: hash, status: 'unused', giftId: 'reserved-gift'
  }));
}

async function call(handler, req) {
  const response = { setHeader() {} };
  response.status = code => { response.code = code; return response; };
  response.json = body => { response.body = body; return response; };
  await handler(req, response);
  return response;
}

function create(recipient = 'Recipient', id = 'client-id') {
  return call(save, {
    method: 'POST',
    body: { id, recipient, sender: 'Sender', edition: 'daughter', messages: Array(24).fill('Message'), accessToken: token }
  });
}

test('an entitlement can be retried after marking it used fails', async () => {
  setup();
  failure = (path, data) => path === entitlementPath && data.status === 'used' ? 'before' : undefined;
  assert.equal((await create()).code, 500);
  assert.equal(store.has(lockPath), false);
  assert.equal(store.has(giftPath), false);
  failure = undefined;
  assert.equal((await create()).code, 201);
});

test('concurrent requests save one gift and cannot replace its contents', async () => {
  setup();
  assert.equal((await call(access, { method: 'GET', query: { token } })).code, 200);
  const results = await Promise.all([create(), create('Second recipient', 'another-id')]);
  assert.deepEqual(results.map(result => result.code).sort(), [201, 409]);
  const gift = store.get(giftPath);
  assert.equal((await create('Replay')).code, 409);
  assert.equal(store.get(giftPath), gift);
  assert.equal([...store.keys()].filter(path => path.startsWith('gifts/')).length, 1);
});

test('a lost gift write response preserves the completed gift', async () => {
  setup();
  failure = path => path === giftPath ? 'after' : undefined;
  assert.equal((await create()).code, 201);
  assert.equal((await create('Replay')).code, 409);
  assert.equal(JSON.parse(store.get(giftPath)).recipient, 'Recipient');
});
