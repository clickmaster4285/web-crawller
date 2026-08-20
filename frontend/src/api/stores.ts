import { http } from "@/lib/http";
import type { StoreHealth } from "@/lib/crawl";

/**
 * REST client for the Phase 5 store read path (`/api/stores`, architecture
 * §6) — backed by the normalized collections (Store / Product / Snapshot /
 * ProductEvent). The legacy crawlresults collection is no longer read
 * (decision D1). `:key` is the normalized host (matches `normalizeOrigin`).
 */

/** Per-strategy discovery diagnostics captured during a crawl run (shared
 *  by the legacy SavedCrawl shape and the normalized Snapshot — D1). */
export interface CrawlDiscovery {
  collections: Array<{ collection: string; handles: number; error?: string }>;
  sitemap: {
    urls: number;
    lastmod: number;
    error?: string;
    /** Sitemap candidates tried (robots.txt-declared first), with outcomes. */
    candidates?: Array<{
      url: string;
      source: "robots.txt" | "default";
      status: "ok" | "html" | "error";
      urls: number;
      productUrls: number;
      error?: string;
    }>;
  };
  htmlCrawl: {
    urls: number;
    pagesVisited: number;
    truncated: boolean;
    error?: string;
  };
  /** Detected store platform (Shopify/WooCommerce/…) plus the signal used. */
  platform?: {
    platform: string;
    signal: string;
    kind?: "store" | "corporate" | "unknown";
    cms?: string;
    builder?: string;
    seoPlugin?: string;
    server?: string;
    generator?: string;
  };
  /** robots.txt presence + declared crawl-delay (absent for old crawls). */
  robots?: {
    status: "found" | "absent" | "unreachable" | "skipped";
    crawlDelayMs: number | null;
  };
  /** Homepage analysis (store vs corporate, external store links). */
  homepage?: {
    productLinks: number;
    categoryLinks: number;
    looksLikeStore: boolean;
    externalStoreLinks: Array<{ url: string; host: string; label: string }>;
    note: string;
  };
  /** WooCommerce native REST API outcome (Tier 3), when probed. */
  wooCommerce?: {
    status: "public" | "auth-required" | "unavailable";
    total: number | null;
    urls: number;
    message?: string;
  };
  /** BigCommerce Storefront API outcome (Tier 3), when probed. */
  bigCommerce?: {
    status: "public" | "auth-required" | "unavailable";
    total: number | null;
    urls: number;
    message?: string;
  };
  /** Human-readable findings/suggestions surfaced to the user. */
  findings?: Array<{
    level: "info" | "warning" | "success";
    message: string;
    action?: { label: string; url: string };
  }>;
  /** Verbose discovery log (what the crawler did, in order). */
  log?: string[];
}

/** Meta-only summary of one crawled store. */
export interface StoreSummary {
  _id: string;
  key: string;
  origin: string;
  name: string;
  platform: {
    platform: string;
    signal: string;
    kind: "store" | "corporate" | "unknown";
  } | null;
  productCount: number;
  lastCrawl: {
    at: string;
    type: "shallow" | "deep" | null;
    status: string;
    durationMs: number;
    productCount: number;
  } | null;
  lastShallowAt: string | null;
  lastDeepAt: string | null;
  cadence: { enabled: boolean; shallowHours: number; deepHours: number };
  scheduledFrequency: "1h" | "6h" | "daily" | "weekly" | null;
  /**
   * P4 store-health pass: last pre-flight verdict (healthy / no-products /
   * blocked / corporate / unclear) — flags 0-product stores on the Sources
   * profile and /crawls list without a fresh analysis. Null when never
   * analyzed.
   */
  health: StoreHealth | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * Snapshot history (metadata only, newest first) — present only when the
   * list was fetched with `withSnapshots: true` (the /crawls history page).
   */
  snapshots?: StoreSnapshot[];
}

/** One row of the product catalogue (never full docs). */
export interface StoreProduct {
  _id: string;
  identityKey: string;
  name: string;
  brand: string;
  category: string;
  price: number | null;
  compareAtPrice: number | null;
  /** ISO 4217 native currency (null = not detected — no silent USD). */
  currency: string | null;
  /** Price converted to USD at ingest; null when the rate/currency was unknown. */
  priceUsd?: number | null;
  available: boolean;
  url: string;
  image: string;
  sku?: string;
  gtin?: string;
  slug?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  priceUpdatedAt: string | null;
  /** Last ~30 price points — enough for a sparkline. */
  priceHistory: Array<{ t: string; price: number; available: boolean }>;
}

