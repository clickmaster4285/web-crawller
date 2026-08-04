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
  /** Per-strategy discovery diagnostics captured during the run. */
  discovery?: {
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
    /** Human-readable findings/suggestions surfaced to the user. */
    findings?: Array<{
      level: "info" | "warning" | "success";
      message: string;
      action?: { label: string; url: string };
    }>;
    /** Verbose discovery log (what the crawler did, in order). */
    log?: string[];
  };
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

export interface CreateCompetitorInput {
  /** Display name; falls back to a readable name derived from the domain. */
  name: string;
  /** Full origin URL, e.g. https://store.example.com */
  origin: string;
  notes?: string;
}

/** Adds a competitor to the monitored list (persisted on the backend). */
export const createCompetitor = (input: CreateCompetitorInput) =>
  http.post<{ success: boolean; data: unknown }>("/data/competitors", input);

/** Removes a manually-added competitor (crawled origins are auto-derived). */
export const deleteCompetitor = (id: string) =>
  http.del<{
    success: boolean;
    data: { deleted: boolean; id: string; name: string };
  }>(`/data/competitors/${id}`);

/** The user's own store (single document) — used to compare against competitors. */
export interface MyStore {
  origin: string;
  name: string;
}

export const getMyStoreData = () =>
  http.get<{ success: boolean; data: MyStore | null }>("/data/my-store");

export const setMyStoreData = (input: { origin: string; name?: string }) =>
  http.put<{ success: boolean; data: MyStore }>("/data/my-store", input);

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

/** Response shape of the DELETE crawl-results endpoints. */
export interface DeleteCrawlResultResponse {
  success: boolean;
  data: {
    deleted: boolean;
    id?: string;
    origin: string;
    deletedCount?: number;
  };
}

/** Deletes a single saved crawl snapshot by its Mongo id. */
export const deleteCrawlResult = (id: string) =>
  http.del<DeleteCrawlResultResponse>(`/data/crawl-results/${id}`);

/** Deletes every saved snapshot for an origin (clears that store's history). */
export const deleteCrawlResultsByOrigin = (origin: string) =>
  http.del<DeleteCrawlResultResponse>(
    `/data/crawl-results?origin=${encodeURIComponent(origin)}`,
  );
