/**
 * Per-domain data hooks. All data is fetched from the server API layer
 * (`src/api/*`) via TanStack Query — nothing imports mock data directly
 * anymore.
 *
 * Each hook returns `{ data, isLoading, isError }` so pages can distinguish a
 * server failure from a load in progress (rather than showing an infinite
 * loading state when a server function fails).
 *
 * Query defaults (staleTime, refetchOnWindowFocus, retry) live on the
 * QueryClient in `src/router.tsx`; the heavy matcher-backed endpoints get a
 * longer per-hook staleTime here so they're only recomputed when they change.
 */

import { useQuery } from "@tanstack/react-query";

import {
  getCatalogueData,
  getCompetitorsData,
  getInsightsData,
  getMatchedProductsData,
  getMetricsData,
  getPricingData,
  getReportsData,
  getStores,
  MATCHER_STALE_TIME,
  queryKeys,
} from "@/api";

function useApiQuery<T>(
  key: readonly unknown[],
  queryFn: () => Promise<T>,
  options: { staleTime?: number } = {},
) {
  const query = useQuery({
    queryKey: key,
    queryFn,
    ...(options.staleTime != null ? { staleTime: options.staleTime } : {}),
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useCompetitors() {
  return useApiQuery(queryKeys.competitors, () => getCompetitorsData());
}

export function useMatchedProducts() {
  return useApiQuery(
    queryKeys.matchedProducts,
    () => getMatchedProductsData(),
    { staleTime: MATCHER_STALE_TIME },
  );
}

export function usePricing() {
  return useApiQuery(queryKeys.pricing, () => getPricingData(), {
    staleTime: MATCHER_STALE_TIME,
  });
}

export function useCatalogue() {
  return useApiQuery(queryKeys.catalogue, () => getCatalogueData(), {
    staleTime: MATCHER_STALE_TIME,
  });
}

export function useInsights() {
  return useApiQuery(queryKeys.insights, () => getInsightsData());
}

/**
 * Crawl-job health snapshot (queue depth, worker liveness, 24h/7d
 * throughput) — the /metrics dashboard. Polls every 10s so the numbers stay
 * live without hammering the backend (the response is a handful of
 * aggregations).
 */
export function useMetrics() {
  const query = useQuery({
    queryKey: queryKeys.metrics,
    queryFn: () => getMetricsData(),
    refetchInterval: 10_000,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useReports() {
  return useApiQuery(queryKeys.reports, () => getReportsData());
}

/**
 * Every crawled store, meta only — the D1 read path (GET /api/stores)
 * replacing the legacy crawl summaries (`?meta=1`). Polls every 30s so
 * results saved by *scheduled* crawls (which run as internal jobs the page
 * never polls) still show up without a manual reload; on-demand crawls also
 * invalidate this query on persist.
 */
export function useStores() {
  const query = useQuery({
    queryKey: queryKeys.stores,
    queryFn: () => getStores(),
    refetchInterval: 30_000,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Every crawled store WITH its snapshot history embedded (metadata only, no
 * product catalogues) — the /crawls saved-history page. One request serves
 * the whole list (D1).
 */
export function useStoresWithSnapshots() {
  const query = useQuery({
    queryKey: queryKeys.storesWithSnapshots,
    queryFn: () => getStores({ withSnapshots: true }),
    refetchInterval: 30_000,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
