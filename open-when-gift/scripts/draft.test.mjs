import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createDraftHandler } from '../api/draft.js';
import { deriveAccessToken } from '../api/redeem.js';

const accessToken = deriveAccessToken('test-secret', 'sale');
const otherToken = deriveAccessToken('test-secret', 'other-sale');
const hash = createHash('sha256').update(accessToken).digest('hex');
const entitlementPath = 'entitlements/' + hash + '.json';
const draftPath = 'drafts/' + hash + '.json';
const draft = { edition: 'son', recipient: '', sender: ' Mum ', messages: Array(24).fill('') };
draft.messages[8] = 'A personal note.\n';
const entitlement = { version: 1, status: 'unused', source: 'gumroad', tokenHash: hash };

function fixture(record = entitlement, { compressDraftReads = false } = {}) {
  const store = new Map([[entitlementPath, { data: JSON.stringify(record), etag: '"0"' }]]);
  let counter = 0;
  const blob = {
    async get(path, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      const item = store.get(path);
      if (!item) return null;
      const compressed = compressDraftReads && path === draftPath && options.headers?.['Accept-Encoding'] !== 'identity';
      const etag = compressed ? 'W/' + item.etag : item.etag;
      return { statusCode: 200, blob: { etag }, stream: new Response(item.data).body };
    },
    async put(path, data, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      assert.ok(!data.includes(accessToken));
      const current = store.get(path);
      if (current ? options.ifMatch !== current.etag : options.allowOverwrite !== false) {
        throw new Error('Conditional write failed');
      }
      const result = { data, etag: '"' + ++counter + '"' };
      store.set(path, result);
      return result;
    }
  };
  const handler = createDraftHandler({ blob, env: { BLOB_READ_WRITE_TOKEN: 'mock' } });
  async function call(method, fields = {}, token = accessToken) {
    const res = { setHeader(name, value) { if (name === 'Cache-Control') this.cache = value; } };
    res.status = code => { res.code = code; return res; };
    res.json = body => { res.body = body; };
    await handler({ method, body: { accessToken: token, ...fields } }, res);
    assert.equal(res.cache, 'no-store');
    return res;
  }
  return { blob, store, call };
}

test('a second device restores the exact unfinished edition, names and letters', async () => {
  const { call, store } = fixture();
  assert.deepEqual((await call('POST')).body, { draft: null, revision: null });
  const saved = await call('PUT', { draft, revision: null });
  assert.equal(saved.code, 200);
  assert.deepEqual((await call('POST')).body, { draft, revision: saved.body.revision });
  assert.equal(store.size, 2);
  assert.equal(JSON.parse(store.get(entitlementPath).data).status, 'unused');
});

test('another buyer, missing token, manual links and completed gifts cannot load or save drafts', async () => {
  const { call } = fixture();
  for (const method of ['POST', 'PUT']) {
    assert.equal((await call(method, { draft, revision: null }, otherToken)).code, 403);
    assert.equal((await call(method, { draft, revision: null }, '')).code, 403);
    const manual = fixture({ ...entitlement, source: undefined });
    assert.equal((await manual.call(method, { draft, revision: null })).code, 403);
    const completed = fixture({ ...entitlement, status: 'used' });
    assert.equal((await completed.call(method, { draft, revision: null })).code, 409);
  }
  assert.equal((await call('GET')).code, 405);
});

test('malformed or oversized drafts cannot be written', async () => {
  const { call, store } = fixture();
  for (const invalid of [{ edition: 'either' }, { sender: 'a'.repeat(41) }, { messages: [] }, { messages: Array(24).fill('a'.repeat(4001)) }]) {
    assert.equal((await call('PUT', { draft: { ...draft, ...invalid }, revision: null })).code, 400);
  }
  assert.equal(store.has(draftPath), false);
});

test('simultaneous first saves and stale updates never overwrite a newer draft', async () => {
  const { call } = fixture();
  const first = await Promise.all([call('PUT', { draft, revision: null }), call('PUT', { draft, revision: null })]);
  assert.deepEqual(first.map(item => item.code).sort(), [200, 409]);
  const { revision } = (await call('POST')).body;
  const newer = { ...draft, recipient: 'New name' };
  assert.equal((await call('PUT', { draft: newer, revision })).code, 200);
  const stale = await call('PUT', { draft, revision });
  assert.deepEqual(stale.body, { conflict: true });
  assert.equal(stale.code, 409);
  assert.deepEqual((await call('POST')).body.draft, newer);
});

test('read or write failure returns 500 and retains the last saved draft', async () => {
  const { call, blob } = fixture();
  const { revision } = (await call('PUT', { draft, revision: null })).body;
  blob.put = async () => { throw new Error('offline'); };
  assert.equal((await call('PUT', { draft: { ...draft, recipient: 'New' }, revision })).code, 500);
  assert.deepEqual((await call('POST')).body.draft, draft);
  blob.get = async () => { throw new Error('offline'); };
  assert.equal((await call('POST')).code, 500);
});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const client = html.slice(html.indexOf('const draftControls='), html.indexOf('makeLink.onclick=async()=>'));

