// Real Vercel Blob tests for OPEN WHEN, run ONLY against an isolated test store.
//
// Required environment (GitHub Actions secrets/variables):
//   OPEN_WHEN_TEST_BLOB_TOKEN  read-write token of the separate test store
//   OPEN_WHEN_TEST_STORE_ID    that store's ID; the token must belong to it
// Optional:
//   OPEN_WHEN_PRODUCTION_STORE_ID  if set, the run refuses to start when the token belongs to it
//
// Every blob is written under test-runs/<run-id>/ and deleted at the end.
// Without a token the suite reports SKIPPED; it never falls back to any other store.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { blobStore, storeIdOfToken, ConflictError } from '../lib/store.js';
import {
  issueEntitlement, accessState, createGift, revokeEntitlement, entitlementHistory,
  entitlementPath, giftPath, tokenHash, LEASE_MS, newRecoveryKey
} from '../lib/entitlements.js';
import { reserveLoginAttempt, IP_LIMIT } from '../lib/owner-auth.js';
import { faultyStore, giftPayload } from './helpers.mjs';

const token = process.env.OPEN_WHEN_TEST_BLOB_TOKEN || '';
const expectedStore = (process.env.OPEN_WHEN_TEST_STORE_ID || '').replace(/^store_/, '');
const productionStore = (process.env.OPEN_WHEN_PRODUCTION_STORE_ID || '').replace(/^store_/, '');

