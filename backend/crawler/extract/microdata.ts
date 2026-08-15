/**
 * Microdata extractor (Tier 3, secondary).
 *
 * Reads `itemtype="https://schema.org/Product"` (and friends) and
 * `itemprop` attributes from the HTML. Used as a fallback when JSON-LD is
 * missing or incomplete.
 *
 * Not yet implemented — placeholder. JSON-LD covers the vast majority of
 * sites that emit structured data; this is a fallback for the long tail.
 */

import type { ExtractedProduct } from "./schema.ts";

export function extractMicrodata(
  _html: string,
  _pageUrl: string,
): ExtractedProduct | null {
  return null;
}
