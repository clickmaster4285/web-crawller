/**
 * Data API layer — REST client for the Parity Express backend.
 *
 * Every getter hits `GET /api/data/*` through `src/lib/http.ts` (dev-proxied
 * to the backend at :3000). The returned shapes are identical to the previous
 * TanStack server functions, so hooks and pages are unchanged.
 */

import { http } from "@/lib/http";
import type {
  AlertItem,
  BrandGap,
  CategoryGap,
  Competitor,
  DashboardStats,
  Insight,
  MatchedProduct,
  PricePoint,
  ReportSummary,
  Workspace,
} from "@/types";

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

export interface PricingData {
  competitors: Competitor[];
  matchedProducts: MatchedProduct[];
  priceHistory: PricePoint[];
  stats: DashboardStats;
}

export interface CatalogueData {
  categoryGaps: CategoryGap[];
  brandGaps: BrandGap[];
  stats: DashboardStats;
}

/** A product inside a persisted crawl result (backend `CrawlResult`). */
export interface SavedCrawlProduct {
  name: string;
  brand: string;
  price: number;
  available: boolean;
  url: string;
}

export interface SavedCrawlFailure {
  url: string;
  error: string;
}

/** A persisted crawl snapshot, one per origin (latest run wins). */
export interface SavedCrawl {
  _id: string;
  origin: string;
  collections: string[];
  stats: {
    discovered: number;
    fetched: number;
    skippedUnchanged: number;
    failed: number;
    durationMs: number;
  };
  products: SavedCrawlProduct[];
  failures: SavedCrawlFailure[];
  createdAt: string;
  updatedAt: string;
}

/** Wrapper shape returned by `GET /api/data/crawl-results`. */
export interface CrawlResultsResponse {
  success: boolean;
  count: number;
  data: SavedCrawl[];
}

export const getWorkspaceData = () => http.get<Workspace>("/data/workspace");

export const getAnalyticsData = () =>
  http.get<AnalyticsData>("/data/analytics");

export const getCompetitorsData = () =>
  http.get<Competitor[]>("/data/competitors");

export const getMatchedProductsData = () =>
  http.get<MatchedProduct[]>("/data/matched-products");

export const getPricingData = () => http.get<PricingData>("/data/pricing");

export const getCatalogueData = () =>
  http.get<CatalogueData>("/data/catalogue");

export const getInsightsData = () => http.get<Insight[]>("/data/insights");

export const getAlertsData = () => http.get<AlertItem[]>("/data/alerts");

export const getReportsData = () => http.get<ReportSummary[]>("/data/reports");

export const getCrawlResultsData = () =>
  http.get<CrawlResultsResponse>("/data/crawl-results");
