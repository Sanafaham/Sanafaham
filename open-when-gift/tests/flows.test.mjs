import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  issueEntitlement, accessState, createGift, revokeEntitlement, entitlementHistory,
  entitlementPath, giftPath, tokenHash, LEASE_MS, newRecoveryKey
} from '../lib/entitlements.js';
import { memoryStore, faultyStore, seededRandom, giftPayload, giftKeys } from './helpers.mjs';

const newToken = () => crypto.randomBytes(32).toString('base64url');
async function issued(store, extra = {}) {
  const rawToken = newToken();
  const rec = await issueEntitlement(store, { rawToken, ...extra });
  return { rawToken, rec };
}
const recordOf = async (store, raw) => (await store.read(entitlementPath(tokenHash(raw)))).data;

test('issue -> unused -> create once -> used, gift at the fixed ID', async () => {
  const store = memoryStore();
  const { rawToken, rec } = await issued(store, { reference: '#1042' });
  assert.equal(rec.reference, '#1042');
  assert.deepEqual(await accessState(store, rawToken), { state: 'unused' });

  const r = await createGift(store, { rawToken, gift: giftPayload() });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, rec.giftId);
  assert.deepEqual(giftKeys(store), [giftPath(rec.giftId)]);

  const after = await recordOf(store, rawToken);
  assert.equal(after.status, 'used');
  assert.ok(after.usedAt);
  assert.equal(after.attempt, undefined);
  assert.equal(after.leaseUntil, undefined);
});

test('the gift record never contains the access token or its hash', async () => {
  const store = memoryStore();
  const { rawToken, rec } = await issued(store);
  await createGift(store, { rawToken, gift: giftPayload() });
  const body = store.map.get(giftPath(rec.giftId)).body;
  assert.ok(!body.includes(rawToken));
  assert.ok(!body.includes(tokenHash(rawToken)));
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['createdAt', 'edition', 'id', 'messages', 'recipient', 'sender', 'version']);
});

test('the creating browser recovers its gift; a forwarded link alone gets no gift ID; never a second gift', async () => {
  const store = memoryStore();
  const { rawToken, rec } = await issued(store);
  const key = newRecoveryKey(); // issued to the buyer's browser at the access check
  const made = await createGift(store, { rawToken, gift: giftPayload(), recoveryKey: key });
  assert.equal(made.recoveryKey, key);
  assert.deepEqual(await accessState(store, rawToken, Date.now(), key), { state: 'created', giftId: rec.giftId });
  assert.deepEqual(await accessState(store, rawToken), { state: 'created-elsewhere' });
  assert.deepEqual(await accessState(store, rawToken, Date.now(), newRecoveryKey()), { state: 'created-elsewhere' });

  const forwarded = await createGift(store, { rawToken, gift: giftPayload({ recipient: 'Mallory' }) });
  assert.equal(forwarded.status, 409);
  assert.equal(forwarded.body.state, 'created-elsewhere');
  assert.equal(forwarded.body.id, undefined);
  assert.equal(forwarded.recoveryKey, undefined);

  const again = await createGift(store, { rawToken, gift: giftPayload({ recipient: 'Someone else' }), recoveryKey: key });
  assert.equal(again.status, 409);
  assert.equal(again.body.state, 'created');
  assert.equal(again.body.id, rec.giftId);
  const stored = (await recordOf(store, rawToken));
  assert.ok(!JSON.stringify(stored).includes(key), 'only the hash of the recovery key is stored');
  assert.equal(giftKeys(store).length, 1);
  assert.equal(JSON.parse(store.map.get(giftPath(rec.giftId)).body).recipient, 'Lou');
});

test('fake, malformed and unknown tokens are rejected', async () => {
  const store = memoryStore();
  await issued(store);
  assert.deepEqual(await accessState(store, newToken()), { state: 'invalid' });
  assert.deepEqual(await accessState(store, ''), { state: 'invalid' });
  assert.equal((await createGift(store, { rawToken: newToken(), gift: giftPayload() })).status, 403);
  assert.equal((await createGift(store, { rawToken: '', gift: giftPayload() })).status, 400);
  assert.equal(giftKeys(store).length, 0);
});