function creator(fetch) {
  const status = {};
  const resumeLink = { hidden: true };
  const controls = new Map([['draftStatus', status], ['draftResumeLink', resumeLink]]);
  const input = value => ({ value, addEventListener() {} });
  const context = {
    AbortSignal, accessToken, fetch,
    els(id) {
      if (!controls.has(id)) controls.set(id, {});
      return controls.get(id);
    },
    window: { addEventListener() {} },
    edition: 'daughter', recipientInput: input('Lina'), senderInput: input('Mum'), customMessages: draft.messages,
    setTimeout() {}, clearTimeout() {},
    editionDaughter: {}, editionSon: {}, makeLink: {}, personalize: {},
    sonLetters: [], daughterLetters: [], applyEdition() {}, renderPersonalizer() {}
  };
  runInNewContext(client + '\ndraftEnabled=true; globalThis.save=finishLater.onclick; globalThis.restore=restoreDraft; globalThis.change=draftChanged; globalThis.autosave=saveDraft;', context);
  return { status, resumeLink, save: context.save, restore: context.restore, context };
}

test('Save and finish later waits for confirmation and allows retry after failure', async () => {
  let complete;
  const page = creator(() => new Promise(resolve => { complete = resolve; }));
  const pending = page.save();
  assert.match(page.status.textContent, /Saving your draft/);
  complete(Response.json({ code: 'draft-update' }, { status: 500 }));
  await pending;
  assert.match(page.status.textContent, /could not be saved.*Code: draft-update/);
  assert.equal(page.resumeLink.hidden, true);
  const retry = page.save();
  complete(Response.json({ revision: '"1"' }));
  await retry;
  assert.match(page.status.textContent, /Save your Gumroad license key or keep your receipt.*enter the same key/);
  assert.equal(page.resumeLink.hidden, false);
  assert.match(html, /id="draftResumeLink" href="\/"[^>]*>Resume your Open When gift<\/a>/);
  page.context.change();
  assert.equal(page.resumeLink.hidden, true);
});

test('load failure keeps editing locked and a successful restore fills the fields', async () => {
  const failed = creator(async () => new Response('{}', { status: 500 }));
  await failed.restore();
  assert.equal(failed.context.recipientInput.inert, true);
  assert.match(failed.status.textContent, /could not be loaded/);

  const page = creator(async () => Response.json({ draft, revision: '"1"' }));
  await page.restore();
  assert.equal(page.context.edition, 'son');
  assert.equal(page.context.senderInput.value, draft.sender);
  assert.deepEqual(page.context.customMessages, draft.messages);
  assert.equal(page.context.recipientInput.inert, false);
});

test('an autosave acknowledgment never describes newer edits as saved', async () => {
  let complete;
  const page = creator(() => new Promise(resolve => { complete = resolve; }));
  page.context.change();
  const first = page.context.autosave();
  page.context.recipientInput.value = 'New name';
  page.context.change();
  complete(Response.json({ revision: '"1"' }));
  await first;
  assert.equal(page.status.textContent, 'Unsaved changes…');
  const latest = page.context.autosave();
  complete(Response.json({ revision: '"2"' }));
  await latest;
  assert.equal(page.status.textContent, 'Draft saved.');
});

test('the same unfinished entitlement supports repeated save, resume, edit and save', async () => {
  const { call, store } = fixture();
  for (let edit = 0; edit < 5; edit++) {
    const loaded = await call('POST');
    assert.equal(loaded.code, 200);
    if (edit > 0) assert.equal(loaded.body.draft.messages[0], 'Revision ' + (edit - 1));
    const next = structuredClone(loaded.body.draft ?? draft);
    next.messages[0] = 'Revision ' + edit;
    const saved = await call('PUT', { draft: next, revision: loaded.body.revision });
    assert.equal(saved.code, 200);
    assert.deepEqual((await call('POST')).body.draft, next);
  }
  assert.equal(JSON.parse(store.get(entitlementPath).data).status, 'unused');
});

test('compressed Blob reads cannot break repeated draft updates with both names empty', async () => {
  const { call } = fixture(entitlement, { compressDraftReads: true });
  const unfinished = { ...draft, recipient: '', sender: '', messages: Array(24).fill('A personalized letter. '.repeat(30)) };
  const initial = await call('PUT', { draft: unfinished, revision: null });
  assert.equal(initial.code, 200);

  let revision = 'W/' + initial.body.revision; // An already-open tab may still hold the old wire revision.
  for (let edit = 1; edit <= 3; edit++) {
    unfinished.messages[0] = 'Edit ' + edit;
    const updated = await call('PUT', { draft: unfinished, revision });
    assert.equal(updated.code, 200);
    const resumed = await call('POST');
    assert.deepEqual(resumed.body.draft, unfinished);
    assert.equal(resumed.body.revision, updated.body.revision);
    revision = resumed.body.revision;
  }
  assert.equal((await call('PUT', { draft: unfinished, revision: 'W/' + initial.body.revision })).code, 409);
});
