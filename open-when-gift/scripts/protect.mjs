import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/gifts.js', import.meta.url), 'utf8');

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
  ['page opens left-to-right', 'transform-origin:left center'],
  ['home icon', '/open-when-icon.png?v=4'],
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

if (failed) process.exit(1);
console.log('Open When protected baseline checks passed.');
