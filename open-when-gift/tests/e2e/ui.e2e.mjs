// Browser checks for the buyer and owner journeys at phone size.
// Run locally: npm i --no-save playwright && node tests/e2e/ui.e2e.mjs
// Uses the local test server (in-memory storage only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';
import { giftKeys } from '../helpers.mjs';

const SECRET = 'owner-' + 'k'.repeat(40);
process.env.OPEN_WHEN_ADMIN_SECRET = SECRET;
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_localtest_x';

const shots = process.env.SHOTS_DIR || '';
const server = await startServer();
const base = 'http://localhost:' + server.address().port;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ': ' + e.message]); } };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: shots + '/' + name + '.png', fullPage: false }); };

async function issue() {
  const r = await fetch(base + '/api/admin/access', { method: 'POST', headers: { 'x-open-when-admin': SECRET } });
  return (await r.json()).accessPath;
}

const evil = '<img src=x onerror=window.__xss=1>Lou&co'; // fits the 40-character field
let accessPath, giftUrl;

await check('buyer creates a gift; unusual name renders as plain text; no script runs', async () => {
  accessPath = await issue();
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  const referers = [];
  page.on('request', (req) => { const h = req.headers(); if (!req.url().startsWith(base)) referers.push([req.url(), h.referer || '']); });
  await page.goto(base + accessPath);
  await page.fill('#recipient', evil);
  await page.fill('#sender', 'Mama');
  await page.click('#makeLink');
  await page.waitForSelector('#share.show');
  const sub = await page.textContent('.share-sub');
  assert.ok(sub.includes(evil), 'name shown literally');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.$('#share img'), null);
  assert.equal(dialogs.length, 0);
  giftUrl = await page.getAttribute('.share-actions .primary-link', 'href');
  assert.match(giftUrl, /\/\?gift=[a-f0-9-]{36}$/);
  for (const [, ref] of referers) assert.equal(ref, '', 'no referrer to third parties');
  await shot(page, '1-created');
  await ctx.close();
});

await check('access token never appears in an API request URL', async () => {
  const apiWithToken = server.requests.filter((r) => r.url.startsWith('/api/') && r.url.includes(accessPath.split('=')[1]));
  assert.deepEqual(apiWithToken, []);
});

await check('refresh / reopen on another device recovers the same gift and share controls; no create form', async () => {
  const ctx = await browser.newContext(phone); // fresh browser: no cookies, no storage
  const page = await ctx.newPage();
  await page.goto(base + accessPath);
  await page.waitForSelector('#share.show');
  assert.equal(await page.getAttribute('.share-actions .primary-link', 'href'), giftUrl);
  assert.equal(await page.isVisible('#makeLink'), false);
  assert.equal(await page.isVisible('#recipient'), false);
  assert.equal(await page.isVisible('#personalize'), false);
  assert.ok((await page.textContent('#saveStatus')).includes('already created'));
  assert.equal(await page.isVisible('#previewNote'), true);
  assert.equal(await page.isVisible('#giftExperience'), true);
  await shot(page, '2-recovered');
  await page.reload();
  await page.waitForSelector('#share.show');
  assert.equal(await page.isVisible('#makeLink'), false);
  assert.equal(giftKeys(server.store).length, 1);
  await ctx.close();
});

await check('recipient link shows only the gift', async () => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(giftUrl);
  await page.waitForSelector('#grid .envelope-card');
  assert.equal(await page.isVisible('#setup'), false);
  assert.equal(await page.isVisible('#share'), false);
  assert.equal(await page.isVisible('#previewNote'), false);
  assert.equal((await page.$$('#grid .envelope-card')).length, 24);
  assert.ok((await page.textContent('#kicker')).includes('Mama'));
  await page.click('.keep-card summary');
  const keep = await page.textContent('.keep-card');
  assert.ok(keep.includes('First open it in Safari (iPhone) or Chrome (Android).'));
  await shot(page, '3-recipient-keep');
  await ctx.close();
});

await check('invalid and revoked links show a clear message and no form', async () => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(base + '/?access=notarealtoken');
  await page.waitForSelector('main h1');
  assert.equal(await page.textContent('main h1'), 'This access link cannot be used.');
  await ctx.close();
});

await check('owner page: login, issue, copy, history, revoke, logout', async () => {
  const ctx = await browser.newContext({ ...phone });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  await page.goto(base + '/owner.html');
  await page.waitForSelector('#loginCard:not(.hidden)');
  await shot(page, '4-owner-login');
  await page.fill('#password', 'wrong-password');
  await page.click('#loginCard button[type=submit]');
  await page.waitForSelector('#loginMsg:has-text("did not work")');
  await page.fill('#password', SECRET);
  await page.click('#loginCard button[type=submit]');
  await page.waitForSelector('#ownerApp:not(.hidden)');
  const cookies = await ctx.cookies(base + '/api/admin/history');
  const c = cookies.find((x) => x.name === 'ow_owner');
  assert.ok(c && c.httpOnly && c.sameSite === 'Strict' && c.secure, 'cookie flags');
  assert.equal(await page.evaluate(() => document.cookie.includes('ow_owner')), false, 'not readable by JS');

  await page.fill('#reference', '#1042');
  await page.click('#issueBtn');
  await page.waitForSelector('#linkOut.show');
  const link = await page.textContent('#linkBox');
  assert.match(link, /\/\?access=[A-Za-z0-9_-]{43}$/);
  await page.click('#copyBtn');
  await page.waitForSelector('#copyBtn:has-text("Copied")');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
  await page.waitForSelector('#history .item');
  const hist = await page.textContent('#history');
  assert.ok(hist.includes('#1042') && hist.includes('Unused') && hist.includes('Used'));
  await shot(page, '5-owner-issued');

  const item = page.locator('#history .item', { hasText: '#1042' });
  await item.locator('button.danger').click();
  await item.locator('button.danger:has-text("Tap again")').click();
  await page.waitForSelector('#history .item:has-text("#1042") .pill.revoked');
  await shot(page, '6-owner-revoked');

  const buyer = await browser.newContext(phone);
  const bp = await buyer.newPage();
  await bp.goto(link);
  await bp.waitForSelector('main h1');
  assert.ok((await bp.textContent('main')).includes('cancelled'));
  await buyer.close();

  await page.click('button:has-text("Log out")');
  await page.waitForSelector('#loginCard:not(.hidden)');
  await ctx.close();
});

await browser.close();
server.close();
for (const [s, n] of results) console.log(s + '  ' + n);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? failed + ' FAILED' : 'ALL UI CHECKS PASSED');
if (shots) fs.writeFileSync(shots + '/results.txt', results.map((r) => r.join('  ')).join('\n'));
process.exit(failed ? 1 : 0);
