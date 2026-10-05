import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/gifts.js', import.meta.url), 'utf8');

const failures = [];
const requireIn = (source, marker, name) => {
  if (!source.includes(marker)) failures.push(name);
};

const htmlRules = [
  // Core gift/card surface
  ['24-card two-column grid', '.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}'],
  ['card minimum height', '.open-card{min-height:170px'],
  ['opened-card fixed overlay', '.letter-panel.show{'],
  ['opened-card fixed positioning', 'position:fixed;'],
  ['opened-card viewport height', 'height:calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 40px)'],
  ['opened-card max height', 'max-height:760px'],
  ['opened-card refined gold top line', 'border-top:1px solid #b79a5e'],
  ['opened-card light shadow', 'box-shadow:0 10px 26px rgba(70,48,54,.055)'],

  // Flip: RIGHT opening is settled and protected.
  ['right-edge flip hinge', 'transform-origin:right center'],
  ['Safari right-edge flip hinge', '-webkit-transform-origin:right center'],
  ['3D flip support', 'transform-style:preserve-3d'],
  ['flip animation class', '.letter-sheet.flip-opening'],
  ['flip keyframes', '@keyframes openKeepsake'],
  ['right-opening initial angle', 'rotateY(82deg) translateX(10px)'],
  ['right-opening settle overshoot', 'rotateY(-7deg) translateX(0)'],
  ['explicit flip replay helper', 'function replayCardFlip(panel)'],
  ['flip restarts on every normal card open', 'replayCardFlip(letterPanel)'],
  ['flip restarts on final card open', 'replayCardFlip(lastPanel)'],

  // Typography / visual hierarchy
  ['Cormorant opened-letter typography', 'font-family:"Cormorant Garamond",Georgia,serif'],
  ['italic luxury title', '.letter-title{'],
  ['tiny OPEN WHEN mark', 'class="letter-open-mark"'],
  ['centered floral divider', 'class="letter-divider"'],
  ['flower stalk', 'class="letter-floral"'],
  ['dynamic sender reminder line', 'id="fromLine"'],
  ['back to cards control', 'id="closeLetter"'],

  // Opened-state and navigation
  ['opened state persists locally', 'localStorage.setItem(storageKey'],
  ['opened state reads locally', 'localStorage.getItem(storageKey)'],
  ['back-to-cards restores scroll', 'window.scrollTo({top:cardsScrollY, behavior:\'auto\'})'],
  ['opened counter', "count.textContent = opened.size + ' of 24 opened'"],

  // Creator / receiver separation
  ['creator setup exists', 'id="setup"'],
  ['Daughter edition selector', 'id="editionDaughter"'],
  ['Son edition selector', 'id="editionSon"'],
  ['Son visual theme class', 'body.son-edition{'],
  ['Son navy hero', 'body.son-edition .hero-box{background:linear-gradient(180deg,#2f4666 0%,#243a57 100%)}'],
  ['Son leaf botanical asset', 'class="son-botanical"'],
  ['Daughter botanical remains separate', 'class="sprig daughter-botanical"'],
  ['Son theme activates only by edition', "document.body.classList.toggle('son-edition', isSon)"],
  ['edition switcher', "function switchEdition(nextEdition)"],
  ['Daughter edition remains available', "nextEdition !== 'daughter' && nextEdition !== 'son'"],
  ['Son edition changes recipient label', '"Son\'s" : "Daughter\'s"'],
  ['saved gift restores edition', "edition = gift.edition === 'son' ? 'son' : 'daughter'"],
  ['receiver hides creator controls', "setup.style.display = 'none'"],
  ['receiver shows finished gift', "giftExperience.style.display = 'block'"],
  ['sender preview exists', 'Sender preview'],

  // Personalization: compact, optional, one-at-a-time
  ['personalization is optional', 'Personalize the letters <span>Optional</span>'],
  ['compact personalization rows', 'class="edit-letter-toggle"'],
  ['only one personalization row stays open', "personalizeList.querySelectorAll('.edit-letter.open')"],
  ['original status', "status.textContent = isPersonalized ? 'Personalized' : 'Original'"],
  ['reset only after edits', '.edit-letter.is-personalized .reset-letter{display:inline-block}'],
  ['reset to original behavior', "customMessages[i] = letters[i][1]"],
  ['done personalizing action', 'id="donePersonalizing"'],
  ['done personalizing closes editor', 'personalizeDetails.open = false'],
  ['done personalizing leads to create', "makeGiftButton.scrollIntoView({behavior:'smooth', block:'center'})"],
  ['sticky done control', '.done-personalizing-wrap{position:sticky'],

  // Gift creation / sharing
  ['create gift action', 'id="makeLink"'],
  ['sender required validation', "Please enter who the gift is from."],
  ['gift save request', "fetch('/api/gifts'"],
  ['gift id in share link', "url.searchParams.set('gift', giftId)"],
  ['WhatsApp share', "https://wa.me/?text="],
  ['Messages share', "sms:&body="],
  ['Email share', "mailto:?subject="],
  ['native share', 'navigator.share'],

  // Home-screen keep flow remains present
  ['keep gift on phone prompt', 'Keep this gift on your phone'],
  ['iPhone add-to-home-screen guidance', 'Add to Home Screen'],
  ['Android add-to-home-screen guidance', 'Add to Home screen']
];

