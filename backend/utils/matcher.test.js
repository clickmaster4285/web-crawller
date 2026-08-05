/**
 * Temporary fixture test for `matchCatalogues` (deleted after running).
 */
const { matchCatalogues } = require('./matcher');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — ${detail}`);
  if (!ok) failures++;
}

const mine = [
  { name: 'Wireless Mouse', sku: 'WIDGET-1', gtin: '0621148211434', url: 'https://a.com/products/wireless-mouse', price: 100 },
  { name: 'Mechanical Keyboard', sku: 'KBD-102', gtin: '', url: 'https://a.com/products/mechanical-keyboard', price: 200 },
  { name: '4K Monitor', sku: '', gtin: '9876543210987', url: 'https://a.com/products/4k-monitor', price: 300 },
  { name: 'USB-C Cable 2m', sku: '', gtin: '', url: 'https://a.com/products/usb-c-cable-2m', price: 10 },
  { name: 'Laptop Stand', sku: '', gtin: '', url: 'https://a.com/products/stand', price: 40 },
  { name: 'Gaming Headset', sku: '', gtin: '', url: 'https://a.com/products/headset', price: 80 },
];

const theirs = [
  { name: 'Wireless Mouse', sku: 'WIDGET-1', gtin: '0621148211434', url: 'https://b.com/p/123', price: 120 },   // GTIN + SKU → GTIN wins
  { name: 'Mech Keyboard Pro', sku: 'KBD-102', gtin: '', url: 'https://b.com/p/456', price: 210 },             // SKU match
  { name: '4K Ultra Monitor', sku: '', gtin: '9876543210987', url: 'https://b.com/p/789', price: 280 },        // GTIN match
  { name: 'USB C Cable 2m', sku: '', gtin: '', url: 'https://b.com/p/abc', price: 12 },                        // fuzzy name
  { name: 'Laptop Stand', sku: '', gtin: '', url: 'https://b.com/p/stand', price: 45 },                        // slug match
  { name: 'Only They Sell Widget', sku: 'THEIR-X1', gtin: '', url: 'https://b.com/p/xyz', price: 99 },         // unmatched
  { name: 'Gaming Headset RGB', sku: '', gtin: '', url: 'https://b.com/p/rgb', price: 85 },                    // fuzzy for headset
];

const { matched, onlyMine, onlyTheirs } = matchCatalogues(mine, theirs);
const methodOf = (name) => matched.find((p) => p.mine.name === name)?.method ?? null;

check('GTIN tier wins over SKU', methodOf('Wireless Mouse') === 'GTIN', `got ${methodOf('Wireless Mouse')}`);
check('SKU tier', methodOf('Mechanical Keyboard') === 'SKU', `got ${methodOf('Mechanical Keyboard')}`);
check('GTIN tier (barcode)', methodOf('4K Monitor') === 'GTIN', `got ${methodOf('4K Monitor')}`);
check('URL slug tier', methodOf('Laptop Stand') === 'URL slug', `got ${methodOf('Laptop Stand')}`);
check('fuzzy tier', methodOf('USB-C Cable 2m') === 'AI similarity', `got ${methodOf('USB-C Cable 2m')}`);
check('fuzzy confidence', matched.find((p) => p.mine.name === 'USB-C Cable 2m')?.confidence >= 80, `got ${matched.find((p) => p.mine.name === 'USB-C Cable 2m')?.confidence}`);
check('each product matches once', matched.length === 6, `matched ${matched.length}`);
check('onlyMine empty', onlyMine.length === 0, `got ${onlyMine.length}: ${onlyMine.map((m) => m.name).join(', ')}`);
check('onlyTheirs = 1', onlyTheirs.length === 1 && onlyTheirs[0].name === 'Only They Sell Widget', `got ${onlyTheirs.length}: ${onlyTheirs.map((t) => t.name).join(', ')}`);

// Priority: a taken GTIN falls through — competitor already matched by GTIN
// to another of our products; this one's GTIN points at a used product, so
// its SKU tier should not re-match it.
const dup = matchCatalogues(
  [
    { name: 'Product A', sku: 'A-1', gtin: '1111111111111', url: 'https://a.com/p/a' },
    { name: 'Product B', sku: 'A-1', gtin: '2222222222222', url: 'https://a.com/p/b' },
  ],
  [
    { name: 'Their A', sku: 'X', gtin: '1111111111111', url: 'https://b.com/p/a' },
    { name: 'Their B', sku: 'A-1', gtin: '', url: 'https://b.com/p/b' },
  ]
);
check('taken GTIN falls through to SKU', dup.matched.length === 2, `matched ${dup.matched.length}: ${dup.matched.map((m) => `${m.mine.name}=${m.method}`).join(', ')}`);

// Greedy: identical SKUs — first of ours wins, second stays onlyMine.
const greedy = matchCatalogues(
  [
    { name: 'Mouse Red', sku: 'M-1', gtin: '', url: 'https://a.com/p/red' },
    { name: 'Mouse Blue', sku: 'M-1', gtin: '', url: 'https://a.com/p/blue' },
  ],
  [{ name: 'The Mouse', sku: 'M-1', gtin: '', url: 'https://b.com/p/mouse' }]
);
check('greedy one-to-one', greedy.matched.length === 1 && greedy.onlyMine.length === 1, `matched ${greedy.matched.length}, onlyMine ${greedy.onlyMine.length}`);

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : `${failures} FAILURES ❌`}`);
process.exit(failures === 0 ? 0 : 1);
