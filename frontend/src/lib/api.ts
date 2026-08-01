/**
 * Server API layer (Layer 3 — real backend).
 *
 * Every endpoint is a TanStack Start server function, so the frontend now
 * fetches real server responses instead of importing mock data directly.
 * Data currently originates from the demo dataset (`@/data/mock`) served on
 * the server; the shapes mirror what the live crawl pipeline will produce
 * once persistence is wired.
 *
 * `runCrawlNow` actually invokes the real crawler on the server.
 */

import { createServerFn } from "@tanstack/react-start";

import {
  alerts,
  brandGaps,
  categoryGaps,
  competitors,
  dashboardStats,
  insights,
  matchedProducts,
  priceHistory,
  reports,
  workspace,
} from "@/data/mock";
import type {
  AlertItem,
  BrandGap,
  CategoryGap,
  Competitor,
  Insight,
  MatchedProduct,
  PricePoint,
  ReportSummary,
  Workspace,
} from "@/types";

// ---------------------------------------------------------------------------
// Read-only data endpoints
// ---------------------------------------------------------------------------

export const getWorkspaceData = createServerFn({ method: "GET" }).handler(
  async (): Promise<Workspace> => workspace,
);

export interface AnalyticsData {
  hasData: boolean;
  stats: {
    competitors: number;
    productsTracked: number;
    yourProducts: number;
    matchedProducts: number;
    missingProducts: number;
    outOfStock: number;
    yourAvgPrice: number;
    marketAvgPrice: number;
    cheapestCompetitor: string;
    mostExpensiveCompetitor: string;
  };
  competitors: Array<{
    id: string;
    name: string;
    website: string;
    lastCrawl: string;
    products: number;
    avgPriceIndex: number;
  }>;
  matchedProducts: Array<{
    id: string;
    name: string;
    competitor: string;
    competitorPrice: number;
    yourPrice: number | null;
    gap: number | null;
  }>;
  priceHistory: PricePoint[];
  categoryGaps: Array<{ category: string; yours: number; theirs: number }>;
  brandGaps: BrandGap[];
}

/** The dashboard bundle consumed by the Overview page. */
export const getAnalyticsData = createServerFn({ method: "GET" }).handler(
  async (): Promise<AnalyticsData> => ({
    hasData: true,
    stats: {
      competitors: competitors.length,
      productsTracked: dashboardStats.productsMonitored,
      yourProducts: workspace.products,
      matchedProducts: dashboardStats.productsMatched,
      missingProducts: dashboardStats.onlyTheySell,
      outOfStock: dashboardStats.outOfStock,
      yourAvgPrice: dashboardStats.yourAvgPrice,
      marketAvgPrice: dashboardStats.marketAvgPrice,
      cheapestCompetitor: dashboardStats.cheapestCompetitor,
      mostExpensiveCompetitor: dashboardStats.mostExpensiveCompetitor,
    },
    competitors: competitors.map((c) => ({
      id: c.id,
      name: c.name,
      website: c.website,
      lastCrawl: c.lastCrawl,
      products: c.products,
      avgPriceIndex: c.avgPriceIndex,
    })),
    matchedProducts: matchedProducts.map((p) => ({
      id: p.id,
      name: p.name,
      competitor: p.competitor,
      competitorPrice: p.competitorPrice,
      yourPrice: p.yourPrice,
      gap: p.yourPrice === null ? null : p.competitorPrice - p.yourPrice,
    })),
    priceHistory,
    categoryGaps: categoryGaps.map((c) => ({
      category: c.category,
      yours: c.you,
      theirs: c.competitors,
    })),
    brandGaps,
  }),
);

export const getCompetitorsData = createServerFn({ method: "GET" }).handler(
  async (): Promise<Competitor[]> => competitors,
);

export const getMatchedProductsData = createServerFn({ method: "GET" }).handler(
  async (): Promise<MatchedProduct[]> => matchedProducts,
);

export interface PricingData {
  competitors: Competitor[];
  matchedProducts: MatchedProduct[];
  priceHistory: PricePoint[];
  stats: typeof dashboardStats;
}

export const getPricingData = createServerFn({ method: "GET" }).handler(
  async (): Promise<PricingData> => ({
    competitors,
    matchedProducts,
    priceHistory,
    stats: dashboardStats,
  }),
);

export interface CatalogueData {
  categoryGaps: CategoryGap[];
  brandGaps: BrandGap[];
  stats: typeof dashboardStats;
}

export const getCatalogueData = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogueData> => ({
    categoryGaps,
    brandGaps,
    stats: dashboardStats,
  }),
);

export const getInsightsData = createServerFn({ method: "GET" }).handler(
  async (): Promise<Insight[]> => insights,
);

export const getAlertsData = createServerFn({ method: "GET" }).handler(
  async (): Promise<AlertItem[]> => alerts,
);

export const getReportsData = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReportSummary[]> => reports,
);

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

export interface CrawlRunInput {
  origin: string;
  /** Collection handles to scope the crawl to (e.g. ["silicone-toys"]). */
  collections: string[];
}

export interface CrawlRunResult {
  stats: {
    discovered: number;
    fetched: number;
    skippedUnchanged: number;
    failed: number;
    durationMs: number;
  };
  failures: Array<{ url: string; error: string }>;
  products: Array<{
    name: string;
    brand: string;
    price: number;
    available: boolean;
    url: string;
  }>;
  /** Set when the crawl itself threw before producing a result. */
  error?: string;
}

/**
 * Runs the real crawler on the server for a store origin. The crawler is
 * imported dynamically so the rest of the API layer stays light.
 */
export const runCrawlNow = createServerFn({ method: "POST" })
  .validator((input: CrawlRunInput) => {
    // Guard against non-HTTP origins: the crawler fetches server-side, so an
    // arbitrary scheme here would be an SSRF-style risk if this ever leaves
    // the demo. Only http(s) origins are accepted.
    const origin = input.origin.trim();
    if (!/^https?:\/\/\S+/i.test(origin)) {
      throw new Error("Origin must be a valid http(s) URL");
    }
    return { ...input, origin };
  })
  .handler(async ({ data }): Promise<CrawlRunResult> => {
    try {
      const { runCrawl } = await import("@/lib/crawler/index.ts");
      const result = await runCrawl({
        origin: data.origin,
        collections: data.collections,
        maxRetries: 1,
        maxConcurrencyPerHost: 2,
      });
      return {
        stats: {
          discovered: result.stats.discovered,
          fetched: result.stats.fetched,
          skippedUnchanged: result.stats.skippedUnchanged,
          failed: result.stats.failed,
          durationMs: result.stats.durationMs,
        },
        failures: result.stats.failures,
        products: result.products.slice(0, 100).map((p) => ({
          name: p.name,
          brand: p.brand,
          price: p.price,
          available: p.available,
          url: p.url,
        })),
      };
    } catch (error) {
      return {
        stats: {
          discovered: 0,
          fetched: 0,
          skippedUnchanged: 0,
          failed: 0,
          durationMs: 0,
        },
        failures: [],
        products: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