test('20 concurrent creates on one link produce exactly one gift (100 interleavings)', async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const store = memoryStore({ random: seededRandom(seed), maxDelayMs: 4 });
    const { rawToken, rec } = await issued(store);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      createGift(store, { rawToken, gift: giftPayload({ sender: 'S' + i }) })));
    const ok = results.filter((r) => r.status === 201);
    assert.equal(giftKeys(store).length, 1, 'seed ' + seed);
    assert.ok(ok.length >= 1, 'seed ' + seed + ': someone must succeed');
    for (const r of results) {
      if (r.status === 201) assert.equal(r.body.id, rec.giftId);
      else { assert.equal(r.status, 409); assert.ok(['created', 'created-elsewhere', 'saving'].includes(r.body.state)); assert.equal(r.body.state === 'created-elsewhere' ? r.body.id : undefined, undefined); }
    }
    const stored = JSON.parse(store.map.get(giftPath(rec.giftId)).body);
    // Exactly one writer: all 201 responses describe the same saved gift.
    assert.equal(ok.length, 1, 'seed ' + seed + ': only one request may save the gift');
    assert.ok(stored.sender.startsWith('S'));
    assert.equal((await recordOf(store, rawToken)).status, 'used');
  }
});

test('crash right after claiming: shows saving, then a retry after the lease saves exactly once', async () => {
  const base = memoryStore();
  const { rawToken, rec } = await issued(base);
  let t = 1_000_000;
  const crashed = faultyStore(base, { dieAfterWrites: 1 });
  await createGift(crashed, { rawToken, gift: giftPayload(), now: () => t }).catch(() => {}); // the function dies
  assert.equal((await recordOf(base, rawToken)).status, 'creating');
  assert.equal(giftKeys(base).length, 0);

  assert.deepEqual(await accessState(base, rawToken, t + 1000), { state: 'saving' });
  const early = await createGift(base, { rawToken, gift: giftPayload(), now: () => t + 1000 });
  assert.equal(early.status, 409);
  assert.equal(early.body.state, 'saving');

  t += LEASE_MS + 1;
  assert.deepEqual(await accessState(base, rawToken, t), { state: 'unused' });
  const retry = await createGift(base, { rawToken, gift: giftPayload(), now: () => t });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, rec.giftId);
  assert.equal(giftKeys(base).length, 1);
  assert.equal((await recordOf(base, rawToken)).status, 'used');
});

test('crash after the gift is saved but before marking used: recovered immediately, never duplicated', async () => {
  const base = memoryStore();
  const { rawToken, rec } = await issued(base);
  const key = newRecoveryKey();
  const crashed = faultyStore(base, { dieAfterWrites: 2 }); // claim + gift save, then dead
  await createGift(crashed, { rawToken, gift: giftPayload(), recoveryKey: key }).catch(() => {});
  assert.equal((await recordOf(base, rawToken)).status, 'creating');
  // The buyer's browser already holds its key from the access check, so the crash cannot lock it out.
  assert.deepEqual(await accessState(base, rawToken, Date.now(), key), { state: 'created', giftId: rec.giftId });
  assert.deepEqual(await accessState(base, rawToken), { state: 'created-elsewhere' });

  const retry = await createGift(base, { rawToken, gift: giftPayload({ recipient: 'Other' }), recoveryKey: key });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.state, 'created');
  assert.equal(giftKeys(base).length, 1);
  assert.equal(JSON.parse(base.map.get(giftPath(rec.giftId)).body).recipient, 'Lou');
  assert.equal((await recordOf(base, rawToken)).status, 'used'); // finalized by the retry
});

