/**
 * HTML heuristic extractor (Tier 3, last resort).
 *
 * When JSON-LD, Microdata, and OpenGraph are all absent, fall back to
 * regex over rendered HTML:
 *   - <h1> → product name
 *   - og:image → image (already covered by OG extractor; this is a tiebreaker)
 *   - $XX.XX / €XX.XX / AED 250 / OMR 90 near an element with class*="price"
 *     (or a "price"/"total" keyword) → price
 *   - button text contains "Add to Cart" → in stock
 *   - button text contains "Out of Stock" / "Sold Out" → out of stock
 *
 * Aug 2026 (activefitnessstore): the rendered DOM shows prices as
 * `TOTAL PRICE <span> OMR 90</span>` — a currency-CODE prefix with no
 * decimal and no symbol. The old `PRICE_RE` only matched symbol-prefixed
 * `$XX.XX`, so a valid rendered price was dropped. Codes + optional
 * decimals + a keyword window now cover that format.
 *
 * Brittle by definition. JSON-LD should always be tried first.
 */

import type { ExtractedProduct } from "./schema.ts";

const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const TAG_RE = /<[^>]+>/g;

/** ISO currency codes the heuristic recognises (whole-word matched). */
const CURRENCY_CODES =
  "AED|OMR|SAR|QAR|KWD|BHD|USD|EUR|GBP|JPY|INR|PKR|EGP|CNY";

/**
 * A price NUMBER: digits with optional thousands separators (`1,000`) and
 * an optional 0-2 digit decimal part (`1,000.50`, `65.00`, `90`). The
 * number is always preceded by a currency symbol or code. The trailing
 * `(?![A-Za-z])` rejects token-ish matches like `$1a` / `OMR90abc` (RSC
 * reference payloads use `$1`, `$22`… — see stripScriptsAndStyles).
 */
const NUMBER_RE = /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?(?![A-Za-z])/;

/** A price: currency SYMBOL (`$`, `€`, `£`, `¥`) or ISO CODE + number. */
const PRICE_RE = new RegExp(
  `(?:([$€£¥])\\s?|(${CURRENCY_CODES})\\s?)(${NUMBER_RE.source})`,
  "i",
);

/** An element whose class mentions "price" — the most reliable anchor. */
const PRICE_NEAR_RE =
  /<[^>]*class=["'][^"']*price[^"']*["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/gi;

/**
 * "price"/"total" keyword, then a price within a short window, allowing
 * tags in between — rendered DOM often has `TOTAL PRICE <span> OMR 90</span>`
 * (no price class, and the span breaks a flat `[^>]` window).
 */
const PRICE_KEYWORD_RE = new RegExp(
  `(?:price|total|final)(?:<[^>]+>|[^<>]){0,120}?(?:([$€£¥])\\s?|(${CURRENCY_CODES})\\s?)(${NUMBER_RE.source})`,
  "i",
);

/**
 * Removes <script> and <style> blocks before heuristic scanning. Rendered
 * Next.js/React DOMs embed RSC serialization payloads in <script> tags
 * whose `$1`, `$22`… reference tokens match the symbol-price regex as
 * "$1" → a bogus `1 USD` price on ~half of activefitnessstore's pages
 * (Aug 2026). The visible price lives in markup, never in a script, so
 * stripping is lossless for extraction.
 */
const SCRIPT_OR_STYLE_RE =
  /<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi;
function stripScriptsAndStyles(html: string): string {
  return html.replace(SCRIPT_OR_STYLE_RE, "");
}

/** Symbol → ISO code; the PRICE_RE currency-code branch reports codes directly. */
function symbolToCurrency(symbol: string | undefined): string | null {
  if (!symbol) return null;
  switch (symbol) {
    case "$":
      return "USD";
    case "€":
      return "EUR";
    case "£":
      return "GBP";
    case "¥":
      return "JPY";
    default:
      return null;
  }
}

/**
 * Parses a raw number string with thousands/decimal separators into a real
 * number: `1,000` → 1000, `1,000.50` → 1000.5, `65.00` → 65. Last group of
 * 1-2 digits is decimals; everything before is thousands (the regex shape
 * already guarantees groups of 3 for thousands).
 */
function numberFromRaw(raw: string): number {
  const m = String(raw).match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!m) return Number(String(raw).replace(/[.,]/g, ""));
  const whole = m[1];
  const dec = m[2];
  return dec != null ? Number(`${whole}.${dec}`) : Number(whole);
}

