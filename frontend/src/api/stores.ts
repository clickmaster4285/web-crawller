import { http } from "@/lib/http";

/**
 * REST client for the Phase 5 store read path (`/api/stores`, architecture
 * §6) — backed by the normalized collections (Store / Product / Snapshot /
 * ProductEvent) so the UI can leave the legacy `CrawlResult` dumps (decision
 * D1). `:key` is the normalized host (matches `normalizeOrigin`).
 */

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
  createdAt: string | null;
  updatedAt: string | null;
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
  currency: string;
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

/** Metadata-only snapshot (no product arrays). */
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
  discovery: unknown | null;
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

/** Lists every crawled store (meta only). */
export const getStores = () =>
  http.get<{ success: boolean; count: number; data: StoreSummary[] }>(
    "/stores",
  );

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
