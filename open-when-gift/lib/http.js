// Small request helpers shared by the OPEN WHEN API functions.
export async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let text = '';
  if (typeof req.body === 'string') text = req.body;
  else if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8');
  else if (req.readable) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200_000) break;
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text) return {};
  const type = String((req.headers && req.headers['content-type']) || '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return {}; }
}

export function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// Device-bound buyer recovery key. HttpOnly so page scripts never see it; sent only to /api.
export const RECOVERY_COOKIE = 'ow_recovery';
const RECOVERY_MAX_AGE_S = 365 * 24 * 60 * 60;
export function recoveryCookie(value) {
  return `${RECOVERY_COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${RECOVERY_MAX_AGE_S}`;
}
export function readCookie(req, name) {
  const header = String((req.headers && req.headers.cookie) || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