/** Metadata-only snapshot (no product arrays — the catalogue lives in
 *  Product; history is this doc plus ProductEvent rows). */
export interface StoreSnapshot {
  _id: string;
  origin: string;
  key: string;
  startedAt: string | null;
  finishedAt: string;
  durationMs: number;
  stats: {
    discovered: number;
    fetched: number;
    skippedUnchanged: number;
    failed: number;
    durationMs: number;
  };
  /** false = shallow sitemap-only check (partial catalogue). */
  full: boolean;
  productCount: number;
  addedCount: number;
  removedCount: number;
  priceChangedCount: number;
  stockChangedCount: number;
  addedKeys: string[];
  removedKeys: string[];
  discovery: CrawlDiscovery | null;
  failures: Array<{ url: string; error: string }>;
}

/** Change-log event row (added / removed / price_changed / stock_changed). */
export interface StoreEvent {
  _id: string;
  type: "added" | "removed" | "price_changed" | "stock_changed";
  productId: string;
  identityKey: string;
  name: string;
  url: string;
  old: { price?: number; available?: boolean } | null;
  new: { price?: number; available?: boolean } | null;
  snapshotId: string | null;
  at: string;
}

/** Profile read — the store record plus its newest snapshot. */
export interface StoreProfileData {
  store: StoreSummary | null;
  latestSnapshot: StoreSnapshot | null;
}

/** Wrapper for the paginated endpoints (products / events). */
export interface StorePageResponse<T> {
  success: boolean;
  count: number;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface StoreProductsParams {
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface StoreEventsParams {
  since?: string;
  type?: StoreEvent["type"];
  limit?: number;
  cursor?: string;
}

/**
 * Lists every crawled store (meta only). Pass `withSnapshots: true` to also
 * embed each store's snapshot history (the /crawls page's one-shot read).
 */
export const getStores = (params: { withSnapshots?: boolean } = {}) => {
  const qs = new URLSearchParams();
  if (params.withSnapshots) qs.set("withSnapshots", "1");
  const query = qs.toString();
  return http.get<{ success: boolean; count: number; data: StoreSummary[] }>(
    `/stores${query ? `?${query}` : ""}`,
  );
};

/**
 * Deletes a store from the normalized collections (Store / Product /
 * Snapshot / ProductEvent). The frozen legacy crawlresults collection is
 * intentionally left untouched.
 */
export const deleteStore = (key: string) =>
  http.del<{
    success: boolean;
    data: {
      key: string;
      deleted: {
        products: number;
        snapshots: number;
        events: number;
      };
    };
  }>(`/stores/${encodeURIComponent(key)}`);

/** Fetches one store's profile (record + latest snapshot). */
export const getStore = (key: string) =>
  http.get<{ success: boolean; data: StoreProfileData }>(
    `/stores/${encodeURIComponent(key)}`,
  );

/** Cursor-paginated product catalogue for a store, with optional name search. */
export const getStoreProducts = (
  key: string,
  params: StoreProductsParams = {},
) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return http.get<StorePageResponse<StoreProduct>>(
    `/stores/${encodeURIComponent(key)}/products${query ? `?${query}` : ""}`,
  );
};

/** Snapshot metadata for a store, newest first. */
export const getStoreSnapshots = (
  key: string,
  params: { limit?: number } = {},
) => {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return http.get<{ success: boolean; count: number; data: StoreSnapshot[] }>(
    `/stores/${encodeURIComponent(key)}/snapshots${query ? `?${query}` : ""}`,
  );
};

/**
 * Deletes ONE snapshot from a store's history (the /crawls row's trash
 * button) — D1 replacement for the legacy per-snapshot delete.
 */
export const deleteStoreSnapshot = (key: string, id: string) =>
  http.del<{
    success: boolean;
    data: { deleted: boolean; id: string; key: string; origin: string };
  }>(`/stores/${encodeURIComponent(key)}/snapshots/${encodeURIComponent(id)}`);

/**
 * Clears a store's crawl history (snapshots only — the current catalogue is
 * untouched) — D1 replacement for the legacy clear-by-origin endpoint.
 */
export const deleteStoreSnapshots = (key: string) =>
  http.del<{
    success: boolean;
    data: { deleted: boolean; key: string; deletedCount: number };
  }>(`/stores/${encodeURIComponent(key)}/snapshots`);

/** Change-log events for a store ("what's new"), with since/type filters. */
export const getStoreEvents = (key: string, params: StoreEventsParams = {}) => {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.type) qs.set("type", params.type);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return http.get<StorePageResponse<StoreEvent>>(
    `/stores/${encodeURIComponent(key)}/events${query ? `?${query}` : ""}`,
  );
};