for (const [name, marker] of htmlRules) requireIn(html, marker, name);

const apiRules = [
  ['Blob token stays server-side', 'process.env.BLOB_READ_WRITE_TOKEN'],
  ['private Blob write', "access: 'private'"],
  ['private Blob read', "get('gifts/' + id + '.json'"],
  ['gift payload versioned', 'version: 1'],
  ['edition validated server-side', "body.edition === 'son' ? 'son' : (body.edition === 'daughter' ? 'daughter' : '')"],
  ['edition persisted server-side', 'edition,'],
  ['recipient required', 'const recipient = safeText(body.recipient'],
  ['sender required', 'const sender = safeText(body.sender'],
  ['exactly 24 saved messages', 'messages.length !== 24'],
  ['server-side input limits', 'const MAX_TEXT = 4000'],
  ['gift endpoint no-store', "res.setHeader('Cache-Control', 'no-store')"]
];

for (const [name, marker] of apiRules) requireIn(api, marker, name);

// Protect the exact number of built-in cards in both launch editions.
for (const [label, startMarker, endMarker] of [
  ['Daughter', 'const daughterLetters = [', 'const sonLetters = ['],
  ['Son', 'const sonLetters = [', 'const qs = new URLSearchParams']
]) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    failures.push(label + ' letters array exists');
  } else {
    const block = html.slice(start, end);
    const count = (block.match(/^\["/gm) || []).length;
    if (count !== 24) failures.push(label + ' edition has exactly 24 built-in letters (found ' + count + ')');
  }
}

// Protect approved content canaries in both editions.
requireIn(html, 'Some days are simply awful.\\n\\nYou do not have to find the lesson in it tonight. You do not have to pretend you are fine.\\n\\nGet through today.\\n\\nTomorrow gets a fresh chance.\\n\\nAnd remember, one bad day has never changed who you are.', 'approved shared first-letter copy');
requireIn(html, 'You do not have to be strong every minute.', 'approved Son edition strength letter');
requireIn(html, 'You are my \' + edition + \'.', 'edition-specific final keepsake relationship');

// Protect against accidentally bringing back the old manifest/query-loss risk.
if (html.includes('<link rel="manifest"')) failures.push('manifest must remain absent until gift-token-safe start_url exists');

if (failures.length) {
  console.error('\nOPEN WHEN PROTECTED BASELINE FAILED\n');
  for (const failure of failures) console.error(' - ' + failure);
  console.error('\nDo not ship this change until the regression is fixed or the owner explicitly approves changing the protected baseline.\n');
  process.exit(1);
}

console.log('OPEN WHEN protected baseline passed: ' + (htmlRules.length + apiRules.length + 2) + ' safeguards verified.');
