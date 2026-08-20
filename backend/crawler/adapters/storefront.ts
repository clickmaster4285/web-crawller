/**
 * Headless storefront native API adapter (Tier 4).
 *
 * A modern GCC/Next.js storefront class (activefitnessstore.com and friends)
 * renders NO prices server-side — the pages are JS shells whose prices load
 * via a late XHR (`get-price` fires ~3s+ after networkidle), so even the
 * Playwright renderer extracts nothing. But these stores expose a native
 * JSON API over plain HTTP that returns EVERYTHING:
 *
 *   GET  {origin}/api/fetchPage?country={cc}&lang=en&page={slug}
 *        → { status, data: { product_id, catelogue_json_file_url,
 *            media_base_url, meta_image, … } }
 *   GET  {catelogue_json_file_url}            (products.{host}/…)
 *        → { basic: { product_sku, product_barcode, main_cat_name, … },
 *            en:   { product_name, brand: { brand_name }, long_desc, … },
 *            medias: [ { media_type, media_list_url, … } ] }
 *   POST {apiHost}/api/get-price              (batched!)
 *        { country, product_ids: [3,4,5,…] }
 *        → { data: [ { product_id, item_retail_price, item_sale_price,
 *            price_with_tax, website_stock, is_serviceable, … } ] }
 *
 * So a storefront-API crawl costs ~2 requests per product + 1 per ~100 for
 * prices — no browser, ~100% extraction — instead of a render per page that
 * yields nothing. The price API takes an ARRAY of ids, so prices are batched
 * (the single-request-per-product price calls would be 11k extra requests on
 * activefitnessstore).
 *
 * The probe is GENERIC, not store-specific: it triggers only on JS-shell
 * storefronts (the class where HTML + rendering both fail), derives a sample
 * country+slug from a discovered product URL, probes `/api/fetchPage`, then
 * finds the price API by probing conventional API subdomains (api./apiv2./
 * apiv3./apicore./apis.). Any store exposing this shape is picked up
 * automatically — no per-store config.
 */

import { fetchWithRetry } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";
import { waitForControl, type CrawlControl } from "../core/control.ts";
import { HostLimiter, hostOf, runWithConcurrency } from "../core/queue.ts";
import type { CrawledProduct } from "../core/types.ts";

/** Recipe a discovered storefront API hands the fetch loop. Plain JSON — persisted with discovery. */
export interface StorefrontApiRecipe {
  origin: string;
  /** Country token for fetchPage/price calls (e.g. "om"), when derivable. */
  country: string | null;
  /** Lang token (e.g. "en"). */
  lang: string;
  /** fetchPage path (e.g. "/api/fetchPage"). */
  fetchPagePath: string;
  /** Price API URL (POST {country, product_ids}), when found. */
  priceApiUrl: string | null;
  /** Base URL for catalogue JSON files (host from catelogue_json_file_url). */
  catalogueBaseUrl: string | null;
}

/** Outcome of the one-shot storefront API probe. */
export interface StorefrontApiProbe {
  status: "public" | "unavailable";
  recipe?: StorefrontApiRecipe;
  message?: string;
}

/** Per-URL product id + catalogue JSON URL from the fetchPage walk. */
export interface StorefrontUrlInfo {
  productId: number;
  /** Absolute catalogue JSON URL (protocol-normalized), when the page is a product. */
  catalogueUrl: string | null;
  /** media_base_url for image assembly. */
  mediaBaseUrl: string | null;
  /** meta_image (relative to mediaBaseUrl). */
  metaImage: string | null;
  /** Country this URL's prices come from (price batch key). */
  country: string | null;
}

/** A batched price row for one product id. */
export interface StorefrontPrice {
  productId: number;
  retail: number;
  sale: number;
  available: boolean;
}

/** Country tokens that appear as URL path prefixes (om/bh/qa/sa/kw/ae/eg…). */
const COUNTRY_PATH_RE = /^\/([a-z]{2})(?:-[a-z]{2})?\//;

/** Derives the country token from a storefront product URL path prefix. */
export function countryFromUrl(url: string): string | null {
  try {
    // Match against the PATH, not the full URL (which starts with https://).
    const m = new URL(url).pathname.match(COUNTRY_PATH_RE);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Last path segment of a product URL = the fetchPage `page` slug. */
function slugFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    return "";
  }
}

