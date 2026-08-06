/**
 * Unit tests for the Phase 5 store read-path helpers (utils/readPath.js).
 */
const {
  encodeCursor,
  decodeCursor,
  cursorFilter,
  escapeRegex,
  clampInt,
  parseIsoDate,
  parseStoreKey
} = require('./readPath');

describe('readPath cursor encode/decode', () => {
  const ID = '64b000000000000000000001';

  test('round-trips a valid cursor', () => {
    const encoded = encodeCursor(1700000000000, ID);
    expect(decodeCursor(encoded)).toEqual({ tsMs: 1700000000000, id: ID });
  });

  test('rejects malformed cursors', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('abc|notanid', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('NaN|' + ID, 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(123)).toBeNull();
  });

  test('cursorFilter merges a decoded cursor onto the base filter', () => {
    const encoded = encodeCursor(1700000000000, ID);
    const f = cursorFilter(encoded, 'lastSeenAt', { key: 'shop.example.com' });
    expect(f.key).toBe('shop.example.com');
    expect(f.$or).toEqual([
      { lastSeenAt: { $lt: new Date(1700000000000) } },
      { lastSeenAt: new Date(1700000000000), _id: { $lt: ID } }
    ]);
  });

  test('cursorFilter with no/garbage cursor returns the base filter untouched', () => {
    expect(cursorFilter(undefined, 'at', { key: 'k' })).toEqual({ key: 'k' });
    expect(cursorFilter('garbage', 'at', { key: 'k' })).toEqual({ key: 'k' });
  });
});

describe('readPath parsing helpers', () => {
  test('escapeRegex neutralizes regex metacharacters', () => {
    expect(escapeRegex('nike (air) [2024] +$')).toBe(
      'nike \\(air\\) \\[2024\\] \\+\\$'
    );
    expect(escapeRegex('plain-name')).toBe('plain-name');
  });

  test('clampInt clamps and falls back', () => {
    expect(clampInt('50', 50, 1, 200)).toBe(50);
    expect(clampInt('0', 50, 1, 200)).toBe(50); // below min → fallback
    expect(clampInt('999', 50, 1, 200)).toBe(200); // above max → clamp
    expect(clampInt('abc', 25, 1, 200)).toBe(25);
    expect(clampInt(undefined, 25, 1, 200)).toBe(25);
  });

  test('parseIsoDate accepts dates and rejects garbage', () => {
    expect(parseIsoDate('2026-01-01T00:00:00Z')).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(parseIsoDate('not-a-date')).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });

  test('parseStoreKey validates normalized hosts', () => {
    expect(parseStoreKey('shop.example.com')).toBe('shop.example.com');
    expect(parseStoreKey('Shop.Example.COM ')).toBe('shop.example.com');
    expect(parseStoreKey('a.b.c')).toBe('a.b.c');
    // Single-label hosts are valid keys (normalizeHost('http://localhost:3000')
    // writes 'localhost') — the reader must accept what the writer produces.
    expect(parseStoreKey('localhost')).toBe('localhost');
    expect(parseStoreKey('intranet')).toBe('intranet');
    expect(parseStoreKey('https://shop.example.com')).toBeNull();
    expect(parseStoreKey('shop.example.com/path')).toBeNull();
    expect(parseStoreKey('shop.example.com:3000')).toBeNull();
    expect(parseStoreKey('')).toBeNull();
    expect(parseStoreKey(undefined)).toBeNull();
    expect(parseStoreKey('bad_host')).toBeNull();
  });
});
