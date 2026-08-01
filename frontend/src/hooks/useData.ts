/**
 * Per-domain data hooks. All data is fetched from the server API layer
 * (`src/lib/api.ts`) via TanStack Query — nothing imports mock data directly
 * anymore.
 *
 * Each hook returns `{ data, isLoading, isError }` so pages can distinguish a
 * server failure from a load in progress (rather than showing an infinite
 * loading state when a server function fails).
 */

import { useQuery } from "@tanstack/react-query";

import {
  getAlertsData,
  getCatalogueData,
  getCompetitorsData,
  getCrawlResultsData,
  getInsightsData,
  getMatchedProductsData,
  getPricingData,
  getReportsData,
} from "@/lib/api";

function useApiQuery<T>(key: string, queryFn: () => Promise<T>) {
  const query = useQuery({ queryKey: [key], queryFn });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useCompetitors() {
  return useApiQuery("competitors", () => getCompetitorsData());
}

export function useMatchedProducts() {
  return useApiQuery("matched-products", () => getMatchedProductsData());
}

export function usePricing() {
  return useApiQuery("pricing", () => getPricingData());
}

export function useCatalogue() {
  return useApiQuery("catalogue", () => getCatalogueData());
}

export function useInsights() {
  return useApiQuery("insights", () => getInsightsData());
}

export function useAlerts() {
  return useApiQuery("alerts", () => getAlertsData());
}

export function useReports() {
  return useApiQuery("reports", () => getReportsData());
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
    queryKey: ["saved-crawls"],
    queryFn: () => getCrawlResultsData(),
    refetchInterval: 30_000,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
