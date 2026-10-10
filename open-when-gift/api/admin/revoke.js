import { storeFromEnv } from '../../lib/store.js';
import { revokeEntitlement } from '../../lib/entitlements.js';
import { requireOwner } from '../../lib/owner-auth.js';
import { readBody } from '../../lib/http.js';

// Owner-only: cancel an unused access link. Revoked links can never create a gift.
export function makeRevokeHandler({ getStore = storeFromEnv, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    if (!requireOwner(req, res)) return;
    try {
      const body = await readBody(req);
      const result = await revokeEntitlement(getStore(), typeof body.id === 'string' ? body.id : '', now());
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('owner-revoke-failed', error && error.name);
      return res.status(500).json({ error: 'Could not revoke this link.' });
    }
  };
}

export default makeRevokeHandler();
