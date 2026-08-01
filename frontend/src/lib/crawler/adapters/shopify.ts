/**
 * Shopify adapter (Tier 1).
 *
 * Re-exports the Shopify-specific parse + discovery so callers can do
 * `import { parseShopifyProduct, discoverCollectionHandles } from "./adapters/shopify.ts"`.
 * Kept as a single barrel so the adapter surface is one identifier.
 */

export { parseShopifyProduct, type RawProduct } from "./shopify-parse.ts";
export {
  discoverCollectionHandles,
  extractProductHandles,
  collectionProductUrlRe,
  SHOPIFY_PRODUCT_URL_RE,
} from "./shopify-discover.ts";
