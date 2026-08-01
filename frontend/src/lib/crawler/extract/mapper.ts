/**
 * Extractor chain + mapping.
 *
 * Tries each extractor in priority order (JSON-LD → microdata → OpenGraph
 * → HTML heuristics) and returns the first hit mapped into a
 * `CrawledProduct`. JSON-LD almost always wins; the others are fallbacks
 * for the long tail of stores that don't ship structured data.
 */

import { extractHtmlHeuristics } from "./html-heuristics.ts";
import { extractJsonLd } from "./jsonld.ts";
import { extractMicrodata } from "./microdata.ts";
import { extractOpenGraph } from "./opengraph.ts";
import type { ExtractedProduct } from "./schema.ts";
import type { CrawledProduct, CrawledVariant } from "../core/types.ts";

/** Extracts a product from rendered HTML. Returns `null` when nothing usable is found. */
export function extractFromHtml(
  html: string,
  pageUrl: string,
  origin: string,
  handleOrId: string,
): CrawledProduct | null {
  const extracted =
    extractJsonLd(html, pageUrl) ??
    extractMicrodata(html, pageUrl) ??
    extractOpenGraph(html, pageUrl) ??
    extractHtmlHeuristics(html, pageUrl);
  if (!extracted) return null;
  return toCrawledProduct(extracted, origin, handleOrId);
}

/** Maps an ExtractedProduct onto the vendor-neutral CrawledProduct. */
export function toCrawledProduct(
  extracted: ExtractedProduct,
  origin: string,
  handleOrId: string,
): CrawledProduct {
  const variant: CrawledVariant = {
    id: 0,
    title: "Default",
    sku: extracted.sku ?? "",
    price: extracted.price,
    compareAtPrice: extracted.compareAtPrice ?? null,
    available: extracted.availability === "in_stock",
    inventoryQuantity: extracted.availability === "in_stock" ? 1 : 0,
    barcode: extracted.gtin ?? "",
  };
  const now = new Date().toISOString();
  return {
    id: numericId(handleOrId),
    handle: handleOrId,
    url: pageUrlOrOrigin(extracted.url, origin, handleOrId),
    name: extracted.name,
    brand: extracted.brand ?? "",
    category: extracted.category ?? "",
    description: extracted.description ?? "",
    tags: [],
    image: extracted.image ?? null,
    price: extracted.price,
    compareAtPrice: extracted.compareAtPrice ?? null,
    available: extracted.availability === "in_stock",
    variants: [variant],
    createdAt: now,
    updatedAt: now,
    crawledAt: now,
  };
}

function pageUrlOrOrigin(url: string, origin: string, handle: string): string {
  if (url) return url;
  return `${origin}/products/${handle}`;
}

/** Derives a numeric id from a handle (e.g. Shopify `gid` or our slug). */
function numericId(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 0;
}
