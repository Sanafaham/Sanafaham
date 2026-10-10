// Owner authentication for the OPEN WHEN owner page.
//
// - The admin secret (OPEN_WHEN_ADMIN_SECRET) is only ever compared on the server. The owner
//   types it into a plain HTML form that posts directly to /api/admin/session.
// - Sessions are stateless signed cookies: HMAC-SHA256 with a key derived from the secret,
//   24-hour expiry, HttpOnly, Secure, SameSite=Strict, Path=/api/admin. Rotating the secret
//   invalidates every session.
// - Every owner request must be same-origin (Origin, or Sec-Fetch-Site as a fallback).
//   State-changing JSON calls also require the X-Open-When-Owner header, which a cross-site
//   page cannot send without a CORS preflight that this API never approves.
// - Login attempts are rate limited with counters stored privately in Blob, updated with
//   conditional writes. A slot is reserved before the password is checked; if the reservation
//   cannot be recorded, the attempt is refused (fail closed).
import crypto from 'node:crypto';
import { ConflictError, ExistsError } from './store.js';

export const SESSION_COOKIE = 'ow_owner';
export const SESSION_TTL_S = 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;
export const OWNER_HEADER = 'x-open-when-owner';

export const IP_LIMIT = 5;
export const IP_WINDOW_MS = 15 * 60 * 1000;
export const GLOBAL_LIMIT = 30;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

export function adminSecret() {
  const s = process.env.OPEN_WHEN_ADMIN_SECRET || '';
  return s;
}
export function secretIsStrong(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

export function timingSafeEqualText(a, b) {
  // Hash first so the comparison is fixed-length and leaks neither content nor length.
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(left, right) && String(a || '').length > 0;
}

function sessionKey(secret) {
  return crypto.createHmac('sha256', secret).update('open-when-owner-session-v1').digest();
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createSession(secret, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64(JSON.stringify({ v: 1, iat, exp: iat + SESSION_TTL_S, n: crypto.randomBytes(12).toString('base64url') }));
  const sig = b64(crypto.createHmac('sha256', sessionKey(secret)).update(payload).digest());
  return payload + '.' + sig;
}

export function verifySession(secret, value, nowMs = Date.now()) {
  if (!secretIsStrong(secret) || typeof value !== 'string' || value.length > 512) return false;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return false;
  const expected = b64(crypto.createHmac('sha256', sessionKey(secret)).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(nowMs / 1000);
    return data.v === 1 && Number.isInteger(data.exp) && data.exp > now && data.iat <= now + 60 && data.exp - data.iat <= SESSION_TTL_S;
  } catch { return false; }
}

export function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`;
}
export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function header(req, name) {
  const h = req.headers || {};
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function isSameOrigin(req) {
  const host = header(req, 'x-forwarded-host') || header(req, 'host');
  const origin = header(req, 'origin');
  if (origin && origin !== 'null') {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  // Origin omitted (same-origin GET) or "null" (privacy-sensitive contexts): rely on Fetch Metadata.
  return header(req, 'sec-fetch-site') === 'same-origin';
}

export function hasOwnerSession(req, nowMs = Date.now()) {
  const cookies = parseCookies(header(req, 'cookie'));
  return verifySession(adminSecret(), cookies[SESSION_COOKIE], nowMs);
}

// Owner JSON endpoints: valid session + same origin + custom header.
export function requireOwner(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!secretIsStrong(adminSecret())) {
    res.status(503).json({ error: 'Owner access is disabled until the admin secret is at least 32 characters.' });
    return false;
  }
  if (!isSameOrigin(req) || header(req, OWNER_HEADER) !== '1') {
    res.status(403).json({ error: 'Forbidden.' });
    return false;
  }
  if (!hasOwnerSession(req)) {
    res.status(401).json({ error: 'Please log in.' });
    return false;
  }
  return true;
}

export function clientIp(req) {
  const real = header(req, 'x-real-ip');
  if (real) return String(real).trim();
  const fwd = header(req, 'x-forwarded-for');
  return fwd ? String(fwd).split(',')[0].trim() : 'unknown';
}

// ----- login rate limiting ----------------------------------------------------------------
async function reserveSlot(store, path, limit, windowMs, nowMs) {
  for (let i = 0; i < 4; i++) {
    const r = await store.read(path);
    const times = (r && Array.isArray(r.data.attempts) ? r.data.attempts : []).filter((t) => nowMs - t < windowMs);
    if (times.length >= limit) return 'limited';
    const next = { attempts: [...times, nowMs] };
    try {
      if (r) await store.replace(path, next, r.etag);
      else await store.create(path, next);
      return 'ok';
    } catch (e) {
      if (e instanceof ConflictError || e instanceof ExistsError) continue;
      // Unknown outcome: re-read and see whether our timestamp landed.
      const check = await store.read(path).catch(() => null);
      if (check && Array.isArray(check.data.attempts) && check.data.attempts.includes(nowMs)) return 'ok';
    }
  }
  return 'unavailable';
}

export async function reserveLoginAttempt(store, req, secret, nowMs = Date.now()) {
  const ipKey = crypto.createHmac('sha256', sessionKey(secret || 'none')).update(clientIp(req)).digest('hex').slice(0, 32);
  const globalResult = await reserveSlot(store, 'owner-auth/global.json', GLOBAL_LIMIT, GLOBAL_WINDOW_MS, nowMs);
  if (globalResult !== 'ok') return globalResult;
  return reserveSlot(store, 'owner-auth/ip-' + ipKey + '.json', IP_LIMIT, IP_WINDOW_MS, nowMs);
}
