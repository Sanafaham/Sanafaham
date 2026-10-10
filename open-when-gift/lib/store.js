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

// ----- storage credential selection (the ONLY place that reads storage env vars) -----------
//
// Which store a read-write token reaches: the pinned @vercel/blob SDK derives the store ID
// from the token itself (`token.split('_')[3]`) and uses it for the read URL host
// (<storeId>.private.blob.vercel-storage.com) and the x-vercel-blob-store-id header on writes.
// storeIdOfToken mirrors that exactly, and tests/sdk-store-binding.test.mjs fails if the
// installed SDK ever stops sending requests to the store this function reports.
// Vercel also records the owning store of each connected token variable in its project metadata.
const RW_PREFIX = 'vercel_blob_rw_';
const PREVIEW_TOKEN_VAR = 'OW_PREVIEW_READ_WRITE_TOKEN';
const PREVIEW_STORE_VAR = 'OW_PREVIEW_STORE_ID';

export class StorageConfigError extends Error {
  constructor(message) { super(message); this.name = 'StorageConfigError'; }
}

const bareStoreId = (id) => String(id || '').trim().replace(/^store_/, '');

// Returns the bare store ID of a read-write token, or '' when it cannot be determined.
export function storeIdOfToken(token) {
  if (typeof token !== 'string' || !token.startsWith(RW_PREFIX)) return '';
  const [, , , storeId = ''] = token.split('_');
  return /^[A-Za-z0-9]+$/.test(storeId) ? bareStoreId(storeId) : '';
}

// Picks the storage credentials for this deployment.
// Preview: only OW_PREVIEW_READ_WRITE_TOKEN, and only when it provably belongs to the store
//   named in OW_PREVIEW_STORE_ID and to a different store than the production token.
//   There is no fallback to BLOB_READ_WRITE_TOKEN; anything missing or unverifiable throws
//   before any storage request is made.
// Production and local: BLOB_READ_WRITE_TOKEN, exactly as before.
export function resolveStorage(env = process.env) {
  if (env.VERCEL_ENV === 'preview') {
    const token = env[PREVIEW_TOKEN_VAR] || '';
    const expected = bareStoreId(env[PREVIEW_STORE_VAR]);
    if (!token) throw new StorageConfigError('Preview storage token is not configured.');
    if (!expected) throw new StorageConfigError('Preview store ID is not configured.');
    const actual = storeIdOfToken(token);
    if (!actual) throw new StorageConfigError('Preview storage token cannot be verified.');
    if (actual !== expected) throw new StorageConfigError('Preview storage token does not belong to the Preview store.');
    const prodToken = env.BLOB_READ_WRITE_TOKEN || '';
    const prodIds = [bareStoreId(env.OPEN_WHEN_PRODUCTION_STORE_ID), storeIdOfToken(prodToken)].filter(Boolean);
    if ((prodToken && token === prodToken) || prodIds.includes(actual)) {
      throw new StorageConfigError('Preview deployments must not use the production Blob store.');
    }
    return { token, storeId: 'store_' + actual, environment: 'preview' };
  }
  const token = env.BLOB_READ_WRITE_TOKEN || '';
  if (!token) throw new StorageConfigError('Blob storage is not configured.');
  const id = storeIdOfToken(token);
  return { token, storeId: id ? 'store_' + id : null, environment: env.VERCEL_ENV || 'local' };
}

export function storeFromEnv(env = process.env) {
  return blobStore({ token: resolveStorage(env).token });
}
