import type { QueryClient } from "@tanstack/react-query";

/**
 * Centralized TanStack Query keys — every page and hook reads from here so
 * query keys can never drift apart (e.g. a poll key vs an invalidation key).
 */
export const queryKeys = {
  workspace: ["workspace"] as const,
  analytics: ["analytics"] as const,
  competitors: ["competitors"] as const,
  matchedProducts: ["matched-products"] as const,
  pricing: ["pricing"] as const,
  catalogue: ["catalogue"] as const,
  insights: ["insights"] as const,
  alerts: ["alerts"] as const,
  reports: ["reports"] as const,
  myStore: ["my-store"] as const,
  savedCrawls: ["saved-crawls"] as const,
  savedCrawlMetas: ["saved-crawls-meta"] as const,
  // Server-side persisted matches read by the /competitors ComparePanel
  // (GET /api/match). Keyed queries nest under this prefix so invalidating
  // it refreshes every competitor's comparison at once.
  competitorMatches: ["competitor-matches"] as const,
  // Phase 5 store read path (Store/Product/Snapshot/Event). Keyed queries
  // nest under the "stores" prefix so invalidating it refreshes them all.
  stores: ["stores"] as const,
  store: (key: string) => ["stores", key] as const,
  storeProducts: (key: string) => ["stores", key, "products"] as const,
  storeSnapshots: (key: string) => ["stores", key, "snapshots"] as const,
  storeEvents: (key: string) => ["stores", key, "events"] as const,
} as const;

/**
 * Matcher-backed endpoints (server-side product matching) cost ~1.5s each and
 * only change when crawls run or your store changes — keep them fresh longer
 * than the global default so pages reuse cached results across visits.
 */
export const MATCHER_STALE_TIME = 60_000;

/** Every query derived from saved crawl snapshots. */
const crawlDataKeys = [
  queryKeys.savedCrawls,
  queryKeys.savedCrawlMetas,
  queryKeys.analytics,
  queryKeys.competitors,
  queryKeys.matchedProducts,
  queryKeys.pricing,
  queryKeys.catalogue,
  // The alerts feed derives from ProductEvent rows written at ingest.
  queryKeys.alerts,
  // The Phase 5 store read path is derived from the same crawled data
  // (prefix match invalidates every /stores/:key query).
  queryKeys.stores,
  // The /competitors comparisons read persisted ProductMatch rows written
  // at ingest — a crawl may have added/removed/renamed products.
  queryKeys.competitorMatches,
] as const;

/** Queries derived from the matching layer (competitors / your store) only. */
const matchingDataKeys = [
  queryKeys.competitors,
  queryKeys.matchedProducts,
  queryKeys.analytics,
  queryKeys.pricing,
  queryKeys.catalogue,
  // Persisted match rows depend on "your website" — re-scope them on change.
  queryKeys.competitorMatches,
] as const;

/**
 * Invalidates every query derived from saved crawl data — call this after a
 * crawl is saved, deleted or cleared so every page reflects fresh data
 * without a manual reload. Only queries currently mounted refetch
 * immediately; the rest refetch on their next visit.
 */
export function invalidateCrawlData(client: QueryClient) {
  for (const key of crawlDataKeys) {
    void client.invalidateQueries({ queryKey: key });
  }
}

/**
 * Invalidates the matching-layer queries only (not the saved crawl
 * snapshots) — for changes like setting "your website" or editing the
 * competitor list, where the crawl data itself is untouched.
 */
export function invalidateMatchingData(client: QueryClient) {
  for (const key of matchingDataKeys) {
    void client.invalidateQueries({ queryKey: key });
  }
}
