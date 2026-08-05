/**
 * BigCommerce native Storefront API adapter (Tier 3).
 *
 * BigCommerce exposes a public catalogue endpoint at
 * `/api/storefront/catalog/products` — the same lightweight product source
 * its own themes use. It is the highest-fidelity product source available
 * for these stores: structured `sku`, `price` vs `calculated_price` (live
 * sale price), `availability`, `custom_url` and `brand` — far more reliable
 * than scraping HTML. It normally needs no API credentials, but a store can
 * disable it, so this adapter is honest about which case it hit:
 *
 *   - `probeBigCommerceApi` — one polite request to decide
 *     `public | auth-required | unavailable`.
 *   - `discoverBigCommerceProducts` — walks the paginated catalogue
 *     (`limit=250`, `pagination.total`/`pagination.total_pages`) collecting
 *     product URLs for the engine's normal discovery URL set, plus a
 *     URL → id map so the fetch loop can pull structured JSON for exactly
 *     the URLs discovery found.
 *   - `fetchBigCommerceProductById` — per-product JSON fetch used by the
 *     fetch loop when the API is public, so products parse with structured
 *     SKU/price/stock instead of HTML heuristics.
 *   - `parseBigCommerceProduct` — maps a raw Storefront product into the
 *     vendor-neutral `CrawledProduct` shape.
 *
 * When the API is unavailable (disabled / redirected / credential-gated),
 * the engine records it in the discovery diagnostics and continues with
 * sitemap/HTML discovery — a crawl never fails because of a locked API. The
 * per-product item route (`/api/storefront/catalog/products/{id}`) is not
 * guaranteed to exist on every store, so `fetchBigCommerceProductById`
 * returns null on any failure and the fetch loop falls through to the HTML
 * extractor chain — a missing item route costs fidelity, never products.
 */

import { fetchWithRetry } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";
import type { CrawledProduct } from "../core/types.ts";

/** A product as returned by `/api/storefront/catalog/products` (fields we use). */
export interface RawBigCommerceProduct {
  id: number;
  name: string;
  sku?: string;
  /** Base (list) price. */
  price?: number;
  /** Effective selling price — already reflects any live sale. */
  calculated_price?: number;
  availability?: "available" | "disabled" | "preorder" | string;
  custom_url?: { url?: string; is_customized?: boolean };
  primary_image?: { url?: string; url_standard?: string };
  brand?: { url?: string; name?: string } | null;
  description?: string;
  date_created?: string;
  date_modified?: string;
  inventory_level?: number;
}

/** The pagination envelope the Storefront API returns alongside `data`. */
interface StorefrontPagination {
  total?: number;
  count?: number;
  per_page?: number;
  current_page?: number;
  total_pages?: number;
}

/** Outcome of the one-request Storefront API probe. */
export interface BigCommerceApiProbe {
  status: "public" | "auth-required" | "unavailable";
  /** Total products the API reports (`pagination.total`), when known. */
  total: number | null;
  /** Human-readable detail (auth hint or probe failure). */
  message?: string;
}

const API_PATH = "/api/storefront/catalog/products";

/** BigCommerce caps the Storefront catalogue at 250 products per page. */
const PER_PAGE = 250;
/** Hard cap so a misbehaving API can't balloon a crawl's discovery phase. */
const MAX_API_PRODUCTS = 10_000;
const MAX_API_PAGES = 100;

/**
 * One polite request to `/api/storefront/catalog/products?limit=1` to decide
 * whether the store's Storefront API is usable without credentials. Never
 * throws.
 */
export async function probeBigCommerceApi(
  origin: string,
  options: HttpOptions,
): Promise<BigCommerceApiProbe> {
  const url = `${origin}${API_PATH}?limit=1`;
  // robots.txt can disallow /api/storefront/ (some stores block API probing).
  if (options.isAllowed && !options.isAllowed(url)) {
    return {
      status: "unavailable",
      total: null,
      message: "robots.txt disallows /api/storefront/",
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
      message: "Storefront API requires credentials",
    };
  }
  if (response.status === 404) {
    return {
      status: "unavailable",
      total: null,
      message: "no BigCommerce Storefront API at /api/storefront/catalog",
    };
  }
  if (!isJsonResponse(response)) {
    return {
      status: "unavailable",
      total: null,
      message: "/api/storefront/catalog did not return JSON",
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      status: "unavailable",
      total: null,
      message: "unparseable Storefront response",
    };
  }
  const envelope = body as {
    data?: unknown;
    pagination?: StorefrontPagination;
  };
  if (!envelope || !Array.isArray(envelope.data)) {
    return {
      status: "unavailable",
      total: null,
      message: "unexpected Storefront response shape",
    };
  }
  const total =
    typeof envelope.pagination?.total === "number"
      ? envelope.pagination.total
      : null;
  return { status: "public", total };
}

/**
 * Walks the paginated BigCommerce catalogue and returns every product's URL
 * (deduped) plus a URL → id map, so the URLs feed the engine's normal
 * discovery set and the fetch loop can look products up by id. Stops on an
 * empty/short page, a non-JSON response, or the safety caps.
 */
