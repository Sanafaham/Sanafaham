// Private Blob storage adapter for OPEN WHEN.
//
// Every write can be ambiguous: the SDK retries requests internally, so a write that
// succeeded on the server can still surface as an error here. Callers must therefore
// treat write errors as "unknown outcome" and re-read before deciding what happened.
//
// Conditional replacement uses Vercel Blob's documented `ifMatch` ETag check
// (BlobPreconditionFailedError on mismatch). Creation uses `allowOverwrite: false`
// only as a secondary guard; correctness never depends on it being atomic.
import { get, put, del, list, BlobPreconditionFailedError } from '@vercel/blob';

export class ConflictError extends Error {
  constructor(message = 'Version conflict.') { super(message); this.name = 'ConflictError'; }
}
export class ExistsError extends Error {
  constructor(message = 'Already exists.') { super(message); this.name = 'ExistsError'; }
}

export function blobStore({ token, prefix = '' } = {}) {
  if (!token) throw new Error('Blob storage is not configured.');
  const p = (pathname) => prefix + pathname;

  async function read(pathname) {
    const result = await get(p(pathname), { access: 'private', token, useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return { data: JSON.parse(text), etag: result.blob && result.blob.etag };
  }

  async function exists(pathname) {
    return (await read(pathname)) !== null;
  }

  async function create(pathname, data, { abortSignal } = {}) {
    try {
      const r = await put(p(pathname), JSON.stringify(data), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: false,
        token,
        abortSignal
      });
      return { etag: r.etag };
    } catch (error) {
      // Unknown outcome: check whether the blob is there now.
      const now = await read(pathname).catch(() => null);
      if (now) throw new ExistsError();
      throw error;
    }
  }

  async function replace(pathname, data, etag) {
    if (!etag) throw new ConflictError('Missing version.');
    try {
      const r = await put(p(pathname), JSON.stringify(data), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        ifMatch: etag,
        token
      });
      return { etag: r.etag };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ConflictError();
      throw error;
    }
  }

  async function remove(pathname) {
    await del(p(pathname), { token });
  }

  async function listPaths(listPrefix) {
    const out = [];
    let cursor;
    do {
      const page = await list({ prefix: p(listPrefix), cursor, limit: 1000, token });
      for (const b of page.blobs) out.push(prefix ? b.pathname.slice(prefix.length) : b.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  return { read, exists, create, replace, remove, list: listPaths };
}

// Read-write tokens look like vercel_blob_rw_<storeId>_<secret>; the SDK parses them the same way.
export function storeIdOfToken(token) {
  const [, , , storeId = ''] = String(token || '').split('_');
  return storeId.startsWith('store_') ? storeId.slice('store_'.length) : storeId;
}

// Defence in depth: a Preview deployment refuses to use the production store if
// OPEN_WHEN_PRODUCTION_STORE_ID is configured (store IDs are identifiers, not secrets).
export function storeFromEnv(env = process.env) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  const prodId = (env.OPEN_WHEN_PRODUCTION_STORE_ID || '').replace(/^store_/, '');
  if (env.VERCEL_ENV === 'preview' && prodId && storeIdOfToken(token) === prodId) {
    throw new Error('Preview deployments must not use the production Blob store.');
  }
  return blobStore({ token });
}
