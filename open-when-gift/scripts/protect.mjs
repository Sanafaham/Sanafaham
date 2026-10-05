import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/gifts.js', import.meta.url), 'utf8');

const required = [
  ['card flip keyframes', '@keyframes openKeepsake'],
  ['explicit flip replay', 'replayCardFlip(letterPanel)'],
  ['flip class', 'flip-opening'],
  ['fixed opened-card geometry', 'height:calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 40px)'],
  ['back-to-cards scroll restore', 'window.scrollTo({top:cardsScrollY'],
  ['personalization accordion', 'Personalize the letters'],
  ['done personalizing', 'Done personalizing'],
  ['reset original', 'Reset to original'],
  ['private gift save endpoint', "fetch('/api/gifts'"],
  ['private Blob write', "access: 'private'"],
  ['private Blob read', "get('gifts/' + id + '.json'"]
];

const failures = [];
for (const [name, marker] of required) {
  const source = name.includes('Blob') ? api : html;
  if (!source.includes(marker)) failures.push(name);
}

if (failures.length) {
  console.error('OPEN WHEN protected behavior regression:', failures.join(', '));
  process.exit(1);
}

console.log('OPEN WHEN protected behavior checks passed.');