/** Normalizes a possibly protocol-less URL ("products.host/…") to https. */
function absoluteUrl(raw: string | null, fallbackOrigin: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Probes the storefront-API shape on `origin` using discovered product URLs
 * (country + slug come from them). Up to `MAX_PROBE_SAMPLES` fetchPage
 * attempts — the FIRST URL in a GCC sitemap is often a brand/category page
 * (`/om/kettler`), not a product, so the probe tries several until one
 * returns a real product payload. Then a bounded price-API candidate sweep
 * ONLY when fetchPage matched (so non-storefront stores pay ~1 request).
 * Never throws.
 */
export async function probeStorefrontApi(
  origin: string,
  options: HttpOptions,
  sampleUrls: string[],
  locale?: string,
): Promise<StorefrontApiProbe> {
  if (sampleUrls.length === 0) {
    return {
      status: "unavailable",
      message: "no sample product URL to probe with",
    };
  }
  const country = countryFromUrl(sampleUrls[0]) ?? locale ?? null;
  if (!country) {
    return {
      status: "unavailable",
      message: "no country token in the sample URL (set a locale to enable the storefront API)",
    };
  }
  const lang = "en";

  let fetchPage: {
    productId: number | null;
    catalogueUrl: string | null;
    mediaBaseUrl: string | null;
    metaImage: string | null;
  } | null = null;
  // GCC sitemaps can lead with dozens of brand/category pages (`/om/kettler`,
  // `/om/york-fitness`…) before the first real product — the probe must look
  // further than the first few URLs. 25 samples ≈ a spread across most
  // sitemap layouts while still bounding the probe on non-storefront stores.
  const MAX_PROBE_SAMPLES = 25;
  for (const sampleUrl of sampleUrls.slice(0, MAX_PROBE_SAMPLES)) {
    const slug = slugFromUrl(sampleUrl);
    if (!slug) continue;
    const fetchPageUrl = `${origin}/api/fetchPage?country=${encodeURIComponent(country)}&lang=${lang}&page=${encodeURIComponent(slug)}`;
    if (options.isAllowed && !options.isAllowed(fetchPageUrl)) {
      return {
        status: "unavailable",
        message: "robots.txt disallows /api/fetchPage",
      };
    }
    try {
      const response = await fetchWithRetry(fetchPageUrl, options);
      if (!isJsonResponse(response)) {
        return {
          status: "unavailable",
          message: `/api/fetchPage answered ${response.status} (not JSON)`,
        };
      }
      const body = (await response.json()) as {
        data?: {
          product_id?: number;
          catelogue_json_file_url?: string | null;
          media_base_url?: string | null;
          meta_image?: string | null;
        };
      };
      const data = body?.data;
      if (data && typeof data.product_id === "number" && data.catelogue_json_file_url) {
        fetchPage = {
          productId: data.product_id,
          catalogueUrl: data.catelogue_json_file_url,
          mediaBaseUrl: data.media_base_url ?? null,
          metaImage: data.meta_image ?? null,
        };
        break;
      }
    } catch {
      // Network error — try the next sample.
    }
  }
  if (!fetchPage) {
    return {
      status: "unavailable",
      message: "/api/fetchPage did not return a product payload (tried " +
        `${Math.min(sampleUrls.length, MAX_PROBE_SAMPLES)} URLs)`,
    };
  }

  // fetchPage matched — the store is a headless storefront. Now find the
  // price API among conventional API subdomains (apiv3.activefitnessstore.com
  // is the real host; api./apiv2./apicore./apis. are the conventional
  // alternatives). Each candidate is one POST; stop at the first JSON hit.
  const host = hostOf(origin);
  const candidates = [
    `${origin}/api/get-price`,
    `https://api.${host}/api/get-price`,
    `https://apiv2.${host}/api/get-price`,
    `https://apiv3.${host}/api/get-price`,
    `https://apicore.${host}/api/get-price`,
    `https://apis.${host}/api/get-price`,
  ];
  let priceApiUrl: string | null = null;
  for (const candidate of candidates) {
    try {
      const response = await fetchWithRetry(candidate, {
        ...options,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ country, product_ids: [fetchPage.productId] }),
      });
      if (!isJsonResponse(response)) continue;
      const body = (await response.json()) as {
        data?: Array<{ item_retail_price?: unknown; price?: unknown }>;
      };
      if (
        Array.isArray(body?.data) &&
        body.data.length > 0 &&
        ("item_retail_price" in body.data[0] || "price" in body.data[0])
      ) {
        priceApiUrl = candidate;
        break;
      }
    } catch {
      // Candidate down — try the next conventional host.
    }
  }

  const recipe: StorefrontApiRecipe = {
    origin,
    country,
    lang,
    fetchPagePath: "/api/fetchPage",
    priceApiUrl,
    catalogueBaseUrl: absoluteUrl(fetchPage.catalogueUrl, origin)?.split("/products/")[0] ?? null,
  };
  return {
    status: "public",
    recipe,
    message: priceApiUrl
      ? "storefront API public (fetchPage + batched get-price)"
      : "storefront API public (fetchPage only — prices via HTML fallback)",
  };
}

