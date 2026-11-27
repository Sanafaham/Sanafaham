import { get, put } from '@vercel/blob';
import { createHash } from 'node:crypto';

function validDraft(draft) {
  return draft && ['daughter', 'son'].includes(draft.edition)
    && typeof draft.recipient === 'string' && draft.recipient.length <= 40
    && typeof draft.sender === 'string' && draft.sender.length <= 40
    && Array.isArray(draft.messages) && draft.messages.length === 24
    && draft.messages.every(message => typeof message === 'string' && message.length <= 4000);
}

export function createDraftHandler({ blob, env }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' && req.method !== 'PUT') {
      res.setHeader('Allow', 'POST, PUT');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const token = env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({ error: 'Draft storage is unavailable.' });

    const { accessToken, draft, revision } = req.body || {};
    if (typeof accessToken !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(accessToken)) {
      return res.status(403).json({ error: 'This access link is not valid for drafts.' });
    }

    const hash = createHash('sha256').update(accessToken).digest('hex');
    const pathname = 'drafts/' + hash + '.json';
    const options = { access: 'private', token };
    const read = async path => {
      // Compressed Blob responses carry weak ETags, which conditional writes reject.
      const headers = path === pathname ? { 'Accept-Encoding': 'identity' } : undefined;
      const result = await blob.get(path, { ...options, useCache: false, headers });
      if (!result) return null;
      if (result.statusCode !== 200) throw new Error('Private blob read failed');
      return result;
    };

    let stage = 'entitlement-read';
    try {
      const entitlementBlob = await read('entitlements/' + hash + '.json');
      const entitlement = entitlementBlob && await new Response(entitlementBlob.stream).json();
      if (!entitlement || entitlement.version !== 1 || entitlement.tokenHash !== hash || entitlement.source !== 'gumroad') {
        return res.status(403).json({ error: 'This access link is not valid for drafts.' });
      }
      if (entitlement.status !== 'unused') {
        return res.status(409).json({ error: 'This gift can no longer be edited. Enter your license key again to reopen it.' });
      }

      if (req.method === 'POST') {
        stage = 'draft-read';
        const existing = await read(pathname);
        if (!existing) return res.status(200).json({ draft: null, revision: null });
        const saved = await new Response(existing.stream).json();
        if (saved.version !== 1 || !validDraft(saved) || !existing.blob.etag) throw new Error('Invalid stored draft');
        const { edition, recipient, sender, messages } = saved;
        return res.status(200).json({ draft: { edition, recipient, sender, messages }, revision: existing.blob.etag });
      }

      if (!validDraft(draft) || !(revision === null || (typeof revision === 'string' && revision.length > 0 && revision.length <= 256 && !/[*,\r\n]/.test(revision)))) {
        return res.status(400).json({ error: 'Invalid draft data.', code: 'invalid-draft' });
      }

      // Older tabs may still hold the compressed response's weak form of this tag.
      const writeRevision = typeof revision === 'string' ? revision.replace(/^W\/(?="[^"]+"$)/, '') : null;
      const { edition, recipient, sender, messages } = draft;
      stage = revision === null ? 'draft-create' : 'draft-update';
      try {
        const saved = await blob.put(pathname, JSON.stringify({ version: 1, edition, recipient, sender, messages }), {
          ...options,
          contentType: 'application/json',
          addRandomSuffix: false,
          ...(revision === null ? { allowOverwrite: false } : { ifMatch: writeRevision })
        });
        if (!saved.etag) {
          stage = 'draft-revision-missing';
          throw new Error('Draft revision missing');
        }
        return res.status(200).json({ revision: saved.etag });
      } catch (error) {
        const current = await read(pathname);
        const currentRevision = current?.blob.etag ?? null;
        await current?.stream.cancel();
        if (currentRevision !== writeRevision) {
          return res.status(409).json({ conflict: true });
        }
        throw error;
      }
    } catch (error) {
      console.error('open-when-draft-failure', stage, error?.constructor?.name);
      return res.status(500).json({ error: 'Your draft could not be accessed. Please try again.', code: stage });
    }
  };
}

export default createDraftHandler({ blob: { get, put }, env: process.env });
