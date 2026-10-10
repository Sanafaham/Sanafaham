import { resolveStorage } from '../../lib/store.js';
import { requireOwner } from '../../lib/owner-auth.js';

// Owner-only, read-only storage identity check. Reports which Blob store this deployment
// would use, and nothing else: never a token, never part of one. Makes no storage request.
export function makeStoreIdentityHandler({ resolve = resolveStorage } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    if (!requireOwner(req, res)) return;
    try {
      const { storeId, environment } = resolve();
      return res.status(200).json({ ok: true, environment, storeId });
    } catch (error) {
      // Configuration messages name variables, never values.
      const message = error && error.name === 'StorageConfigError' ? error.message : 'Storage configuration could not be verified.';
      return res.status(503).json({ ok: false, error: message });
    }
  };
}

export default makeStoreIdentityHandler();