/**
 * Walk 1 of the storefront path: fetchPage per URL → product id + catalogue
 * JSON URL. Runs with the same per-host concurrency + control as the fetch
 * loop. URLs whose fetchPage call fails or returns a non-product page are
 * simply NOT indexed — they fall through to the normal fetch chain.
 */
export async function indexStorefrontProducts(
  urls: string[],
  recipe: StorefrontApiRecipe,
  options: HttpOptions,
  concurrency: number,
  control?: CrawlControl,
  onProgress?: (indexed: number, total: number) => void,
): Promise<{ byUrl: Map<string, StorefrontUrlInfo> }> {
  const limiter = new HostLimiter(concurrency);
  const byUrl = new Map<string, StorefrontUrlInfo>();
  let indexed = 0;
  await runWithConcurrency(urls, concurrency, async (url) => {
    await waitForControl(control);
    const country = countryFromUrl(url) ?? recipe.country;
    if (!country) return;
    const slug = slugFromUrl(url);
    const fetchPageUrl = `${recipe.origin}${recipe.fetchPagePath}?country=${encodeURIComponent(country)}&lang=${recipe.lang}&page=${encodeURIComponent(slug)}`;
    const host = hostOf(fetchPageUrl);
    await limiter.acquire(host);
    try {
      if (options.isAllowed && !options.isAllowed(fetchPageUrl)) return;
      const response = await fetchWithRetry(fetchPageUrl, options);
      if (!isJsonResponse(response)) return;
      const body = (await response.json()) as {
        data?: {
          product_id?: number;
          catelogue_json_file_url?: string | null;
          media_base_url?: string | null;
          meta_image?: string | null;
        };
      };
      const data = body?.data;
      if (!data || typeof data.product_id !== "number") return;
      const catalogueUrl = absoluteUrl(
        data.catelogue_json_file_url ?? null,
        recipe.origin,
      );
      byUrl.set(url, {
        productId: data.product_id,
        catalogueUrl,
        mediaBaseUrl: data.media_base_url ?? null,
        metaImage: data.meta_image ?? null,
        country,
      });
    } catch {
      // fetchPage failed for this URL — leave it to the normal chain.
    } finally {
      limiter.release(host);
      indexed++;
      onProgress?.(indexed, urls.length);
    }
  });
  return { byUrl };
}

/**
 * Walk 2: batch `get-price` calls — ONE request per ~100 product ids (the
 * price API accepts an array). Returns id → price for every id the API
 * answered. Requests are chunked per country (prices differ per region).
 */