export async function discoverBigCommerceProducts(
  origin: string,
  options: HttpOptions,
  maxProducts = MAX_API_PRODUCTS,
): Promise<{
  urls: string[];
  total: number | null;
  truncated: boolean;
  byUrl: Map<string, number>;
}> {
  const urls = new Set<string>();
  const byUrl = new Map<string, number>();
  const seen = new Set<number>();
  let total: number | null = null;
  let totalPages: number | null = null;
  let truncated = false;

  for (let page = 1; page <= MAX_API_PAGES; page++) {
    // Stop at the page count the API itself reported (`pagination.total_pages`)
    // — the reliable signal, unlike guessing from item counts.
    if (totalPages !== null && page > totalPages) break;
    if (urls.size >= maxProducts) {
      truncated = true;
      break;
    }
    const url = `${origin}${API_PATH}?limit=${PER_PAGE}&page=${page}`;
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
    const envelope = body as {
      data?: unknown;
      pagination?: StorefrontPagination;
    };
    if (!envelope || !Array.isArray(envelope.data)) break;

    if (page === 1) {
      if (typeof envelope.pagination?.total === "number") {
        total = envelope.pagination.total;
      }
      if (typeof envelope.pagination?.total_pages === "number") {
        totalPages = envelope.pagination.total_pages;
      }
    }
    for (const raw of envelope.data) {
      const product = raw as RawBigCommerceProduct;
      if (!product || typeof product !== "object" || !product.id) continue;
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      const productUrl = productUrlOf(product, origin);
      urls.add(productUrl);
      // Remember URL → id so the fetch loop can pull structured JSON for
      // exactly the URLs discovery found (no slug guessing).
      byUrl.set(productUrl, product.id);
    }
    // Fallback when the API omits `total_pages`: a page with fewer items than
    // requested is the last one.
    if (totalPages === null && envelope.data.length < PER_PAGE) break;
  }

  return { urls: [...urls], total, truncated, byUrl };
}

/**
 * Fetches a single product from the Storefront API by id and parses it.
 * Returns null on any failure so the engine falls through to the HTML
 * extractor chain — a flaky API never loses a product silently.
 */
export async function fetchBigCommerceProductById(
  origin: string,
  id: number,
  options: HttpOptions,
): Promise<CrawledProduct | null> {
  const url = `${origin}${API_PATH}/${encodeURIComponent(id)}`;
  try {
    const response = await fetchWithRetry(url, options);
    if (!response.ok || !isJsonResponse(response)) return null;
    const body = (await response.json()) as {
      data?: RawBigCommerceProduct | null;
    };
    if (!body || typeof body.data !== "object" || body.data == null) {
      return null;
    }
    return parseBigCommerceProduct(body.data, origin);
  } catch {
    return null;
  }
}

/** Maps a raw BigCommerce Storefront product into a CrawledProduct. */
export function parseBigCommerceProduct(
  raw: RawBigCommerceProduct,
  origin: string,
): CrawledProduct {
  const name = raw.name?.trim() || `Product ${raw.id}`;
  // `calculated_price` is the effective selling price (after sales); `price`
  // is the base price, which becomes the compare-at reference when higher.
  const price = toPrice(raw.calculated_price ?? raw.price);
  const base = toPrice(raw.price);
  const available = (raw.availability ?? "available") === "available";

  return {
    id: raw.id,
    handle: productSlugOf(raw, name),
    url: productUrlOf(raw, origin),
    name,
    brand: raw.brand?.name ?? "",
    category: "",
    description: stripHtml(raw.description ?? ""),
    tags: [],
    image: raw.primary_image?.url ?? raw.primary_image?.url_standard ?? null,
    price,
    // BigCommerce doesn't expose GTIN/barcodes on the Storefront catalogue,
    // so the identity tier falls back to SKU/slug/fuzzy (barcode stays "").
    compareAtPrice: base > price ? base : null,
    available,
    // Single "Default" variant mirrors the extractor chain's convention so
    // SKU/availability survive into `CrawledProduct.variants[0]`.
    variants: [
      {
        id: 0,
        title: "Default",
        sku: (raw.sku ?? "").trim(),
        price,
        compareAtPrice: base > price ? base : null,
        available,
        inventoryQuantity: available ? (raw.inventory_level ?? 1) : 0,
        barcode: "",
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

/** Parses a BC price (number or "1,400"-style string) into a finite number. */
function toPrice(value: number | string | null | undefined): number {
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

/** The product's page URL: `custom_url.url` when set, else `/{slug}/`. */
function productUrlOf(raw: RawBigCommerceProduct, origin: string): string {
  const custom = raw.custom_url?.url?.trim();
  if (custom) {
    // Documented as relative (`/jacket/`), but guard against an absolute URL
    // so we never produce `${origin}/https://…`.
    if (/^https?:\/\//i.test(custom)) return custom;
    return `${origin}${custom.startsWith("/") ? custom : `/${custom}`}`;
  }
  return `${origin}/${productSlugOf(raw, "")}/`;
}

/** Lowercase-dash slug from the product name (BigCommerce has no slug field). */
function productSlugOf(raw: RawBigCommerceProduct, name: string): string {
  const base = name || raw.name || "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || String(raw.id);
}