/**
 * Extracts `{ price, currency }` from a match, or null when the number is
 * not usable. Currency resolution order: ISO code > symbol > undefined
 * (caller falls back to a document-level currency guess).
 */
function priceFromMatch(
  m: RegExpMatchArray,
): { price: number; currency: string | null } | null {
  const n = numberFromRaw(m[3]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const currency = m[2] ?? symbolToCurrency(m[1]) ?? null;
  return { price: n, currency };
}

/** Returns a usable price + detected currency, or null. */
function findPrice(
  html: string,
): { price: number; currency: string | null } | null {
  // 1. class*="price" elements first (most reliable anchor). The capture
  //    group is the element's inner content — match the price inside it.
  for (const m of html.matchAll(PRICE_NEAR_RE)) {
    const inner = m[1] ?? "";
    const priceMatch = inner.match(PRICE_RE);
    if (!priceMatch) continue;
    const hit = priceFromMatch(priceMatch);
    if (hit) return hit;
  }
  // 2. "price"/"total" keyword window — rendered DOM often has no price class.
  const keywordHit = html.match(PRICE_KEYWORD_RE);
  if (keywordHit) {
    const hit = priceFromMatch(keywordHit);
    if (hit) return hit;
  }
  // 3. Any currency-tagged number in the document (last resort).
  const any = html.match(PRICE_RE);
  if (any) {
    const hit = priceFromMatch(any);
    if (hit) return hit;
  }
  return null;
}

/**
 * Best-effort currency from document content when the price had no code.
 * Returns `null` when nothing points at a currency — an unknown currency
 * must read as unknown (null), NEVER a silent "USD" (Aug 2026 rule). The
 * `$` → USD map is a real symbol guess, not a default.
 */
function guessCurrency(html: string): string | null {
  if (/\bAED\b/i.test(html)) return "AED";
  if (/\bOMR\b/i.test(html)) return "OMR";
  if (/\bSAR\b/i.test(html)) return "SAR";
  if (/\bQAR\b/i.test(html)) return "QAR";
  if (/\bKWD\b/i.test(html)) return "KWD";
  if (/\bBHD\b/i.test(html)) return "BHD";
  if (/\bINR\b/i.test(html)) return "INR";
  if (/\bPKR\b/i.test(html)) return "PKR";
  if (/\bEGP\b/i.test(html)) return "EGP";
  if (/\bJPY\b/i.test(html) || html.includes("¥")) return "JPY";
  if (html.includes("€")) return "EUR";
  if (html.includes("£")) return "GBP";
  if (html.includes("$")) return "USD";
  return null;
}

export function extractHtmlHeuristics(
  html: string,
  pageUrl: string,
): ExtractedProduct | null {
  // Scan the VISIBLE markup only — script/style noise can't hold the price
  // and actively produces false positives (`$1` RSC tokens → "1 USD").
  const clean = stripScriptsAndStyles(html);
  const h1 = clean.match(H1_RE)?.[1];
  const name = h1 ? h1.replace(TAG_RE, "").trim() : null;
  if (!name) return null;

  const found = findPrice(clean);
  if (!found) return null;

  const price = found.price;
  // undefined (not null) so the optional ExtractedProduct.priceCurrency
  // stays null-safe through the mapper → "unknown" currency at ingest.
  const priceCurrency = found.currency ?? guessCurrency(clean) ?? undefined;

  const lower = clean.toLowerCase();
  const availability: "in_stock" | "out_of_stock" | "unknown" =
    lower.includes("out of stock") || lower.includes("sold out")
      ? "out_of_stock"
      : lower.includes("add to cart") || lower.includes("add to bag")
        ? "in_stock"
        : "unknown";

  return {
    name,
    price,
    priceCurrency,
    availability,
    offers: [
      {
        price,
        priceCurrency,
        availability: availability === "in_stock" ? "InStock" : "OutOfStock",
        url: pageUrl,
      },
    ],
    url: pageUrl,
    source: "html-heuristics",
  };
}
