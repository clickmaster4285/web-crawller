/**
 * Store platform detection (discovery phase).
 *
 * Identifies the e-commerce platform a store runs on from cheap signals:
 *
 *   1. **robots.txt body** — already fetched by the politeness layer, so this
 *      is a free signal. Shopify's default robots.txt literally says
 *      "Shopify storefront" in a comment; Magento/PrestaShop/WooCommerce name
 *      themselves or their paths.
 *   2. **Homepage HTML** — one polite request: every `<meta name="generator">`
 *      tag is the strongest signal (Elementor / Site Kit / Rank Math → a
 *      WordPress site; WooCommerce → a WordPress store), followed by
 *      asset-path fingerprints (cdn.shopify.com, wp-content, /static/version…)
 *      and the `Server` / `X-Powered-By` response headers (Apache · PHP).
 *
 * Returns `{ platform, kind, signal, cms?, builder?, seoPlugin?, server?,
 * generator?, homepageHtml }` — the display name, whether the site looks like
 * a *store* or a *corporate site*, plus the signals that produced the answer
 * so the UI can show *why*. Unknown stores fall back to "Unknown".
 */

import { fetchWithRetry } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";

export interface PlatformDetection {
  /** Display name, e.g. "WooCommerce", "WordPress", "Shopify", "Unknown". */
  platform: string;
  /** "store" — sells products; "corporate" — marketing/brochure site; "unknown". */
  kind: "store" | "corporate" | "unknown";
  /** Short note on which signal produced the answer (transparency). */
  signal: string;
  /** CMS the site is built on, when identifiable (e.g. "WordPress"). */
  cms?: string;
  /** Page-builder/theme marker (e.g. "Elementor"). */
  builder?: string;
  /** SEO plugin marker (e.g. "Rank Math SEO", "Yoast SEO"). */
  seoPlugin?: string;
  /** Server stack from response headers (e.g. "Apache · PHP 8.2.33"). */
  server?: string;
  /** Raw generator meta tags joined (verbosity for the UI). */
  generator?: string;
  /** Homepage HTML, returned so discovery can analyze links without a second fetch. */
  homepageHtml: string;
}

const GENERATOR_META_RE =
  /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/gi;

/** WordPress-ish robots.txt / generator markers that don't imply a store. */
const WORDPRESS_CORE_MARKERS = ["wp-content", "wp-json", "wp-admin"];

/**
 * Detects the store platform from the robots.txt body (already fetched) and,
 * if needed, one polite homepage fetch. Never throws — any failure degrades
 * to "Unknown" with an honest signal.
 */
