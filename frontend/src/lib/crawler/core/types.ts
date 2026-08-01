/**
 * Crawler domain types.
 *
 * `CrawledProduct` is the vendor-neutral output of the crawler pipeline
 * (discover → fetch → parse). It is intentionally independent of the app's
 * UI types (`MatchedProduct` etc.) — the API layer maps between them.
 */

export interface CrawlConfig {
  /** Base origin, e.g. "https://obdesignsusa.com" */
  origin: string;
  /** Collection handles to crawl, e.g. ["silicone-toys"] */
  collections: string[];
  /** Polite delay between requests (ms). Default 1000. */
  delayMs?: number;
  /** Retries on 429/5xx/network errors. Default 3. */
  maxRetries?: number;
  /** Custom User-Agent. Defaults to a ParityBot UA. */
  userAgent?: string;
  /**
   * SQLite checkpoint DB path. When set, the engine stores per-URL status
   * + etag/lastmod + product JSON so a re-run can resume and skip
   * unchanged products (see `core/checkpoint.ts`). Omit to run stateless.
   */
  checkpointPath?: string;
  /**
   * Max concurrent requests per host (step 5). Default 2. Bounded by
   * `core/queue.ts`; the adaptive throttle still gates request timing.
   */
  maxConcurrencyPerHost?: number;
  /** Called after each product is fetched. */
  onProgress?: (fetched: number, discovered: number) => void;
}

export interface CrawledVariant {
  id: number;
  title: string;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  available: boolean;
  inventoryQuantity: number;
  barcode: string;
}

export interface CrawledProduct {
  id: number;
  handle: string;
  url: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  tags: string[];
  image: string | null;
  /** Lowest variant price; 0 when no priced variants exist. */
  price: number;
  compareAtPrice: number | null;
  available: boolean;
  variants: CrawledVariant[];
  createdAt: string;
  updatedAt: string;
  crawledAt: string;
}

export interface CrawlFailure {
  url: string;
  error: string;
}

export interface CrawlStats {
  discovered: number;
  fetched: number;
  /** Products reused from the checkpoint cache instead of re-fetched. */
  skippedUnchanged: number;
  failed: number;
  failures: CrawlFailure[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface CrawlResult {
  config: Pick<CrawlConfig, "origin" | "collections">;
  stats: CrawlStats;
  products: CrawledProduct[];
}
