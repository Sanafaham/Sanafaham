import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/gifts.js', import.meta.url), 'utf8');
const accessApi = fs.readFileSync(new URL('../api/access.js', import.meta.url), 'utf8');
const adminAccessApi = fs.readFileSync(new URL('../api/admin/access.js', import.meta.url), 'utf8');

const required = [
  ['stable ivory paper', '--paper:#EFECE4'],
  ['stable ivory page', '--paper-soft:#E7E2D8'],
  ['stable deep green', '--green:#3F4745'],
  ['stable ink', '--ink:#24211F'],
  ['Safari texture tiles disabled', 'SAFARI STABILITY LOCK — no embedded texture tiles'],
  ['approved dragonfly asset', '--dragonfly:url("/dragonfly-reference.svg?v=7")'],
  ['envelope cards', 'envelope-card'],
  ['dragonfly seal', 'class="seal"'],
  ['daughter letters', 'const daughterLetters = ['],
  ['son letters', 'const sonLetters = ['],
  ['personalization', 'id="personalize"'],
  ['done personalizing', 'id="donePersonalizing"'],
  ['done button iOS white text', '-webkit-text-fill-color:#fff!important'],
  ['create gift', 'id="makeLink"'],
  ['save endpoint', "fetch('/api/gifts'"],
  ['load endpoint', "fetch('/api/gifts?id="],
  ['creator access token', "qs.get('access')"],
  ['creator access validation', "fetch('/api/access?token="],
  ['gift save sends access token', 'messages:customMessages,accessToken'],
  ['WhatsApp share', 'https://wa.me/'],
  ['email share', 'mailto:?subject='],
  ['message share', 'sms:&body='],
  ['native share', 'navigator.share'],
  ['opened-state save', 'localStorage.setItem(storageKey'],
  ['opened-state load', 'localStorage.getItem(storageKey'],
  ['letter panel', 'id="letterPanel"'],
  ['final keepsake panel', 'id="lastPanel"'],
  ['final keepsake card', 'final-keepsake-card'],
  ['edition-specific final line', "You are my '+edition+'."],
  ['final card refreshes edition', "els('openLast').onclick=()=>{\n  applyEdition();"],
  ['final text visible on small iPhones', '#lastPanel .letter-body{overflow:visible}'],
  ['page opens left-to-right', 'transform-origin:left center'],
  ['home icon', '/open-when-icon.png?v=6'],
];

let failed = false;
for (const [name, needle] of required) {
  if (!html.includes(needle)) {
    console.error('MISSING:', name);
    failed = true;
  }
}

const forbidden = [
  ['embedded paper texture regression', '--paper-texture:url("data:image/'],
  ['old embedded dragonfly regression', '--dragonfly:url("data:image/'],
  ['old brown paper token', '--paper:#c9c3b8'],
  ['old green token', '--green:#373b3a'],
];
for (const [name, needle] of forbidden) {
  if (html.includes(needle)) {
    console.error('FORBIDDEN:', name);
    failed = true;
  }
}

if (!api.includes("access: 'private'")) {
  console.error('MISSING: private blob storage');
  failed = true;
}
if (!api.includes("edition = body.edition === 'son'")) {
  console.error('MISSING: edition persistence');
  failed = true;
}
if (!api.includes('messages.length !== 24')) {
  console.error('MISSING: 24-message validation');
  failed = true;
}

if (!api.includes("accessToken = cleanAccessToken(body.accessToken)")) {
  console.error('MISSING: gift creation access token');
  failed = true;
}
if (!api.includes("entitlement.status !== 'unused'")) {
  console.error('MISSING: used entitlement rejection');
  failed = true;
}
if (!api.includes("status: 'used'")) {
  console.error('MISSING: entitlement consumption');
  failed = true;
}
if (!api.includes("allowOverwrite: false")) {
  console.error('MISSING: atomic fixed-path entitlement lock');
  failed = true;
}
if (!api.includes("allowOverwrite: true")) {
  console.error('MISSING: explicit entitlement state overwrite');
  failed = true;
}
if (!accessApi.includes("entitlement.status !== 'unused'")) {
  console.error('MISSING: access validation rejects used links');
  failed = true;
}
if (!adminAccessApi.includes("process.env.OPEN_WHEN_ADMIN_SECRET")) {
  console.error('MISSING: protected access issuer');
  failed = true;
}
if (!adminAccessApi.includes("crypto.randomBytes(32)")) {
  console.error('MISSING: cryptographically random access token');
  failed = true;
}

if (failed) process.exit(1);
console.log('Open When protected baseline checks passed.');
