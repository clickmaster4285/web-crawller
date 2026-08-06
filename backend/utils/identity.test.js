/**
 * Tests for the identity helpers — the key-derivation contract the whole
 * change-detection + matching pipeline relies on (architecture §2.2).
 */
const { productIdentityKey, normalizeHost } = require('./identity');

describe('productIdentityKey', () => {
  test('GTIN wins over everything, digits-only', () => {
    expect(
      productIdentityKey({
        gtin: '0012345678905',
        sku: 'ABC-1',
        url: 'https://x/p/blue-tshirt'
      })
    ).toBe('gtin:0012345678905');
  });

  test('barcode alias works like gtin', () => {
    expect(productIdentityKey({ barcode: '0012345678905' })).toBe(
      'gtin:0012345678905'
    );
  });

  test('short GTIN is not trusted — falls to SKU', () => {
    expect(
      productIdentityKey({ gtin: '123', sku: 'Xyz-123', url: 'https://x/p/b' })
    ).toBe('sku:xyz123');
  });

  test('SKU normalized to lowercase alphanumeric', () => {
    expect(productIdentityKey({ sku: 'Xyz-123!', url: 'https://x/p/b' })).toBe(
      'sku:xyz123'
    );
  });

  test('slug used when no GTIN/SKU, lowercased', () => {
    expect(productIdentityKey({ url: 'https://x/p/Blue-Tshirt' })).toBe(
      'slug:blue-tshirt'
    );
  });

  test('generic short slug skipped — falls to url hash', () => {
    const key = productIdentityKey({ url: 'https://x/p' });
    expect(key).toMatch(/^url:[0-9a-f]{40}$/);
  });

  test('url-hash key is deterministic across calls', () => {
    const a = productIdentityKey({ url: 'https://x/p?color=red' });
    const b = productIdentityKey({ url: 'https://x/p?color=red' });
    expect(a).toBe(b);
  });
});

describe('normalizeHost', () => {
  test('strips protocol and www', () => {
    expect(normalizeHost('https://www.shop.example.com/x')).toBe(
      'shop.example.com'
    );
  });

  test('plain host passes through', () => {
    expect(normalizeHost('shop.example.com')).toBe('shop.example.com');
  });

  test('unparseable input falls back to string munging', () => {
    expect(normalizeHost('not a url')).toBe('not a url');
  });
});
