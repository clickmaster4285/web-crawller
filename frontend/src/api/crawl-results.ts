import { http } from "@/lib/http";

/** A product inside a persisted crawl result (backend `CrawlResult`). */
export interface SavedCrawlProduct {
  name: string;
  brand: string;
  price: number;
  available: boolean;
  url: string;
  /** Manufacturer SKU / product code (identity tier for matching). */
  sku?: string;
  /** GTIN / UPC / EAN barcode (identity tier for matching). */
  gtin?: string;
}

export interface SavedCrawlFailure {
  url: string;
  error: string;
}

/** A persisted crawl snapshot, one per origin (latest run wins). */
export interface SavedCrawl {
  _id: string;
  origin: string;
  /**
   * Job type: 'shallow' (sitemap-only check — fetched only new products) or
   * 'deep' (full crawl). Missing on pre-field snapshots (all were deep).
   */
  type?: "shallow" | "deep";
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
  };
  createdAt: string;
  updatedAt: string;
}

/** Wrapper shape returned by `GET /api/data/crawl-results`. */
export interface CrawlResultsResponse<T = SavedCrawl> {
  success: boolean;
  count: number;
  data: T[];
}

/**
 * Lightweight crawl summary (`GET /api/data/crawl-results?meta=1`) — the
 * full product catalogues are omitted, so store lists stay tiny even with
 * tens of thousands of products saved. The discovery diagnostics are kept
 * (minus the sitemap candidates' URL lists), so profile cards and quick-check
 * strips can render straight from summaries.
 */
export interface SavedCrawlMeta {
  _id: string;
  origin: string;
  /** Job type ('shallow' sitemap-only check vs 'deep' full crawl). */
  type: "shallow" | "deep";
  collections: string[];
  createdAt: string;
  updatedAt: string;
  stats: SavedCrawl["stats"];
  productCount: number;
  platform: string | null;
  /** Discovery diagnostics without the sitemap candidate URL lists. */
  discovery?: SavedCrawl["discovery"];
}

/** Query options for the saved-crawl list endpoint. */
export interface CrawlResultsParams {
  /** Only snapshots for this origin (exact match on the stored origin URL). */
  origin?: string;
  /** Return lightweight summaries instead of full crawl documents. */
  meta?: boolean;
  /**
   * Max snapshots to return (full mode default 50). Callers that only need
   * the previous snapshot for a diff pass a small limit so an origin's whole
   * history (up to 20 full catalogues) never crosses the wire.
   */
  limit?: number;
}

/**
 * Lists saved snapshots, newest first — all origins by default, or a single
 * origin when `params.origin` is set. Pass `params.meta` to get lightweight
 * summaries without the product catalogues.
 */
export const getCrawlResultsData = <T = SavedCrawl>(
  params: CrawlResultsParams = {},
) => {
  const qs = new URLSearchParams();
  if (params.origin) qs.set("origin", params.origin);
  if (params.meta) qs.set("meta", "1");
  if (params.limit != null) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return http.get<CrawlResultsResponse<T>>(
    `/data/crawl-results${query ? `?${query}` : ""}`,
  );
};

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
