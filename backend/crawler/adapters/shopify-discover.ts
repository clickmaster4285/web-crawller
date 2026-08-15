/**
 * Shopify-specific discovery.
 *
 * Walks paginated collection pages to extract product handles, exposes a
 * regex for matching `/products/{handle}` URLs (used in dedupe and for
 * filtering sitemap results), and — Tier 3 — walks the store's PUBLIC
 * `/products.json` catalogue when it answers (the same escape hatch the
 * WooCommerce + BigCommerce adapters provide: a blocked sitemap must not
 * mean a blocked store. athletix.ae: `/sitemap.xml` 429'd while
 * `/products.json?limit=250` paged cleanly — the shop was crawling to zero
 * while its full catalogue sat behind a public API).
 */

import { fetchText, fetchWithRetry } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";
import { waitForControl, type CrawlControl } from "../core/control.ts";

/** Matches a Shopify product URL. Capture group 1 is the handle — lowercase
 * letters, digits, hyphens AND underscores (Shopify allows `_`; athletix.ae
 * has real `…-sab-06_r` handles). */
export const SHOPIFY_PRODUCT_URL_RE = /\/products\/([a-z0-9_-]+)/g;

/** Matches a product URL scoped to a specific collection. */
export function collectionProductUrlRe(collection: string): RegExp {
  return new RegExp(
    `/collections/${escapeRegex(collection)}/products/([a-z0-9-]+)`,
    "g",
  );
}

/**
 * Extracts product handles from a Shopify collection page's HTML by matching
 * `/products/{handle}` links scoped to that collection. Falls back to plain
 * `/products/{handle}` links if the collection-scoped ones are missing.
 */
export function extractProductHandles(
  html: string,
  collection?: string,
): string[] {
  const handles = new Set<string>();
  const scoped = collection ? collectionProductUrlRe(collection) : null;
  const plain = SHOPIFY_PRODUCT_URL_RE;

  let match: RegExpExecArray | null;
  if (scoped) {
    while ((match = scoped.exec(html)) !== null) handles.add(match[1]);
  }
  if (handles.size === 0) {
    const plainGlobal = new RegExp(plain.source, "g");
    while ((match = plainGlobal.exec(html)) !== null) handles.add(match[1]);
  }
  return [...handles];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes(
    "application/json",
  );
}

/** Outcome of the one-request `/products.json` probe. */
export interface ShopifyApiProbe {
  status: "public" | "auth-required" | "unavailable";
  /** Total products the API exposes (unknown — Shopify sends no count header). */
  total: number | null;
  /** Human-readable detail (probe failure). */
  message?: string;
}

/** Hard cap so a misbehaving API can't balloon a crawl's discovery phase. */
const MAX_API_PRODUCTS = 10_000;
const MAX_API_PAGES = 100;
const PRODUCTS_JSON = "/products.json";

/**
 * One polite request to `/products.json?limit=1` to decide whether the
 * store's catalogue is publicly enumerable. Never throws. Shopify serves
 * this on every storefront; 404 only when the platform isn't Shopify (or
 * the path is blocked), so "unavailable" is the honest fallback.
 */
export async function probeShopifyApi(
  origin: string,
  options: HttpOptions,
): Promise<ShopifyApiProbe> {
  const url = `${origin}${PRODUCTS_JSON}?limit=1`;
  // robots.txt can disallow /products.json (some stores block API probing).
  if (options.isAllowed && !options.isAllowed(url)) {
    return {
      status: "unavailable",
      total: null,
      message: "robots.txt disallows /products.json",
    };
  }
  let response: Response;
  try {
    response = await fetchWithRetry(url, options);
  } catch (error) {
    return {
      status: "unavailable",
      total: null,
      message: `probe failed: ${String(error)}`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: "auth-required",
      total: null,
      message: "products.json requires credentials",
    };
  }
  if (response.status === 404) {
    return {
      status: "unavailable",
      total: null,
      message: "no Shopify catalogue at /products.json",
    };
  }
  if (!response.ok || !isJsonResponse(response)) {
    return {
      status: "unavailable",
      total: null,
      message: `/products.json answered ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      status: "unavailable",
      total: null,
      message: "unparseable products.json response",
    };
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("products" in body) ||
    !Array.isArray((body as { products?: unknown }).products)
  ) {
    return {
      status: "unavailable",
      total: null,
      message: "unexpected products.json shape",
    };
  }
  return { status: "public", total: null };
}

/**
 * Walks the paginated Shopify catalogue (`/products.json?limit=250&page=N`)
 * and returns every product's `/products/{handle}` URL (deduped), so the
 * URLs feed the engine's normal discovery set and the fetch loop's existing
 * per-product Shopify JSON probe takes over. Stops on an empty/short page,
 * a 400 (page*limit exceeds Shopify's 25,000 cap), or the safety caps.
 */
export async function discoverShopifyProducts(
  origin: string,
  options: HttpOptions,
  control?: CrawlControl,
): Promise<{ urls: string[]; total: number | null; truncated: boolean }> {
  const urls = new Set<string>();
  const perPage = 250;
  let truncated = false;

  for (let page = 1; page <= MAX_API_PAGES; page++) {
    // Cooperative control: pause waits here, cancel throws — a long API walk
    // must not ignore a user's pause/cancel.
    await waitForControl(control);
    if (urls.size >= MAX_API_PRODUCTS) {
      truncated = true;
      break;
    }
    const url = `${origin}${PRODUCTS_JSON}?limit=${perPage}&page=${page}`;
    if (options.isAllowed && !options.isAllowed(url)) {
      truncated = true;
      break;
    }
    let response: Response;
    let body: unknown;
    try {
      response = await fetchWithRetry(url, options);
      // 400 = page*limit exceeds Shopify's 25,000-product API cap — the walk
      // is done (a shop that large is capped honestly, not silently).
      if (
        response.status === 400 ||
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        if (response.status === 400) truncated = true;
        break;
      }
      if (!response.ok || !isJsonResponse(response)) break;
      body = await response.json();
    } catch {
      break;
    }
    const products = (body as { products?: Array<{ handle?: string }> })
      ?.products;
    if (!Array.isArray(products)) break;
    for (const raw of products) {
      const handle = raw?.handle;
      if (handle) urls.add(`${origin}/products/${handle}`);
    }
    // Shopify sends no total header — a page returning fewer items than
    // requested is the last one.
    if (products.length < perPage) break;
  }

  return { urls: [...urls], total: urls.size, truncated };
}

/**
 * Discovers every product handle in a Shopify collection by walking its
 * (paginated) HTML pages: /collections/{handle}?page=N.
 */
export async function discoverCollectionHandles(
  origin: string,
  collection: string,
  options: HttpOptions,
  maxPages = 20,
): Promise<string[]> {
  const handles = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${origin}/collections/${collection}` + (page > 1 ? `?page=${page}` : "");
    // Respect robots.txt: a disallowed collection page yields nothing anyway.
    if (options.isAllowed && !options.isAllowed(url)) break;
    const html = await fetchText(url, options);
    const found = extractProductHandles(html, collection);
    if (found.length === 0) break;
    found.forEach((h) => handles.add(h));
    // Stop when the page no longer offers a "next" page.
    if (!new RegExp(`page=${page + 1}`).test(html)) break;
  }
  return [...handles];
}
