// OPEN WHEN one-use access entitlements.
//
// Safety does not depend on separate Blob writes behaving like a transaction. It rests on
// three invariants that each individual write preserves:
//
//  1. One possible gift per entitlement. The gift ID is fixed when the entitlement is issued
//     and every save targets gifts/<giftId>.json. A second gift for one entitlement cannot exist.
//  2. An entitlement only becomes "used" after its gift exists. Paid access is never consumed
//     without a gift behind it. States: unused, creating (time-limited), used, revoked.
//  3. Only the request that wins the documented ifMatch (ETag) conditional write from
//     unused -> creating may save the gift. Losers report "saving" and later see "created".
//     allowOverwrite:false on the gift save is a secondary guard only.
//
// A "creating" claim expires after LEASE_MS. A claimant never starts its gift save once its own
// lease is close to expiry, and the save is aborted at lease expiry, so a takeover after expiry
// cannot overlap a live save. A crashed attempt is recovered by the next request after expiry.
import crypto from 'node:crypto';
import { ConflictError, ExistsError } from './store.js';

export const LEASE_MS = 120_000;
const SAVE_MARGIN_MS = 15_000;
const MAX_ACCESS_TOKEN = 160;
const MAX_REFERENCE = 40;

export function cleanAccessToken(value) {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_ACCESS_TOKEN).replace(/[^a-zA-Z0-9_-]/g, '')
    : '';
}
export function tokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export function cleanId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120).replace(/[^a-zA-Z0-9_-]/g, '') : '';
}
export function cleanReference(value) {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_REFERENCE).replace(/[^a-zA-Z0-9 #_.\-]/g, '').trim()
    : '';
}
export const entitlementPath = (hash) => 'entitlements/' + hash + '.json';
export const giftPath = (id) => 'gifts/' + id + '.json';

function validRecord(rec, hash) {
  return rec && rec.version === 1 && rec.tokenHash === hash && cleanId(rec.giftId);
}

// ----- issuance ---------------------------------------------------------------------------
export async function issueEntitlement(store, { rawToken, reference = '', now = Date.now() }) {
  const hash = tokenHash(rawToken);
  const record = {
    version: 1,
    tokenHash: hash,
    status: 'unused',
    createdAt: new Date(now).toISOString(),
    usedAt: null,
    giftId: crypto.randomUUID(),
    reference: cleanReference(reference) || null
  };
  await store.create(entitlementPath(hash), record);
  return record;
}

// ----- buyer access state -----------------------------------------------------------------
// Returns { state: 'unused' | 'created' | 'saving' | 'revoked' | 'invalid', giftId? }.
// Possession of the original access link is the recovery credential: a used link reveals its
// own gift ID (and therefore the same content the recipient link shows) but never creates.
export async function accessState(store, rawToken, now = Date.now()) {
  const token = cleanAccessToken(rawToken);
  if (!token) return { state: 'invalid' };
  const hash = tokenHash(token);
  const r = await store.read(entitlementPath(hash));
  if (!r || !validRecord(r.data, hash)) return { state: 'invalid' };
  const rec = r.data;
  const id = cleanId(rec.giftId);

  if (rec.status === 'unused') return { state: 'unused' };
  if (rec.status === 'revoked') return { state: 'revoked' };
  if (rec.status === 'used' || rec.status === 'creating') {
    if (await store.exists(giftPath(id))) return { state: 'created', giftId: id };
    if (rec.status === 'creating' && Date.parse(rec.leaseUntil) > now) return { state: 'saving' };
    if (rec.status === 'used' && !legacyUsedRecoverable(rec, now)) return { state: 'saving' };
    // Expired claim, or a legacy record marked used before its gift was saved: the buyer may
    // create (exactly once, at the same fixed gift ID).
    return { state: 'unused' };
  }
  return { state: 'invalid' };
}

function legacyUsedRecoverable(rec, now) {
  // Before this change, "used" was written before the gift save. If that crashed, the record
  // says used with no gift. Allow recovery only after the lease window has passed.
  const usedAt = Date.parse(rec.usedAt || rec.createdAt || 0);
  return Number.isFinite(usedAt) && now - usedAt > LEASE_MS;
}

// ----- gift creation ----------------------------------------------------------------------
// Returns { status, body }. Never creates more than one gift per entitlement.
export async function createGift(store, { rawToken, gift, now = () => Date.now(), attempt = crypto.randomUUID() }) {
  const token = cleanAccessToken(rawToken);
  if (!token) return { status: 400, body: { error: 'Invalid gift data.' } };
  const hash = tokenHash(token);
  const ePath = entitlementPath(hash);

  // Phase 1: claim the entitlement with a conditional write.
  let claimed = null;
  let id = '';
  for (let i = 0; i < 4 && !claimed; i++) {
    const r = await store.read(ePath);
    if (!r || !validRecord(r.data, hash)) return { status: 403, body: { error: 'This access link is not valid.' } };
    const rec = r.data;
    id = cleanId(rec.giftId);
    const t = now();

    if (rec.status === 'revoked') return { status: 403, body: { error: 'This access link has been cancelled.', state: 'revoked' } };
    if (rec.status === 'creating' && rec.attempt === attempt) { claimed = { rec, etag: r.etag }; break; }

    if (rec.status === 'used' || rec.status === 'creating') {
      if (await store.exists(giftPath(id))) {
        if (rec.status === 'creating') await finalize(store, ePath, null, t).catch(() => {});
        return { status: 409, body: { error: 'This access link has already been used.', state: 'created', id } };
      }
      const takeable = rec.status === 'creating' ? Date.parse(rec.leaseUntil) <= t : legacyUsedRecoverable(rec, t);
      if (!takeable) return { status: 409, body: { error: 'Your gift is still being saved.', state: 'saving' } };
    } else if (rec.status !== 'unused') {
      return { status: 403, body: { error: 'This access link is not valid.' } };
    }

    const next = { ...rec, status: 'creating', attempt, leaseUntil: new Date(t + LEASE_MS).toISOString() };
    try {
      const w = await store.replace(ePath, next, r.etag);
      claimed = { rec: next, etag: w.etag };
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        // Unknown outcome (e.g. lost response). Re-read on the next loop: if our attempt is
        // recorded we own the claim, otherwise we compete again from the fresh state.
      }
    }
  }
  if (!claimed) return { status: 409, body: { error: 'Your gift is still being saved.', state: 'saving' } };

  // Phase 2: save the gift once, at the fixed location, inside our lease.
  const leaseUntil = Date.parse(claimed.rec.leaseUntil);
  const gPath = giftPath(id);
  if (!(await store.exists(gPath))) {
    const remaining = leaseUntil - now();
    if (remaining < SAVE_MARGIN_MS) {
      return { status: 409, body: { error: 'Your gift is still being saved.', state: 'saving' } };
    }
    const record = { version: 1, edition: gift.edition, id, recipient: gift.recipient, sender: gift.sender, messages: gift.messages, createdAt: new Date(now()).toISOString() };
    try {
      await store.create(gPath, record, { abortSignal: AbortSignal.timeout(remaining - 5_000) });
    } catch (error) {
      if (!(error instanceof ExistsError)) {
        // Save failed or outcome unknown. If the gift is not there, leave the claim to expire;
        // the entitlement stays unconsumed and the buyer can retry after the lease.
        if (!(await store.exists(gPath).catch(() => false))) {
          return { status: 503, body: { error: 'I could not save this gift yet. Please try again in a few minutes.', state: 'saving' } };
        }
      }
    }
  }

  // Phase 3: mark used. Only reached once the gift exists (invariant 2).
  await finalize(store, ePath, attempt, now()).catch(() => {});
  return { status: 201, body: { ok: true, id } };
}

