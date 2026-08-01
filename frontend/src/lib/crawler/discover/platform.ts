/**
 * Store platform detection (discovery phase).
 *
 * Identifies the e-commerce platform a store runs on from cheap signals:
 *
 *   1. **robots.txt body** — already fetched by the politeness layer, so this
 *      is a free signal. Shopify's default robots.txt literally says
 *      "Shopify storefront" in a comment; Magento/PrestaShop name themselves
 *      too.
 *   2. **Homepage HTML** — one polite request (throttled via `opts`): the
 *      `<meta name="generator">` tag is the strongest signal, followed by
 *      asset-path fingerprints (cdn.shopify.com, wp-content, /static/…).
 *
 * Returns `{ platform, signal }` — the display name plus a short human note
 * on what matched, so the UI can show where the answer came from. Unknown
 * stores fall back to `{ platform: "Unknown" }`.
 */

import { fetchText } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";

export interface PlatformDetection {
  /** Display name, e.g. "Shopify", "WooCommerce", "Magento", "Unknown". */
  platform: string;
  /** Short note on which signal produced the answer (transparency). */
  signal: string;
}

const GENERATOR_META_RE =
  /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i;

/**
 * Detects the store platform from the robots.txt body (already fetched) and,
 * if needed, one polite homepage fetch. Never throws — any failure degrades
 * to "Unknown".
 */
export async function detectPlatform(
  origin: string,
  opts: HttpOptions,
  robotsBody?: string | null,
): Promise<PlatformDetection> {
  const base = safeOrigin(origin);

  // Signal 1: robots.txt (free — already fetched by politeness).
  const robots = (robotsBody ?? "").toLowerCase();
  if (robots.includes("shopify")) {
    return { platform: "Shopify", signal: "robots.txt references Shopify" };
  }
  if (robots.includes("magento")) {
    return { platform: "Magento", signal: "robots.txt references Magento" };
  }
  if (robots.includes("prestashop")) {
    return {
      platform: "PrestaShop",
      signal: "robots.txt references PrestaShop",
    };
  }
  const robotsWp = robots.includes("wp-content") || robots.includes("wp-json");

  // Signal 2: homepage HTML — generator meta first, then asset fingerprints.
  let html = "";
  try {
    html = await fetchText(`${base}/`, opts);
  } catch {
    // Unreachable / rate-limited homepage — fall through to the robots
    // conclusion if any, otherwise Unknown.
  }
  const lower = html.toLowerCase();
  const generator = GENERATOR_META_RE.exec(html)?.[1]?.trim() ?? "";
  const g = generator.toLowerCase();

  if (g.includes("woocommerce")) {
    return {
      platform: "WooCommerce",
      signal: generator ? `generator: ${generator}` : "WooCommerce markers",
    };
  }
  if (g.includes("shopify")) {
    return {
      platform: "Shopify",
      signal: generator ? `generator: ${generator}` : "Shopify markers",
    };
  }
  if (g.includes("magento")) {
    return {
      platform: "Magento",
      signal: generator ? `generator: ${generator}` : "Magento markers",
    };
  }
  if (g.includes("prestashop")) {
    return {
      platform: "PrestaShop",
      signal: generator ? `generator: ${generator}` : "PrestaShop markers",
    };
  }
  if (g.includes("bigcommerce")) {
    return {
      platform: "BigCommerce",
      signal: generator ? `generator: ${generator}` : "BigCommerce markers",
    };
  }
  if (g.includes("wordpress") && lower.includes("woocommerce")) {
    return { platform: "WooCommerce", signal: "WooCommerce on WordPress" };
  }

  // Asset-path fingerprints (no generator meta).
  if (lower.includes("cdn.shopify.com")) {
    return { platform: "Shopify", signal: "Shopify CDN assets on homepage" };
  }
  if (/cdn\d+\.bigcommerce\.com/.test(lower)) {
    return { platform: "BigCommerce", signal: "BigCommerce CDN assets" };
  }
  if (lower.includes("/static/version") || lower.includes("mage/")) {
    return { platform: "Magento", signal: "Magento asset paths on homepage" };
  }
  if (lower.includes("wp-content") || robotsWp) {
    return {
      platform: "WordPress",
      signal: lower.includes("wp-content")
        ? "WordPress asset paths"
        : "WordPress paths in robots.txt",
    };
  }

  return { platform: "Unknown", signal: "No platform markers found" };
}

/** Normalizes an origin to scheme+host so `${base}/` never double-slashes. */
function safeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}
