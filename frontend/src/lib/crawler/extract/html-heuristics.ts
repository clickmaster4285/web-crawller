/**
 * HTML heuristic extractor (Tier 3, last resort).
 *
 * When JSON-LD, Microdata, and OpenGraph are all absent, fall back to
 * regex over rendered HTML:
 *   - <h1> → product name
 *   - og:image → image (already covered by OG extractor; this is a tiebreaker)
 *   - $XX.XX / €XX.XX near an element with class*="price" → price
 *   - button text contains "Add to Cart" → in stock
 *   - button text contains "Out of Stock" / "Sold Out" → out of stock
 *
 * Brittle by definition. JSON-LD should always be tried first.
 */

import type { ExtractedProduct } from "./schema.ts";

const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const TAG_RE = /<[^>]+>/g;
const PRICE_RE = /([$€£¥])\s?(\d{1,5}(?:[.,]\d{2}))/;
const PRICE_NEAR_RE =
  /class=["'][^"']*price[^"']*["'][^>]*>([^<]*[$€£¥][^<]*)/gi;

export function extractHtmlHeuristics(
  html: string,
  pageUrl: string,
): ExtractedProduct | null {
  const h1 = html.match(H1_RE)?.[1];
  const name = h1 ? h1.replace(TAG_RE, "").trim() : null;
  if (!name) return null;

  const price = findPrice(html);
  if (price == null) return null;

  const lower = html.toLowerCase();
  const availability: "in_stock" | "out_of_stock" | "unknown" =
    lower.includes("out of stock") || lower.includes("sold out")
      ? "out_of_stock"
      : lower.includes("add to cart") || lower.includes("add to bag")
        ? "in_stock"
        : "unknown";

  return {
    name,
    price,
    priceCurrency: guessCurrency(html),
    availability,
    offers: [
      {
        price,
        priceCurrency: guessCurrency(html),
        availability: availability === "in_stock" ? "InStock" : "OutOfStock",
        url: pageUrl,
      },
    ],
    url: pageUrl,
    source: "html-heuristics",
  };
}

function findPrice(html: string): number | null {
  // Look for class~="price" elements first (most reliable).
  for (const m of html.matchAll(PRICE_NEAR_RE)) {
    const text = m[1] ?? "";
    const hit = text.match(PRICE_RE);
    if (hit) {
      const n = Number((hit[2] ?? "").replace(",", "."));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // Fall back to any currency-tagged number in the document.
  const any = html.match(PRICE_RE);
  if (any) {
    const n = Number((any[2] ?? "").replace(",", "."));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function guessCurrency(html: string): string {
  if (html.includes("€")) return "EUR";
  if (html.includes("£")) return "GBP";
  if (html.includes("¥")) return "JPY";
  return "USD";
}