// Move creating -> used once the gift exists. Retries on version conflicts; tolerant of lost
// responses (a re-read showing "used" means done). `attempt` null finalizes any claim.
async function finalize(store, ePath, attempt, t) {
  for (let i = 0; i < 4; i++) {
    const r = await store.read(ePath);
    if (!r) return;
    const rec = r.data;
    if (rec.status === 'used') return;
    if (rec.status !== 'creating') return;
    if (attempt && rec.attempt !== attempt) return; // another attempt now owns finalization
    const next = { ...rec, status: 'used', usedAt: new Date(t).toISOString() };
    delete next.attempt; delete next.leaseUntil;
    try { await store.replace(ePath, next, r.etag); return; } catch (e) { /* re-read */ }
  }
}

// ----- owner operations -------------------------------------------------------------------
export async function revokeEntitlement(store, hash, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(hash || '')) return { status: 400, body: { error: 'Invalid link.' } };
  const ePath = entitlementPath(hash);
  for (let i = 0; i < 4; i++) {
    const r = await store.read(ePath);
    if (!r || !validRecord(r.data, hash)) return { status: 404, body: { error: 'Link not found.' } };
    const rec = r.data;
    if (rec.status === 'revoked') return { status: 200, body: { ok: true, status: 'revoked' } };
    if (rec.status !== 'unused') return { status: 409, body: { error: 'Only unused links can be revoked.', status: rec.status } };
    try {
      await store.replace(ePath, { ...rec, status: 'revoked', revokedAt: new Date(now).toISOString() }, r.etag);
    } catch (e) { continue; }
    const check = await store.read(ePath);
    if (check && check.data.status === 'revoked') return { status: 200, body: { ok: true, status: 'revoked' } };
  }
  return { status: 409, body: { error: 'This link changed while revoking. Refresh and try again.' } };
}

export async function entitlementHistory(store, now = Date.now()) {
  const paths = (await store.list('entitlements/')).filter((p) => /^entitlements\/[a-f0-9]{64}\.json$/.test(p));
  const rows = [];
  for (const p of paths) {
    const r = await store.read(p).catch(() => null);
    if (!r || !r.data || r.data.version !== 1) continue;
    const rec = r.data;
    const id = cleanId(rec.giftId);
    let status = rec.status;
    let giftExists = false;
    if (status === 'used' || status === 'creating') {
      giftExists = await store.exists(giftPath(id)).catch(() => false);
      if (giftExists) status = 'used';
      else if (status === 'creating' && Date.parse(rec.leaseUntil) > now) status = 'saving';
      else status = 'unused';
    }
    rows.push({
      id: rec.tokenHash,
      createdAt: rec.createdAt || null,
      reference: rec.reference || null,
      status,
      usedAt: giftExists ? (rec.usedAt || null) : null,
      revokedAt: rec.revokedAt || null,
      giftPath: giftExists && id ? '/?gift=' + encodeURIComponent(id) : null
    });
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows;
}
