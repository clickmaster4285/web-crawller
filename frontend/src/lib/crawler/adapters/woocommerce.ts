/**
 * WooCommerce native REST API adapter (Tier 3).
 *
 * WooCommerce stores expose a REST API at `/wp-json/wc/v3`. It is the
 * highest-fidelity product source available for them: structured `sku`,
 * `global_unique_id` (GTIN), `regular_price` vs `sale_price`, and
 * `stock_status` — far more reliable than scraping HTML. It is, however,
 * usually locked behind consumer-key credentials (`401/403`), so this
 * adapter is honest about which case it hit:
 *
 *   - `probeWooCommerceApi` — one polite request to decide
 *     `public | auth-required | unavailable`.
 *   - `discoverWooCommerceProducts` — walks the paginated catalogue
 *     (`per_page=100`, `X-WP-Total`/`X-WP-TotalPages`) collecting product
 *     permalinks for the engine's normal discovery URL set.
 *   - `fetchWooCommerceProductBySlug` — per-product JSON fetch used by the
 *     fetch loop when the API is public, so products parse with structured
 *     SKU/GTIN/price/stock instead of HTML heuristics.
 *   - `parseWooCommerceProduct` — maps a raw REST product into the
 *     vendor-neutral `CrawledProduct` shape.
 *
 * When the API needs credentials (the common case), the engine records it
 * in the discovery diagnostics and continues with sitemap/HTML discovery —
 * a crawl never fails because of a locked API.
 */

import { fetchWithRetry } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";
import type { CrawledProduct } from "../core/types.ts";

/** A product as returned by `/wp-json/wc/v3/products` (fields we use). */
export interface RawWooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  status: string;
  price: string | null;
  regular_price: string | null;
  sale_price: string | null;
  sku: string;
  global_unique_id?: string | null;
  gtin?: string | null;
  stock_status?: "instock" | "outofstock" | "onbackorder" | string;
  images?: Array<{ src?: string }> | null;
  categories?: Array<{ id: number; name: string; slug: string }> | null;
  description?: string;
  short_description?: string;
  date_created?: string;
  date_modified?: string;
  meta_data?: Array<{ key: string; value: unknown }> | null;
}

/** Outcome of the one-request REST API probe. */
export interface WooCommerceApiProbe {
  status: "public" | "auth-required" | "unavailable";
  /** Total products the API reports (`X-WP-Total`), when known. */
  total: number | null;
  /** Human-readable detail (auth hint or probe failure). */
  message?: string;
}

const API_PATH = "/wp-json/wc/v3/products";

/** Hard cap so a misbehaving API can't balloon a crawl's discovery phase. */
const MAX_API_PRODUCTS = 10_000;
const MAX_API_PAGES = 200;

/**
 * One polite request to `/wp-json/wc/v3/products?per_page=1` to decide
 * whether the store's REST API is usable without credentials. Never throws.
 */
export async function probeWooCommerceApi(
  origin: string,
  options: HttpOptions,
): Promise<WooCommerceApiProbe> {
  const url = `${origin}${API_PATH}?per_page=1&status=publish`;
  // robots.txt can disallow /wp-json/ (some stores block API probing).
  if (options.isAllowed && !options.isAllowed(url)) {
    return {
      status: "unavailable",
      total: null,
      message: "robots.txt disallows /wp-json/",
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
      message: "REST API requires consumer credentials",
    };
  }
  if (response.status === 404) {
    return {
      status: "unavailable",
      total: null,
      message: "no WooCommerce REST API at /wp-json/wc/v3",
    };
  }
  if (!isJsonResponse(response)) {
    return {
      status: "unavailable",
      total: null,
      message: "/wp-json/wc/v3 did not return JSON",
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      status: "unavailable",
      total: null,
      message: "unparseable REST response",
    };
  }
  if (!Array.isArray(body)) {
    return {
      status: "unavailable",
      total: null,
      message: "unexpected REST response shape",
    };
  }
  const totalHeader = response.headers.get("x-wp-total");
  const total = totalHeader ? Number(totalHeader) || null : null;
  return { status: "public", total };
}

/**
 * Walks the paginated WooCommerce catalogue and returns every product's
 * permalink (deduped), so the URLs feed the engine's normal discovery set.
 * Stops on an empty/short page, a non-JSON response, or the safety caps.
 */
