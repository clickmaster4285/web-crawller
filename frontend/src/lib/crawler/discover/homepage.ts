/**
 * Homepage analysis (discovery phase).
 *
 * One polite homepage fetch is already performed by platform detection, so we
 * reuse that HTML to learn what the site actually *is*:
 *   - How many product-ish links does the homepage have? (store vs corporate)
 *   - Does it link out to another host that looks like a store (e.g. a
 *     `shop.` subdomain, or a host containing "shop"/"store")? If so, the real
 *     catalogue probably lives there — surface it as a suggestion.
 *
 * Produces human-readable notes for the verbose UI, and a boolean
 * `looksLikeStore` used to refine the platform `kind`.
 */

const ANCHOR_RE = /<a\s+[^>]*href=["']([^"'#]+)["']/gi;

/** A link on the homepage pointing at a different host that looks store-like. */
export interface ExternalStoreLink {
  url: string;
  host: string;
  /** Anchor text (trimmed) when present — helps the UI explain the link. */
  label: string;
}

export interface HomepageAnalysis {
  /** Number of product-page-ish links on the homepage. */
  productLinks: number;
  /** Number of category/catalogue-ish links on the homepage. */
  categoryLinks: number;
  /** True when the homepage meaningfully links to product pages. */
  looksLikeStore: boolean;
  /** Out-links to other hosts that look like stores (max 5, deduped). */
  externalStoreLinks: ExternalStoreLink[];
  /** Human-readable summary of what the homepage looks like. */
  note: string;
}

const PRODUCT_RE = /\/(product|products|item|dp|p)\/[a-z0-9_-]+/i;
const CATEGORY_RE =
  /\/(category|categories|collection|collections|shop|catalog)\//i;
/** Host contains shop/store/buy or is a subdomain like shop.example.com. */
const STORE_HOST_RE =
  /(^|\.)(shop|store|buy|shopping|e-shop|estore|e-store)(\.|$)/i;

/** Analyzes homepage HTML for store/corporate signals and external store links. */
export function analyzeHomepage(
  html: string,
  origin: string,
): HomepageAnalysis {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    base = new URL("https://example.com");
  }
  const rootHost = base.hostname.replace(/^www\./, "");

  const externalStoreLinks: ExternalStoreLink[] = [];
  const seen = new Set<string>();
  let productLinks = 0;
  let categoryLinks = 0;

  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = m[1];
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
    try {
      const u = new URL(href, base);
      if (u.origin === base.origin) {
        // Same-origin: is it a product or category link?
        if (PRODUCT_RE.test(u.pathname)) productLinks++;
        else if (CATEGORY_RE.test(u.pathname)) categoryLinks++;
        continue;
      }
      // Different host — does it look like a store?
      const host = u.hostname.replace(/^www\./, "");
      if (
        STORE_HOST_RE.test(host) ||
        (host.endsWith(`.${rootHost}`) &&
          /^shop\./i.test(host.replace(rootHost, "")))
      ) {
        if (!seen.has(u.origin)) {
          seen.add(u.origin);
          externalStoreLinks.push({
            url: u.origin,
            host,
            label: anchorText(html, m[0]).slice(0, 60),
          });
        }
      }
    } catch {
      // Malformed href — skip.
    }
  }

  const looksLikeStore = productLinks > 0;
  const note =
    productLinks > 0
      ? `Homepage links to ${productLinks} product page${productLinks === 1 ? "" : "s"} — looks like a store.`
      : externalStoreLinks.length > 0
        ? `No product links on the homepage (corporate/marketing site), but it links out to ${externalStoreLinks
            .map((l) => l.host)
            .join(", ")} — the catalogue may live there.`
        : categoryLinks > 0
          ? `No direct product links, but ${categoryLinks} category/catalogue link${categoryLinks === 1 ? "" : "s"} — products may be one level deeper.`
          : "Homepage has no product or category links — this looks like a corporate site, not a store.";

  return {
    productLinks,
    categoryLinks,
    looksLikeStore,
    externalStoreLinks: externalStoreLinks.slice(0, 5),
    note,
  };
}

/** Extracts the anchor text following an `<a ...>` open tag (raw match start). */
function anchorText(html: string, anchorTag: string): string {
  const start = html.indexOf(anchorTag);
  if (start < 0) return "";
  const after = html.slice(start + anchorTag.length, start + 200);
  const match = after.match(/>([^<]{1,80})/);
  return match?.[1]?.trim() ?? "";
}