export async function fetchStorefrontPrices(
  recipe: StorefrontApiRecipe,
  byUrl: Map<string, StorefrontUrlInfo>,
  options: HttpOptions,
  control?: CrawlControl,
): Promise<Map<number, StorefrontPrice>> {
  const prices = new Map<number, StorefrontPrice>();
  const priceApiUrl = recipe.priceApiUrl;
  if (!priceApiUrl) return prices;

  // Group ids by country (a multi-region store has per-region prices).
  const idsByCountry = new Map<string, number[]>();
  for (const info of byUrl.values()) {
    const cc = info.country ?? recipe.country;
    if (cc == null) continue;
    if (!idsByCountry.has(cc)) idsByCountry.set(cc, []);
    idsByCountry.get(cc)!.push(info.productId);
  }

  const CHUNK = 100;
  for (const [country, ids] of idsByCountry) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await waitForControl(control);
      const chunk = ids.slice(i, i + CHUNK);
      try {
        const response = await fetchWithRetry(priceApiUrl, {
          ...options,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ country, product_ids: chunk }),
        });
        if (!isJsonResponse(response)) continue;
        const body = (await response.json()) as {
          data?: Array<{
            product_id?: number;
            item_retail_price?: string | number | null;
            item_sale_price?: string | number | null;
            price_with_tax?: string | number | null;
            website_stock?: number | null;
            is_serviceable?: boolean;
          }>;
        };
        for (const row of body?.data ?? []) {
          if (typeof row.product_id !== "number") continue;
          const retail = toPrice(row.item_retail_price);
          const sale =
            toPrice(row.price_with_tax) || toPrice(row.item_sale_price) || retail;
          prices.set(row.product_id, {
            productId: row.product_id,
            retail,
            sale,
            available: (row.website_stock ?? 0) > 0 || row.is_serviceable === true,
          });
        }
      } catch {
        // Price batch failed — those products fall back to retail-only (or 0).
      }
    }
  }
  return prices;
}

/**
 * Fetches the catalogue JSON for one indexed URL and maps it (plus the batched
 * price) into a CrawledProduct. Returns null when the catalogue is missing or
 * unparseable (the caller records an extraction miss).
 */
export async function fetchStorefrontProduct(
  url: string,
  info: StorefrontUrlInfo,
  price: StorefrontPrice | undefined,
  options: HttpOptions,
): Promise<CrawledProduct | null> {
  if (!info.catalogueUrl) return null;
  const response = await fetchWithRetry(info.catalogueUrl, options);
  if (!isJsonResponse(response)) return null;
  const body = (await response.json()) as StorefrontCatalogue;
  return parseStorefrontProduct(url, info, price, body);
}

/** Raw shape of the catalogue JSON file. */
interface StorefrontCatalogue {
  basic?: {
    product_sku?: string;
    product_barcode?: string;
    main_cat_name?: string;
    cat_name?: string;
  };
  en?: {
    product_name?: string;
    brand?: { brand_name?: string };
    long_desc?: string;
    short_desc?: string;
  };
  medias?: Array<{
    media_type?: string;
    media_url?: string;
    media_list_url?: string;
  }>;
}

/** Maps a catalogue JSON + batched price into the vendor-neutral product shape. */
export function parseStorefrontProduct(
  url: string,
  info: StorefrontUrlInfo,
  price: StorefrontPrice | undefined,
  raw: StorefrontCatalogue,
): CrawledProduct | null {
  const basic = raw.basic ?? {};
  const en = raw.en ?? {};
  const name = en.product_name?.trim() || slugFromUrl(url);
  if (!name) return null;

  const handle = slugFromUrl(url);
  const finalPrice = price?.sale ?? 0;
  const compareAt =
    price && price.retail > finalPrice && price.retail > 0 ? price.retail : null;
  const available = price?.available ?? true;

  // First image media: prefer the list-size URL (consistent with the
  // extractor chain's convention); the media_base_url comes from fetchPage.
  const media = (raw.medias ?? []).find(
    (m) => !m.media_type || m.media_type === "image",
  );
  const mediaRel = media?.media_list_url || media?.media_url;
  const image =
    mediaRel && info.mediaBaseUrl ? `${info.mediaBaseUrl}${mediaRel}` : null;

  const category = [basic.main_cat_name, basic.cat_name]
    .filter(Boolean)
    .join(" > ");
  const now = new Date().toISOString();

  return {
    id: info.productId,
    handle,
    url,
    name,
    brand: en.brand?.brand_name ?? "",
    category,
    description: stripHtml(en.long_desc ?? en.short_desc ?? ""),
    tags: [],
    image,
    price: finalPrice,
    compareAtPrice: compareAt,
    available,
    variants: [
      {
        id: 0,
        title: "Default",
        sku: (basic.product_sku ?? "").trim(),
        price: finalPrice,
        compareAtPrice: compareAt,
        available,
        inventoryQuantity: available ? 1 : 0,
        barcode: (basic.product_barcode ?? "").trim(),
      },
    ],
    createdAt: "",
    updatedAt: "",
    crawledAt: now,
  };
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes(
    "application/json",
  );
}

/** Parses a price string ("1545.00", "1,545") into a finite number. */
function toPrice(value: string | number | null | undefined): number {
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
