// Validates the assumption behind Preview storage isolation against the installed SDK:
// the store a read-write token reaches is the store ID that lib/store.js#storeIdOfToken reports.
// All network traffic is intercepted locally; nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { get, put } from '@vercel/blob';
import { storeIdOfToken } from '../lib/store.js';

const TOKEN = 'vercel_blob_rw_TQtest9StoreAb_' + 'x'.repeat(30);
const STORE = storeIdOfToken(TOKEN);

test('storeIdOfToken reads the store ID segment', () => {
  assert.equal(STORE, 'TQtest9StoreAb');
});

test('SDK reads go to the host of the store reported by storeIdOfToken', async () => {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const hosts = [];
  agent.get((origin) => { hosts.push(String(origin).toLowerCase()); return true; })
    .intercept({ path: () => true, method: 'GET' })
    .reply(404, 'not found')
    .persist();
  setGlobalDispatcher(agent);
  try {
    await get('probe/item.json', { access: 'private', token: TOKEN, useCache: false }).catch(() => null);
  } finally {
    setGlobalDispatcher(previous);
    await agent.close();
  }
  assert.ok(hosts.length >= 1, 'a read request was made');
  for (const h of hosts) assert.equal(h, 'https://' + STORE.toLowerCase() + '.private.blob.vercel-storage.com');
});

test('SDK writes name the store reported by storeIdOfToken and carry only this token', async () => {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const writes = [];
  agent.get(() => true)
    .intercept({ path: () => true, method: 'PUT' })
    .reply((opts) => {
      writes.push(opts.headers);
      return {
        statusCode: 200,
        data: JSON.stringify({ url: 'https://' + STORE.toLowerCase() + '.private.blob.vercel-storage.com/probe/item.json', downloadUrl: '', pathname: 'probe/item.json', contentType: 'application/json', contentDisposition: 'inline', etag: '"1"' }),
        responseOptions: { headers: { 'content-type': 'application/json' } }
      };
    })
    .persist();
  setGlobalDispatcher(agent);
  try {
    await put('probe/item.json', '{}', { access: 'private', token: TOKEN, addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' });
  } finally {
    setGlobalDispatcher(previous);
    await agent.close();
  }
  assert.ok(writes.length >= 1, 'a write request was made');
  for (const h of writes) {
    const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(headers['x-vercel-blob-store-id'], STORE);
    assert.equal(headers.authorization, 'Bearer ' + TOKEN);
  }
});

test('tokens that are not read-write tokens have no store ID', () => {
  for (const t of ['', 'abc', 'vercel_blob_rw__x', 'vercel_blob_client_ABC_x', 'vercel_blob_rw_AB-C_x', null, undefined, 42]) {
    assert.equal(storeIdOfToken(t), '', String(t));
  }
});