if (!token) {
  test('real storage (SKIPPED: no isolated test store configured)', { skip: true }, () => {});
} else {
  const actual = storeIdOfToken(token);
  if (!expectedStore || actual !== expectedStore) {
    throw new Error('Refusing to run: the token does not belong to OPEN_WHEN_TEST_STORE_ID.');
  }
  if (productionStore && actual === productionStore) {
    throw new Error('Refusing to run: the token belongs to the production store.');
  }

  const runId = 'test-runs/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex') + '/';
  const store = blobStore({ token, prefix: runId });
  const raw = blobStore({ token });
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const giftCount = async (id) => ((await store.exists(giftPath(id))) ? 1 : 0);
  const listGifts = async () => (await store.list('gifts/'));

  test.after(async () => {
    const paths = await raw.list(runId);
    for (const p of paths) await raw.remove(p).catch(() => {});
  });

  test('ifMatch: of two writes with the same ETag, exactly one succeeds (10 rounds)', async () => {
    for (let i = 0; i < 10; i++) {
      const path = 'cas/item-' + i + '.json';
      await store.create(path, { n: 0 });
      const { etag } = await store.read(path);
      const results = await Promise.allSettled([
        store.replace(path, { n: 'a' }, etag),
        store.replace(path, { n: 'b' }, etag)
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const conflicts = results.filter((r) => r.status === 'rejected' && r.reason instanceof ConflictError).length;
      assert.equal(ok, 1, 'round ' + i);
      assert.equal(conflicts, 1, 'round ' + i);
    }
  });

  test('stale ETag is rejected', async () => {
    await store.create('cas/stale.json', { n: 0 });
    const first = await store.read('cas/stale.json');
    await store.replace('cas/stale.json', { n: 1 }, first.etag);
    await assert.rejects(store.replace('cas/stale.json', { n: 2 }, first.etag), ConflictError);
  });

  test('20 concurrent creates on one link produce exactly one gift (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const rawToken = newToken();
      const rec = await issueEntitlement(store, { rawToken });
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        createGift(store, { rawToken, gift: giftPayload({ sender: 'S' + i }) }).catch((e) => ({ status: 500, error: e }))));
      const ok = results.filter((r) => r.status === 201);
      assert.equal(ok.length, 1, 'round ' + round + ': exactly one request saves');
      assert.equal(ok[0].body.id, rec.giftId);
      assert.equal(await giftCount(rec.giftId), 1);
      const creator = ok[0].recoveryKey;
      assert.deepEqual(await accessState(store, rawToken, Date.now(), creator), { state: 'created', giftId: rec.giftId });
      assert.deepEqual(await accessState(store, rawToken), { state: 'created-elsewhere' });
      const again = await createGift(store, { rawToken, gift: giftPayload() });
      assert.equal(again.status, 409);
    }
  });

  test('revoke racing create: exactly one wins (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const rawToken = newToken();
      const rec = await issueEntitlement(store, { rawToken });
      const [rv, cr] = await Promise.all([
        revokeEntitlement(store, tokenHash(rawToken)),
        createGift(store, { rawToken, gift: giftPayload() })
      ]);
      const final = (await store.read(entitlementPath(tokenHash(rawToken)))).data.status;
      if (final === 'revoked') {
        assert.equal(await giftCount(rec.giftId), 0);
        assert.notEqual(cr.status, 201);
      } else {
        assert.equal(final, 'used');
        assert.equal(cr.status, 201);
        assert.equal(rv.status, 409);
        assert.equal(await giftCount(rec.giftId), 1);
      }
    }
  });

  test('crash after claim: saving, then takeover after the lease saves once', async () => {
    const rawToken = newToken();
    const rec = await issueEntitlement(store, { rawToken });
    const t = Date.now();
    await createGift(faultyStore(store, { dieAfterWrites: 1 }), { rawToken, gift: giftPayload(), now: () => t }).catch(() => {});
    assert.deepEqual(await accessState(store, rawToken, t + 1000), { state: 'saving' });
    const later = t + LEASE_MS + 1;
    const r = await createGift(store, { rawToken, gift: giftPayload(), now: () => later });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, rec.giftId);
    assert.equal(await giftCount(rec.giftId), 1);
  });

  test('crash after gift save: recovered immediately and finalized by the next call', async () => {
    const rawToken = newToken();
    const rec = await issueEntitlement(store, { rawToken });
    const key = newRecoveryKey();
    await createGift(faultyStore(store, { dieAfterWrites: 2 }), { rawToken, gift: giftPayload(), recoveryKey: key }).catch(() => {});
    assert.deepEqual(await accessState(store, rawToken, Date.now(), key), { state: 'created', giftId: rec.giftId });
    assert.deepEqual(await accessState(store, rawToken), { state: 'created-elsewhere' });
    const r = await createGift(store, { rawToken, gift: giftPayload({ recipient: 'Other' }), recoveryKey: key });
    assert.equal(r.status, 409);
    assert.equal((await store.read(entitlementPath(tokenHash(rawToken)))).data.status, 'used');
    assert.equal((await store.read(giftPath(rec.giftId))).data.recipient, 'Lou');
  });

  test('lost responses on claim and gift writes still yield exactly one gift', async () => {
    const rawToken = newToken();
    const rec = await issueEntitlement(store, { rawToken });
    const s = faultyStore(store, { faults: [
      { op: 'replace', match: /^entitlements\//, mode: 'after', times: 1 },
      { op: 'create', match: /^gifts\//, mode: 'after', times: 1 }
    ] });
    const r = await createGift(s, { rawToken, gift: giftPayload() });
    assert.equal(r.status, 201);
    assert.equal(await giftCount(rec.giftId), 1);
    assert.equal((await store.read(entitlementPath(tokenHash(rawToken)))).data.status, 'used');
  });

  test('owner history lists records without tokens', async () => {
    const rows = await entitlementHistory(store);
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.ok(/^[a-f0-9]{64}$/.test(r.id));
  });

  test('login rate limiter holds under parallel attempts', async () => {
    const req = { headers: { 'x-real-ip': '203.0.113.' + crypto.randomInt(1, 250) } };
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveLoginAttempt(store, req, 'Z'.repeat(40))));
    const ok = results.filter((r) => r === 'ok').length;
    assert.ok(ok <= IP_LIMIT, ok + ' attempts allowed');
  });

  test('every blob written by this run stays under its prefix', async () => {
    const gifts = await listGifts();
    for (const g of gifts) assert.match(g, /^gifts\/[a-f0-9-]+\.json$/);
  });
}
