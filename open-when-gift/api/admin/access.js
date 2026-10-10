import crypto from 'node:crypto';
import { storeFromEnv } from '../../lib/store.js';
import { issueEntitlement } from '../../lib/entitlements.js';
import { readBody, baseHeaders } from '../../lib/http.js';
import { timingSafeEqualText, secretIsStrong, isSameOrigin, hasOwnerSession, OWNER_HEADER } from '../../lib/owner-auth.js';

// Issues a one-use creation link.
// Two ways in:
//  1. The original protected method: X-Open-When-Admin header carrying OPEN_WHEN_ADMIN_SECRET
//     (kept unchanged until the owner page is fully verified).
//  2. The owner page: a valid signed owner session cookie, same origin, plus X-Open-When-Owner: 1.
export function makeAdminAccessHandler({ getStore = storeFromEnv, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    baseHeaders(res);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const adminSecret = process.env.OPEN_WHEN_ADMIN_SECRET;
    if (!blobToken || !adminSecret) return res.status(500).json({ error: 'Access issuing is not configured.' });

    const supplied = req.headers['x-open-when-admin'];
    const headerOk = typeof supplied === 'string' && supplied.length > 0 && timingSafeEqualText(supplied, adminSecret);
    const sessionOk = !headerOk && secretIsStrong(adminSecret) && isSameOrigin(req)
      && req.headers[OWNER_HEADER] === '1' && hasOwnerSession(req, now());
    if (!headerOk && !sessionOk) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    try {
      const body = await readBody(req);
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const record = await issueEntitlement(getStore(), { rawToken, reference: body.reference, now: now() });

      return res.status(201).json({
        ok: true,
        accessToken: rawToken,
        accessPath: '/?access=' + encodeURIComponent(rawToken),
        reference: record.reference
      });
    } catch (error) {
      console.error('access-issue-failed', error && error.name);
      return res.status(500).json({ error: 'Could not issue an access link.' });
    }
  };
}

export default makeAdminAccessHandler();