test('lost response on the claim write: the request still completes exactly once', async () => {
  const base = memoryStore();
  const { rawToken } = await issued(base);
  const s = faultyStore(base, { faults: [{ op: 'replace', match: /^entitlements\//, mode: 'after', times: 1 }] });
  const r = await createGift(s, { rawToken, gift: giftPayload() });
  assert.equal(r.status, 201);
  assert.equal(giftKeys(base).length, 1);
  assert.equal((await recordOf(base, rawToken)).status, 'used');
});

test('lost response on the gift save: treated as saved, exactly one gift', async () => {
  const base = memoryStore();
  const { rawToken } = await issued(base);
  const s = faultyStore(base, { faults: [{ op: 'create', match: /^gifts\//, mode: 'after', times: 1 }] });
  const r = await createGift(s, { rawToken, gift: giftPayload() });
  assert.equal(r.status, 201);
  assert.equal(giftKeys(base).length, 1);
  assert.equal((await recordOf(base, rawToken)).status, 'used');
});

test('lost responses on every finalize attempt: buyer still sees created, a later call finalizes', async () => {
  const base = memoryStore();
  const { rawToken, rec } = await issued(base);
  // Make every finalize write fail before reaching storage (claim succeeds first).
  let claims = 0;
  const flaky = { ...base, replace: async (p, d, e) => { if (d.status === 'used') throw new Error('network'); claims++; return base.replace(p, d, e); } };
  const r = await createGift(flaky, { rawToken, gift: giftPayload() });
  assert.equal(r.status, 201);
  assert.equal(claims, 1);
  assert.equal((await recordOf(base, rawToken)).status, 'creating');
  assert.deepEqual(await accessState(base, rawToken, Date.now(), r.recoveryKey), { state: 'created', giftId: rec.giftId });
  const later = await createGift(base, { rawToken, gift: giftPayload() });
  assert.equal(later.status, 409);
  assert.equal((await recordOf(base, rawToken)).status, 'used');
  assert.equal(giftKeys(base).length, 1);
});

test('gift save fails outright: access is not consumed and can be retried after the lease', async () => {
  const base = memoryStore();
  const { rawToken } = await issued(base);
  let t = 5_000_000;
  const s = faultyStore(base, { faults: [{ op: 'create', match: /^gifts\//, mode: 'before', times: 1 }] });
  const r = await createGift(s, { rawToken, gift: giftPayload(), now: () => t });
  assert.equal(r.status, 503);
  assert.equal(giftKeys(base).length, 0);
  assert.notEqual((await recordOf(base, rawToken)).status, 'used');
  t += LEASE_MS + 1;
  const retry = await createGift(base, { rawToken, gift: giftPayload(), now: () => t });
  assert.equal(retry.status, 201);
  assert.equal(giftKeys(base).length, 1);
});

test('a claimant whose lease is nearly over does not start a save', async () => {
  const base = memoryStore();
  const { rawToken } = await issued(base);
  let t = 9_000_000;
  // Clock jumps forward between the claim and the save (e.g. a stalled function).
  let calls = 0;
  const now = () => (calls++ === 0 ? t : t + LEASE_MS - 1000);
  const r = await createGift(base, { rawToken, gift: giftPayload(), now });
  assert.equal(r.status, 409);
  assert.equal(giftKeys(base).length, 0);
});

test('revoke: unused links only; revoked links never create', async () => {
  const store = memoryStore();
  const a = await issued(store);
  const hashA = tokenHash(a.rawToken);
  assert.equal((await revokeEntitlement(store, hashA)).status, 200);
  assert.deepEqual(await accessState(store, a.rawToken), { state: 'revoked' });
  const c = await createGift(store, { rawToken: a.rawToken, gift: giftPayload() });
  assert.equal(c.status, 403);
  assert.equal(c.body.state, 'revoked');
  assert.equal(giftKeys(store).length, 0);
  assert.equal((await revokeEntitlement(store, hashA)).status, 200); // idempotent

  const b = await issued(store);
  await createGift(store, { rawToken: b.rawToken, gift: giftPayload() });
  assert.equal((await revokeEntitlement(store, tokenHash(b.rawToken))).status, 409);
  assert.equal((await revokeEntitlement(store, 'nothex')).status, 400);
  assert.equal((await revokeEntitlement(store, 'a'.repeat(64))).status, 404);
});

test('revoke racing create: exactly one wins (200 interleavings)', async () => {
  for (let seed = 1; seed <= 200; seed++) {
    const store = memoryStore({ random: seededRandom(seed), maxDelayMs: 4 });
    const { rawToken, rec } = await issued(store);
    const [rv, cr] = await Promise.all([
      revokeEntitlement(store, tokenHash(rawToken)),
      createGift(store, { rawToken, gift: giftPayload() })
    ]);
    const final = (await recordOf(store, rawToken)).status;
    const gifts = giftKeys(store).length;
    if (final === 'revoked') {
      assert.equal(gifts, 0, 'seed ' + seed);
      assert.equal(rv.status, 200);
      assert.notEqual(cr.status, 201);
    } else {
      assert.equal(final, 'used', 'seed ' + seed);
      assert.equal(gifts, 1);
      assert.equal(cr.status, 201);
      assert.equal(cr.body.id, rec.giftId);
      assert.equal(rv.status, 409);
    }
  }
});

test('legacy record marked used before its gift was saved: recoverable once after the lease window', async () => {
  const store = memoryStore();
  const rawToken = newToken();
  const hash = tokenHash(rawToken);
  const giftId = crypto.randomUUID();
  const t0 = Date.parse('2026-10-08T10:00:00Z');
  await store.create(entitlementPath(hash), { version: 1, tokenHash: hash, status: 'used', createdAt: '2026-10-08T09:59:00.000Z', usedAt: new Date(t0).toISOString(), giftId });

  assert.deepEqual(await accessState(store, rawToken, t0 + 1000), { state: 'saving' });
  assert.equal((await createGift(store, { rawToken, gift: giftPayload(), now: () => t0 + 1000 })).status, 409);

  const later = t0 + LEASE_MS + 1;
  assert.deepEqual(await accessState(store, rawToken, later), { state: 'unused' });
  const r = await createGift(store, { rawToken, gift: giftPayload(), now: () => later });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, giftId);
  const again = await createGift(store, { rawToken, gift: giftPayload(), now: () => later + 5 });
  assert.equal(again.status, 409);
  assert.equal(giftKeys(store).length, 1);
});

test('legacy records issued before this change (no reference field) keep working', async () => {
  const store = memoryStore();
  const rawToken = newToken();
  const hash = tokenHash(rawToken);
  const giftId = crypto.randomUUID();
  await store.create(entitlementPath(hash), { version: 1, tokenHash: hash, status: 'unused', createdAt: '2026-10-07T12:00:00.000Z', usedAt: null, giftId });
  const r = await createGift(store, { rawToken, gift: giftPayload() });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, giftId);
});

test('legacy used record whose gift exists recovers as created', async () => {
  const store = memoryStore();
  const rawToken = newToken();
  const hash = tokenHash(rawToken);
  const giftId = crypto.randomUUID();
  await store.create(entitlementPath(hash), { version: 1, tokenHash: hash, status: 'used', createdAt: '2026-10-07T12:00:00.000Z', usedAt: '2026-10-07T12:05:00.000Z', giftId });
  await store.create(giftPath(giftId), { version: 1, edition: 'son', id: giftId, recipient: 'A', sender: 'B', messages: Array(24).fill('x'), createdAt: '2026-10-07T12:05:00.000Z' });
  // Created before device-bound recovery existed: no recovery key, so the link alone reveals nothing.
  assert.deepEqual(await accessState(store, rawToken), { state: 'created-elsewhere' });
  const r = await createGift(store, { rawToken, gift: giftPayload() });
  assert.equal(r.status, 409);
  assert.equal(r.body.id, undefined);
});

test('owner history: statuses, references, gift links, and no tokens or letters', async () => {
  const store = memoryStore();
  const a = await issued(store, { reference: '#1' });
  const b = await issued(store, { reference: '#2' });
  const c = await issued(store, { reference: 'Bad <ref> & stuff' });
  await createGift(store, { rawToken: b.rawToken, gift: giftPayload() });
  await revokeEntitlement(store, tokenHash(c.rawToken));
  const rows = await entitlementHistory(store);
  assert.equal(rows.length, 3);
  const byRef = Object.fromEntries(rows.map((r) => [r.reference, r]));
  assert.equal(byRef['#1'].status, 'unused');
  assert.equal(byRef['#1'].giftPath, null);
  assert.equal(byRef['#2'].status, 'used');
  assert.equal(byRef['#2'].giftPath, '/?gift=' + b.rec.giftId);
  assert.equal(byRef['Bad ref  stuff'].status, 'revoked');
  const json = JSON.stringify(rows);
  for (const t of [a.rawToken, b.rawToken, c.rawToken]) assert.ok(!json.includes(t));
  assert.ok(!json.includes('Letter 1'));
});

test('one browser double-submitting (shared recovery key): exactly one gift and both see it', async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const store = memoryStore({ random: seededRandom(seed), maxDelayMs: 4 });
    const { rawToken, rec } = await issued(store);
    const key = newRecoveryKey();
    const results = await Promise.all([1, 2, 3].map(() => createGift(store, { rawToken, gift: giftPayload(), recoveryKey: key })));
    assert.equal(giftKeys(store).length, 1);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    for (const r of results) if (r.status === 409 && r.body.state === 'created') assert.equal(r.body.id, rec.giftId);
    assert.deepEqual(await accessState(store, rawToken, Date.now(), key), { state: 'created', giftId: rec.giftId });
  }
});
