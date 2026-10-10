import { storeFromEnv } from '../lib/store.js';
import { accessState } from '../lib/entitlements.js';
import { readBody, baseHeaders } from '../lib/http.js';

// Buyer access check.
// POST { token } is used by the current page so access tokens never appear in request URLs.
// GET ?token= is kept only so pages loaded before this release keep their old behaviour.
export function makeAccessHandler({ getStore = storeFromEnv, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    baseHeaders(res);
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    let store;
    try { store = getStore(); } catch { return res.status(500).json({ error: 'Gift storage is not configured.' }); }

    try {
      const raw = req.method === 'POST' ? (await readBody(req)).token : req.query?.token;
      if (!raw) return res.status(400).json({ error: 'Missing access token.' });
      const s = await accessState(store, raw, now());

      if (req.method === 'GET') {
        // Legacy contract: only an unused link is valid.
        if (s.state === 'unused') return res.status(200).json({ valid: true });
        if (s.state === 'invalid' || s.state === 'revoked') return res.status(403).json({ valid: false, error: 'This access link is not valid.' });
        return res.status(409).json({ valid: false, error: 'This access link has already been used.' });
      }

      switch (s.state) {
        case 'unused': return res.status(200).json({ valid: true, state: 'unused' });
        case 'created': return res.status(200).json({ valid: false, state: 'created', giftId: s.giftId });
        case 'saving': return res.status(200).json({ valid: false, state: 'saving' });
        case 'revoked': return res.status(403).json({ valid: false, state: 'revoked', error: 'This access link has been cancelled.' });
        default: return res.status(403).json({ valid: false, state: 'invalid', error: 'This access link is not valid.' });
      }
    } catch (error) {
      console.error('access-check-failed', error && error.name);
      return res.status(500).json({ error: 'Could not verify this access link.' });
    }
  };
}

export default makeAccessHandler();
