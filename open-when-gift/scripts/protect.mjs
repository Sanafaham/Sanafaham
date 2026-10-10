import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/gifts.js', import.meta.url), 'utf8');
const accessApi = fs.readFileSync(new URL('../api/access.js', import.meta.url), 'utf8');
const adminAccessApi = fs.readFileSync(new URL('../api/admin/access.js', import.meta.url), 'utf8');
const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const storeLib = read('lib/store.js');
const entLib = read('lib/entitlements.js');
const authLib = read('lib/owner-auth.js');
const sessionApi = read('api/admin/session.js');
const historyApi = read('api/admin/history.js');
const revokeApi = read('api/admin/revoke.js');
const ownerHtml = read('owner.html');

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
  ['done button iOS light text', '-webkit-text-fill-color:#f5f1e9!important'],
  ['create gift', 'id="makeLink"'],
  ['save endpoint', "fetch('/api/gifts'"],
  ['load endpoint', "fetch('/api/gifts?id="],
  ['creator access token', "qs.get('access')"],
  ['creator access validation (token in POST body, not URL)', "fetch('/api/access',{method:'POST'"],
  ['buyer gift recovery', 'async function recoverGift(id)'],
  ['recovered view hides creation controls', ".setup.recovered > :not(.share):not(.save-status){display:none!important}"],
  ['saving state', 'function showSaving()'],
  ['share box built with text nodes', 'function renderShare(giftUrl)'],
  ['no-referrer policy', '<meta name="referrer" content="no-referrer">'],
  ['home screen in-app browser guidance', 'First open it in Safari (iPhone) or Chrome (Android).'],
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
  ['unsafe share rendering', 'share.innerHTML'],
  ['access token in request URL', "fetch('/api/access?token="],
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

const checks = [
  // Gift API: validation and the unchanged recipient GET path
  [api, "accessToken = cleanAccessToken(body.accessToken)", 'gift creation access token'],
  [api, "createGift(store, { rawToken: accessToken", 'gift creation goes through the entitlement'],
  [api, "readGift('gifts/' + id + '.json', token)", 'recipient gift loads by opaque gift ID'],
  // Entitlement protection: conditional writes, fixed gift ID, used only after the gift exists
  [storeLib, 'ifMatch: etag', 'documented ETag conditional writes'],
  [storeLib, 'BlobPreconditionFailedError', 'conditional write conflicts detected'],
  [storeLib, 'allowOverwrite: false', 'gift save never overwrites (secondary guard)'],
  [storeLib, "access: 'private'", 'private blob storage'],
  [storeLib, 'useCache: false', 'consistent reads'],
  [entLib, "status: 'creating', attempt", 'entitlement claimed by conditional write'],
  [entLib, "status: 'used', usedAt", 'entitlement consumed only at finalize'],
  [entLib, "if (rec.status === 'revoked') return { status: 403", 'revoked links never create'],
  [entLib, 'const gPath = giftPath(id);', 'one fixed gift location per entitlement'],
  [entLib, "await finalize(store, ePath, attempt, now())", 'finalize after the gift exists'],
  [entLib, 'AbortSignal.timeout(remaining - 5_000)', 'gift save bounded by the lease'],
  [entLib, "crypto.createHash('sha256')", 'only token hashes are stored'],
  [accessApi, 'accessState(store, raw, now())', 'access check reports unused/created/saving/revoked'],
  [accessApi, "(await readBody(req)).token", 'access token accepted in POST body'],
  // Owner issuance
  [adminAccessApi, 'process.env.OPEN_WHEN_ADMIN_SECRET', 'protected access issuer'],
  [adminAccessApi, 'crypto.randomBytes(32)', 'cryptographically random access token'],
  [adminAccessApi, "req.headers['x-open-when-admin']", 'original secret-header issuance kept'],
  [adminAccessApi, 'hasOwnerSession(req, now())', 'owner session issuance'],
  [authLib, 'HttpOnly; Secure; SameSite=Strict', 'owner cookie flags'],
  [authLib, 'SESSION_TTL_S = 24 * 60 * 60', '24-hour owner session'],
  [authLib, 'MIN_SECRET_LENGTH = 32', 'admin secret strength requirement'],
  [authLib, "createHmac('sha256', sessionKey(secret))", 'signed owner sessions'],
  [authLib, 'export function isSameOrigin(req)', 'cross-site request protection'],
  [authLib, "header(req, OWNER_HEADER) !== '1'", 'owner header required'],
  [authLib, "return 'unavailable';", 'login rate limiter fails closed'],
  [sessionApi, 'reserveLoginAttempt(getStore(), req, secret, now())', 'login rate limited before password check'],
  [historyApi, 'requireOwner(req, res)', 'history is owner-only'],
  [revokeApi, 'requireOwner(req, res)', 'revoke is owner-only'],
  [ownerHtml, '<form method="post" action="/api/admin/session">', 'password posted by plain form'],
  [ownerHtml, '<meta name="robots" content="noindex,nofollow">', 'owner page not indexed'],
  [ownerHtml, '<meta name="referrer" content="same-origin">', 'owner page never sends a referrer off-site'],
];
for (const [src, needle, name] of checks) {
  if (!src.includes(needle)) { console.error('MISSING:', name); failed = true; }
}
const ownerScript = (ownerHtml.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];
const forbiddenSrc = [
  [ownerHtml, '<script src', 'third-party or external script on owner page'],
  [ownerScript, "'password'", 'owner page script touching the password field'],
  [ownerScript, '.innerHTML', 'owner page innerHTML rendering'],
  [entLib + storeLib + authLib, 'Math.random', 'non-cryptographic randomness in security code'],
];
for (const [src, needle, name] of forbiddenSrc) {
  if (src.includes(needle)) { console.error('FORBIDDEN:', name); failed = true; }
}

if (failed) process.exit(1);
console.log('Open When protected baseline checks passed.');
