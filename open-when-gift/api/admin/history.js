import { storeFromEnv } from '../../lib/store.js';
import { entitlementHistory } from '../../lib/entitlements.js';
import { requireOwner } from '../../lib/owner-auth.js';

// Owner-only issuance history. Never returns raw access tokens or letter contents.
export function makeHistoryHandler({ getStore = storeFromEnv, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    if (!requireOwner(req, res)) return;
    try {
      const rows = await entitlementHistory(getStore(), now());
      return res.status(200).json({ ok: true, links: rows });
    } catch (error) {
      console.error('owner-history-failed', error && error.name);
      return res.status(500).json({ error: 'Could not load history.' });
    }
  };
}

export default makeHistoryHandler();
