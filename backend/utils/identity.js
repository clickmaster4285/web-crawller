/**
 * Identity helpers for the normalized model.
 *
 * `productIdentityKey` derives the stable per-product key used for BOTH
 * change detection (same product over time, within a store) and cross-store
 * matching — it must match exactly what the matcher's identity tiers produce,
 * so it reuses the matcher's own normalizers (architecture §2.2).
 */
const crypto = require('crypto');

const { normalizeGtin, normalizeSku, slugFromUrl } = require('./matcher');

/**
 * Stable identity key for a product: first non-empty of
 * `gtin:<digits>` > `sku:<alnum>` > `slug:<last-path-segment>`, else a
 * sha1 hash of the URL (falling back to the name so products without a URL
 * still get a deterministic — not colliding — key).
 */
function productIdentityKey(product) {
  const gtin = normalizeGtin(product.gtin || product.barcode);
  if (gtin) return `gtin:${gtin}`;

  const sku = normalizeSku(product.sku);
  if (sku) return `sku:${sku}`;

  const slug = slugFromUrl(product.url);
  if (slug) return `slug:${slug}`;

  const source = String(product.url || product.name || '').trim();
  const hash = crypto.createHash('sha1').update(source).digest('hex');
  return `url:${hash}`;
}

/**
 * Normalized host key for an origin — drops protocol and `www.`, mirroring
 * the frontend's `normalizeOrigin` so client and server group stores the
 * same way.
 */
function normalizeHost(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return String(origin || '')
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '');
  }
}

module.exports = { productIdentityKey, normalizeHost };
