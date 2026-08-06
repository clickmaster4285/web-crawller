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
  getCrawlResultsData,
  getInsightsData,
  getMatchedProductsData,
  getPricingData,
  getReportsData,
  MATCHER_STALE_TIME,
  queryKeys,
  type SavedCrawlMeta,
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

export function useReports() {
  return useApiQuery(queryKeys.reports, () => getReportsData());
}

/**
 * Persisted crawl results (one per origin) from GET /api/data/crawl-results.
 *
 * Polls every 30s so results saved by *scheduled* crawls (which run as
 * internal jobs the page never polls) still show up without a manual
 * reload; on-demand crawls also invalidate this query on persist.
 */
export function useSavedCrawls() {
  const query = useQuery({
    queryKey: queryKeys.savedCrawls,
    queryFn: () => getCrawlResultsData(),
    refetchInterval: 30_000,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Lightweight crawl summaries (`?meta=1`) — origins, platform, product count
 * and timestamps only, no product catalogues. Ideal for store pickers and
 * competitor lists: a full crawl dump of 45k products (~10 MB) becomes ~10 KB.
 */
export function useSavedCrawlMetas() {
  const query = useQuery({
    queryKey: queryKeys.savedCrawlMetas,
    queryFn: () => getCrawlResultsData<SavedCrawlMeta>({ meta: true }),
    refetchInterval: 30_000,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
