/**
 * Non-product URL classifier — the SINGLE source of truth for deciding
 * whether a URL is a product page, shared by:
 *
 *   - the crawler's discovery filter (`discover/index.ts` — strips junk
 *     segments from sitemap URLs at ANY path depth),
 *   - the backend ingest guard (`backend/services/crawlSync.js` — drops
 *     junk-URL rows before they become Products; loads this module via
 *     `await import()` the same way the worker loads the crawler engine),
 *   - the `tools/` ops scripts — junk purge/check (imported the same way).
 *
 * If the list needs to change, change it HERE — the three consumers must
 * never drift apart again (Aug 2026: the probe script had already grown its
 * own extra terms while the crawler and ingest guard stayed on the older
 * list; a site blocked in one and crawled by another).
 */

/**
 * URL segments that are NEVER product pages, matched at ANY path depth.
 * Locale-prefixed stores (`/uae-en/…`, `/om/…`, `/en/…`) put blog, policy
 * and collection pages at segment 1+, so a first-segment-only blocklist
 * can't catch them (Aug 2026: urbanfitnesscart.com mixed 5,117 real
 * products under `/uae-en/product/` with blog/privacy/collections pages
 * that the flat rule kept as products). Multi-word slugs the older section
 * list missed (privacy-policy, terms-of-service,
 * delivery-and-return-policy…) are here too.
 */
export const JUNK_SEGMENT_RE =
  /^(blog|news|articles|posts|about|about-us|contact|contact-us|help|help-center|support|faq|faqs|policy|privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|shipping|shipping-details|shipping-policy|delivery|delivery-and-return-policy|returns|return-policy|refund|refund-policy|payment|payment-options|warranty|warranty-returns|careers|account|my-account|cart|wishlist|checkout|login|register|signup|search|page|pages|tag|tags|author|authors|archives|guides|tutorials|reviews|resources|events|team|services|solutions|downloads|docs|documentation|knowledge-base|collections|shop-now-pay-later|shop-now|pay-later|track-order|order-tracking|stores|store-locator|affiliate|affiliates|gift-card|gift-cards|promotions|promo|vip|membership|compare|comparison)$/i;

/** Lowercased path segments of a URL (`/computing/dell-x` → ["computing", "dell-x"]). */
export function pathSegments(url: string | null | undefined): string[] {
  try {
    return new URL(String(url ?? "")).pathname
      .split("/")
      .filter(Boolean)
      .map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * True when ANY path segment of `url` is an unambiguous non-product segment
 * (blog/legal/collection page). Tested against every discovered URL, in every
 * sitemap source — even "known product sitemaps", which can still list such
 * pages under a locale prefix.
 */
export function hasJunkSegment(url: string | null | undefined): boolean {
  return (
    pathSegments(url).some((s) => JUNK_SEGMENT_RE.test(s)) ||
    isSeoCityLanding(url)
  );
}

/**
 * GCC store SEO "category in city" landing pages
 * (`/treadmills/treadmills-in-abu-dhabi`, `/home-use-treadmills-in-al-ain`…).
 * Rank Math and similar plugins auto-generate category × city pages for
 * UAE/KSA/OM/QA stores — they carry ZERO product data but are leaves of the
 * sitemap tree, so the flat-taxonomy leaf heuristic classifies them as
 * products (lifetimefitnessstore.com: 7,744 of them in `sitemap_ae.xml` —
 * a 500-page crawl budget was consumed entirely by these before a single
 * real product was reached). Real product slugs end in SKU/model codes
 * (`…-nnnetl19718`, `…-f-g20-base`), never in a place name.
 *
 * Matched as a SUFFIX of the LAST path segment (not a whole segment), so a
 * product slug that merely contains "in" mid-word
 * (`…-plate-loaded-includes-15kg-barbell-…`) is untouched. `pathSegments`
 * already lowercases, so the regex needs no case-insensitive flag.
 */
export const SEO_CITY_SUFFIX_RE =
  /-in-(abu-dhabi|al-ain|dubai|sharjah|ajman|ras-al-khaimah|fujairah|umm-al-quwain|mussafah|khalifa-city|khalifa|al-reem-island|al-reem|al-mushrif|al-bateen|deira|jumeirah|marina|business-bay|downtown|al-nahda|al-qusais|mirdif|warsan|jebel-ali|ras-al-khor|al-barsha|al-satwa|karama|bur-dubai|al-bustan|city-walk|mohammed-bin-zayed-city|mbz-city|al-samha|khalidya|muroor|al-zahia|al-nahyan-camp|al-shahama|al-raha|al-muntazah|corniche|al-taawun|al-majaz|al-ittihad|al-rumaila|mudon|al-furjan|al-sofouh|al-mankhool|al-hudaiba|al-fahidi|al-ras|al-sabkha|al-hamriya|al-shindagha|al-khwaneej|al-warqa|al-mizhar|al-twar|al-mamzar|al-hamriyah|kalba|khorfakkan|dibba|al-dhaid|madam|al-badayer|liwa|riyadh|jeddah|dammam|khobar|al-khobar|makkah|mecca|madinah|medina|tabuk|abha|jazan|hail|qassim|buraidah|yanbu|taif|muscat|salalah|suhar|nizwa|sur|doha|al-rayyan|al-wakra|al-khor|umm-salal|al-daayen)$/;

/** True when the URL's LAST segment ends in `-in-<city>` (an SEO landing page). */
export function isSeoCityLanding(url: string | null | undefined): boolean {
  const seg = pathSegments(url);
  const last = seg[seg.length - 1] ?? "";
  return SEO_CITY_SUFFIX_RE.test(last);
}

/**
 * Explicit product-base URL: `/product/<slug>`, `/products/<slug>`, Amazon
 * `/dp/<id>`, `/item/<slug>`, or WooCommerce `/shop/<cat>/<product>/`.
 * Used by the discovery filter's base-dominance rule and by the tools' purge
 * classifier — kept here so both stay on the same product-path definition.
 */
export const PRODUCT_BASE_RE = /\/products?\/[a-z0-9_-]+/i;

/** True when a URL matches an explicit product-base pattern. */
export function isProductUrl(url: string | null | undefined): boolean {
  const u = String(url ?? "");
  return (
    PRODUCT_BASE_RE.test(u) ||
    /\/dp\/[a-z0-9_-]+/i.test(u) ||
    /\/item\/[a-z0-9_-]+/i.test(u) ||
    /\/shop\/[a-z0-9_-]+\/[a-z0-9_-]+/i.test(u)
  );
}