export async function discoverWooCommerceProducts(
  origin: string,
  options: HttpOptions,
  maxProducts = MAX_API_PRODUCTS,
): Promise<{ urls: string[]; total: number | null; truncated: boolean }> {
  const urls = new Set<string>();
  const seen = new Set<number>();
  const perPage = 100;
  let total: number | null = null;
  let totalPages: number | null = null;
  let truncated = false;

  for (let page = 1; page <= MAX_API_PAGES; page++) {
    // Stop at the page count the API itself reported (`X-WP-TotalPages`).
    // This is the reliable signal — some hosts clamp `per_page` (e.g. 10 or
    // 50), which would otherwise make every full page look "short".
    if (totalPages !== null && page > totalPages) break;
    if (urls.size >= maxProducts) {
      truncated = true;
      break;
    }
    const url = `${origin}${API_PATH}?per_page=${perPage}&page=${page}&status=publish`;
    if (options.isAllowed && !options.isAllowed(url)) {
      truncated = true;
      break;
    }
    let response: Response;
    let body: unknown;
    try {
      response = await fetchWithRetry(url, options);
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        break; // Access revoked mid-walk — keep what we have.
      }
      if (!isJsonResponse(response)) break;
      body = await response.json();
    } catch {
      break;
    }
    if (!Array.isArray(body)) break;

    if (page === 1) {
      const totalHeader = response.headers.get("x-wp-total");
      if (totalHeader) total = Number(totalHeader) || null;
      const pagesHeader = response.headers.get("x-wp-totalpages");
      if (pagesHeader) totalPages = Number(pagesHeader) || null;
    }
    for (const raw of body) {
      const product = raw as RawWooProduct;
      if (!product || typeof product !== "object" || !product.id) continue;
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      urls.add(
        product.permalink ||
          `${origin}/product/${encodeURIComponent(product.slug ?? String(product.id))}`,
      );
    }
    // Fallback when the host strips `X-WP-TotalPages`: a page returning fewer
    // items than requested is the last one. Compare the server-returned count
    // (not the deduped count) so a clamped `per_page` can't end the walk early.
    if (totalPages === null && body.length < perPage) break;
  }

  return { urls: [...urls], total, truncated };
}

/**
 * Fetches a single product from the REST API by URL slug and parses it.
 * Returns null on any failure so the engine falls through to the HTML
 * extractor chain — a locked or flaky API never loses a product silently.
 */
export async function fetchWooCommerceProductBySlug(
  origin: string,
  slug: string,
  options: HttpOptions,
): Promise<CrawledProduct | null> {
  const url = `${origin}${API_PATH}?slug=${encodeURIComponent(slug)}&status=publish`;
  try {
    const response = await fetchWithRetry(url, options);
    if (!response.ok || !isJsonResponse(response)) return null;
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body) || body.length === 0) return null;
    return parseWooCommerceProduct(body[0] as RawWooProduct, origin);
  } catch {
    return null;
  }
}

/** Maps a raw WooCommerce REST product into a CrawledProduct. */
export function parseWooCommerceProduct(
  raw: RawWooProduct,
  origin: string,
): CrawledProduct {
  const name = raw.name?.trim() || raw.slug || `Product ${raw.id}`;
  const price = toPrice(raw.price ?? raw.sale_price ?? raw.regular_price);
  const regular = toPrice(raw.regular_price);
  const gtin =
    raw.global_unique_id?.trim() ||
    raw.gtin?.trim() ||
    metaValue(raw.meta_data, /gtin|barcode|ean|upc/i) ||
    "";
  const url =
    raw.permalink ||
    `${origin}/product/${encodeURIComponent(raw.slug ?? String(raw.id))}`;
  const available = (raw.stock_status ?? "instock") !== "outofstock";

  return {
    id: raw.id,
    handle: raw.slug || String(raw.id),
    url,
    name,
    brand: "",
    category: raw.categories?.[0]?.name ?? "",
    description: stripHtml(raw.description ?? ""),
    tags: [],
    image: raw.images?.[0]?.src ?? null,
    price,
    // WooCommerce `price` already reflects a live sale, so the regular price
    // is the compare-at reference whenever it is higher.
    compareAtPrice: regular > price ? regular : null,
    available,
    // Single "Default" variant mirrors the extractor chain's convention so
    // SKU/GTIN survive into `CrawledProduct.variants[0]` like other paths.
    variants: [
      {
        id: 0,
        title: "Default",
        sku: (raw.sku ?? "").trim(),
        price,
        compareAtPrice: regular > price ? regular : null,
        available,
        inventoryQuantity: available ? 1 : 0,
        barcode: gtin,
      },
    ],
    createdAt: raw.date_created ?? "",
    updatedAt: raw.date_modified ?? "",
    crawledAt: new Date().toISOString(),
  };
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes(
    "application/json",
  );
}

/** Parses a WC price string ("29.99", "1,400", "") into a finite number. */
function toPrice(value: string | null | undefined): number {
  if (value == null) return 0;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Scans meta_data for a value whose key matches `re` (GTIN/barcode etc.). */
function metaValue(
  meta: RawWooProduct["meta_data"],
  re: RegExp,
): string | undefined {
  for (const m of meta ?? []) {
    if (m && typeof m.value === "string" && re.test(m.key) && m.value.trim()) {
      return m.value.trim();
    }
  }
  return undefined;
}