export async function detectPlatform(
  origin: string,
  opts: HttpOptions,
  robotsBody?: string | null,
): Promise<PlatformDetection> {
  const base = safeOrigin(origin);

  // Signal 1: robots.txt (free — already fetched by politeness).
  const robots = (robotsBody ?? "").toLowerCase();
  let server: string | undefined;
  let poweredBy: string | undefined;
  let html = "";

  // Signal 2: homepage HTML + response headers (one polite request).
  try {
    const response = await fetchWithRetry(`${base}/`, opts);
    html = await response.text();
    server = response.headers.get("server") ?? undefined;
    poweredBy = response.headers.get("x-powered-by") ?? undefined;
  } catch {
    // Unreachable / rate-limited homepage — fall through to the robots
    // conclusion if any, otherwise Unknown.
  }

  const lower = html.toLowerCase();
  const generators: string[] = [];
  for (const m of html.matchAll(GENERATOR_META_RE)) {
    const g = m[1]?.trim();
    if (g) generators.push(g);
  }
  const generator = generators.join(" · ");
  const g = generator.toLowerCase();

  const serverStack = [
    server,
    poweredBy && poweredBy.replace(/^PHP\//i, "PHP "),
  ]
    .filter(Boolean)
    .join(" · ");

  // robots.txt markers first (free). Store platforms that name themselves.
  if (robots.includes("shopify")) {
    return {
      platform: "Shopify",
      kind: "store",
      signal: "robots.txt references Shopify",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (robots.includes("magento")) {
    return {
      platform: "Magento",
      kind: "store",
      signal: "robots.txt references Magento",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (robots.includes("prestashop")) {
    return {
      platform: "PrestaShop",
      kind: "store",
      signal: "robots.txt references PrestaShop",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  // WooCommerce robots.txt names checkout/cart/my-account paths.
  const robotsWc =
    robots.includes("woocommerce") ||
    (robots.includes("/checkout") && robots.includes("/cart")) ||
    robots.includes("filter_brand");
  if (robotsWc) {
    return {
      platform: "WooCommerce",
      kind: "store",
      signal: "robots.txt shows WooCommerce store paths",
      cms: "WordPress",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  const robotsWp = WORDPRESS_CORE_MARKERS.some((m) => robots.includes(m));

  // Generator meta tags — the strongest signal when present.
  if (g.includes("woocommerce")) {
    return {
      platform: "WooCommerce",
      kind: "store",
      signal: generator ? `generator: ${generator}` : "WooCommerce markers",
      cms: "WordPress",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (g.includes("shopify")) {
    return {
      platform: "Shopify",
      kind: "store",
      signal: generator ? `generator: ${generator}` : "Shopify markers",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (g.includes("magento")) {
    return {
      platform: "Magento",
      kind: "store",
      signal: generator ? `generator: ${generator}` : "Magento markers",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (g.includes("prestashop")) {
    return {
      platform: "PrestaShop",
      kind: "store",
      signal: generator ? `generator: ${generator}` : "PrestaShop markers",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (g.includes("bigcommerce")) {
    return {
      platform: "BigCommerce",
      kind: "store",
      signal: generator ? `generator: ${generator}` : "BigCommerce markers",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }

  // WordPress — the generator string names the builder/SEO plugin, which is
  // exactly what tells a corporate site apart from a store.
  if (
    g.includes("elementor") ||
    g.includes("site kit by google") ||
    g.includes("rank math") ||
    g.includes("yoast") ||
    g.includes("astra") ||
    g.includes("wordpress") ||
    robotsWp ||
    lower.includes("wp-content")
  ) {
    const builder = generators.find((x) =>
      /elementor|divi|beaver|astra|wpbakery|oxygen|bricks/i.test(x),
    );
    const seoPlugin = generators.find((x) =>
      /rank math|yoast|all in one seo|seo framework/i.test(x),
    );
    return {
      platform: "WordPress",
      kind: robotsWc ? "store" : "corporate",
      signal: generator
        ? `generator: ${generator}`
        : robotsWp
          ? "WordPress paths in robots.txt"
          : "WordPress asset paths",
      cms: "WordPress",
      builder,
      seoPlugin,
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }

  if (g.includes("wix.com")) {
    return {
      platform: "Wix",
      kind: "unknown",
      signal: generator ? `generator: ${generator}` : "Wix markers",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (g.includes("squarespace")) {
    return {
      platform: "Squarespace",
      kind: "unknown",
      signal: generator ? `generator: ${generator}` : "Squarespace markers",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }

  // Asset-path fingerprints (no generator meta).
  if (lower.includes("cdn.shopify.com")) {
    return {
      platform: "Shopify",
      kind: "store",
      signal: "Shopify CDN assets on homepage",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  if (/cdn\d+\.bigcommerce\.com/.test(lower)) {
    return {
      platform: "BigCommerce",
      kind: "store",
      signal: "BigCommerce CDN assets",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }
  // Magento needs an explicit path — a bare `mage/` substring false-positives
  // on words like "image/", so only `/static/version` or a literal Magento
  // reference counts.
  if (lower.includes("/static/version") || lower.includes("magento")) {
    return {
      platform: "Magento",
      kind: "store",
      signal: "Magento asset paths on homepage",
      server: serverStack || undefined,
      generator: generator || undefined,
      homepageHtml: html,
    };
  }

  return {
    platform: "Unknown",
    kind: "unknown",
    signal: "No platform markers found",
    server: serverStack || undefined,
    generator: generator || undefined,
    homepageHtml: html,
  };
}

/** Normalizes an origin to scheme+host so `${base}/` never double-slashes. */
function safeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}
