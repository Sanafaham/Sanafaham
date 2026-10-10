// Test doubles for OPEN WHEN. The in-memory store mirrors the Blob adapter contract:
// create-if-absent, ETag-conditional replace, and random async delays so concurrent
// requests interleave between their reads and writes the way real network calls do.
// It is a model for logic tests only; real Blob behaviour is checked in real-storage.test.mjs.
import { ConflictError, ExistsError } from '../lib/store.js';

export function seededRandom(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function memoryStore({ random = seededRandom(7), maxDelayMs = 3 } = {}) {
  const map = new Map();
  let n = 0;
  const pause = () => new Promise((r) => setTimeout(r, Math.floor(random() * maxDelayMs)));
  const store = {
    map,
    writes: [],
    async read(p) { await pause(); const v = map.get(p); return v ? { data: JSON.parse(v.body), etag: v.etag } : null; },
    async exists(p) { await pause(); return map.has(p); },
    async create(p, d) {
      await pause();
      if (map.has(p)) throw new ExistsError();
      const etag = '"e' + (++n) + '"';
      map.set(p, { body: JSON.stringify(d), etag }); store.writes.push(['create', p]);
      return { etag };
    },
    async replace(p, d, etag) {
      await pause();
      const v = map.get(p);
      if (!v || v.etag !== etag) throw new ConflictError();
      const next = '"e' + (++n) + '"';
      map.set(p, { body: JSON.stringify(d), etag: next }); store.writes.push(['replace', p]);
      return { etag: next };
    },
    async remove(p) { await pause(); map.delete(p); },
    async list(prefix) { await pause(); return [...map.keys()].filter((k) => k.startsWith(prefix)); }
  };
  return store;
}

export class InjectedFault extends Error { constructor(m = 'injected fault') { super(m); this.name = 'InjectedFault'; } }

// Wrap a store with faults:
//  { op, match, mode: 'before' | 'after', times }  'after' = the write happens, then the response is lost.
//  dieAfterWrites: N  -> after N successful writes every further operation fails (simulated crash).
export function faultyStore(base, { faults = [], dieAfterWrites = Infinity } = {}) {
  let writes = 0;
  const dead = () => writes >= dieAfterWrites;
  const wrap = (op) => async (...args) => {
    if (dead()) throw new InjectedFault('process crashed');
    const f = faults.find((x) => x.op === op && (!x.match || x.match.test(args[0])) && (x.times ?? 1) > 0);
    if (f && f.mode === 'before') { f.times = (f.times ?? 1) - 1; throw new InjectedFault(); }
    const result = await base[op](...args);
    if (op === 'create' || op === 'replace') writes++;
    if (f && f.mode === 'after') { f.times = (f.times ?? 1) - 1; throw new InjectedFault('lost response'); }
    return result;
  };
  return { ...base, read: wrap('read'), exists: wrap('exists'), create: wrap('create'), replace: wrap('replace'), remove: wrap('remove'), list: wrap('list') };
}

export function mockReq({ method = 'GET', headers = {}, body, query = {} } = {}) {
  return { method, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body, query };
}
export function mockRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; return res; },
    status(c) { res.statusCode = c; return res; },
    json(o) { res.body = o; res.ended = true; return res; },
    end() { res.ended = true; return res; }
  };
  return res;
}

export const giftPayload = (over = {}) => ({
  edition: 'daughter', recipient: 'Lou', sender: 'Mama',
  messages: Array.from({ length: 24 }, (_, i) => 'Letter ' + (i + 1)), ...over
});

export function giftKeys(store) { return [...store.map.keys()].filter((k) => k.startsWith('gifts/')); }
