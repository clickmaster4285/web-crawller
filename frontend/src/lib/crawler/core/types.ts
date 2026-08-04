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
  /**
   * Hard cap on the number of product URLs fetched per run (default:
   * unlimited). Discovery still reports the full count in `stats.discovered`;
   * only the fetch loop is limited to the first `maxPages` URLs.
   */
  maxPages?: number;
  /**
   * Whether to fetch and enforce robots.txt for the origin (default true).
   * The adaptive throttle still runs either way — only the robots gate and
   * crawl-delay are skipped when false.
   */
  respectRobotsTxt?: boolean;
  /**
   * Product-only mode (default true): sitemap entries are filtered to
   * product-page patterns (blog/help/policy pages skipped). When false, every
   * sitemap URL is crawled (non-product pages usually fail extraction).
   */
  productOnly?: boolean;
  /**
   * Tier 1 — Playwright browser rendering (default false). When true, pages
   * whose server HTML looks like a client-side JS shell are rendered in a
   * headless browser before discovery + extraction see them, unlocking
   * JS-rendered stores (Nuxt/Next/SPA). Opt-in per crawl: it is slower and
   * requires playwright + Chrome (see `core/browser.ts`).
   */
  useBrowser?: boolean;
  /** Called after each product is fetched. */
  onProgress?: (fetched: number, discovered: number) => void;
  /**
   * Called during the discovery phase with live per-strategy counts (sitemap
   * URLs found, HTML pages visited, product URLs accumulated) so a UI can
   * show discovery progress instead of a bare spinner.
   */
  onDiscoveryProgress?: (progress: DiscoveryProgress) => void;
}

/** Live snapshot of the discovery phase, emitted via `onDiscoveryProgress`. */
export interface DiscoveryProgress {
  /** Which strategy is currently running (or just finished). */
  phase: "collections" | "sitemap" | "htmlCrawl" | "done";
  /** Total product URLs accumulated across all strategies so far. */
  urlsFound: number;
  /** Product URLs contributed by the sitemap walk so far. */
  sitemapUrls: number;
  /** Product URLs contributed by the HTML crawl so far. */
  htmlUrls: number;
  /** HTML pages visited so far (BFS). */
  htmlPagesVisited: number;
  /** Product handles contributed by collection walks so far. */
  collectionHandles: number;
  /** Detected store platform (set once detection runs, usually at "done"). */
  platform?: string;
  /** Human-readable line describing what discovery is doing right now. */
  step?: string;
  /** Accumulated verbose log of discovery steps so far (oldest first). */
  log: string[];
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

/** robots.txt fetch outcome for the origin. */
export type RobotsStatus = "found" | "absent" | "unreachable" | "skipped";

/**
 * robots.txt presence + declared crawl-delay, captured by the politeness
 * layer so the UI can show a real robots row (instead of omitting it).
 */
export interface RobotsInfo {
  status: RobotsStatus;
  /** Declared Crawl-delay in ms (`null` = none declared). */
  crawlDelayMs: number | null;
}

/** robots.txt snapshot as fetched by politeness (body reused by detection). */
export interface RobotsSnapshot extends RobotsInfo {
  /** Raw robots.txt body ("" when absent/unreachable). */
  body: string;
}

/** A link on the homepage pointing at a different host that looks store-like. */
export interface ExternalStoreLink {
  url: string;
  host: string;
  /** Anchor text (trimmed) when present — helps the UI explain the link. */
  label: string;
}

/** What the homepage analysis learned about the site (store vs corporate). */
export interface HomepageDiagnostics {
  /** Number of product-page-ish links on the homepage. */
  productLinks: number;
  /** Number of category/catalogue-ish links on the homepage. */
  categoryLinks: number;
  /** True when the homepage meaningfully links to product pages. */
  looksLikeStore: boolean;
  /** Out-links to other hosts that look like stores (max 5, deduped). */
  externalStoreLinks: ExternalStoreLink[];
  /** Human-readable summary of what the homepage looks like. */
  note: string;
}

/** A human-readable finding/suggestion surfaced to the user after a crawl. */
export interface CrawlFinding {
  level: "info" | "warning" | "success";
  message: string;
  /** Optional action — e.g. "Crawl shop.example.com instead". */
  action?: { label: string; url: string };
}

/**
 * What each discovery strategy contributed (and whether it failed). Mirrors
 * `ProductDiscovery.diagnostics` so a run's discovery phase can be surfaced
 * in the UI / persisted with the crawl.
 */
export interface DiscoveryDiagnostics {
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
  platform: {
    platform: string;
    signal: string;
    /** "store" — sells products; "corporate" — marketing site; "unknown". */
    kind?: "store" | "corporate" | "unknown";
    /** CMS the site is built on, when identifiable (e.g. "WordPress"). */
    cms?: string;
    /** Page-builder/theme marker (e.g. "Elementor"). */
    builder?: string;
    /** SEO plugin marker (e.g. "Rank Math SEO"). */
    seoPlugin?: string;
    /** Server stack from response headers (e.g. "Apache · PHP 8.2.33"). */
    server?: string;
    /** Raw generator meta tags joined. */
    generator?: string;
  };
  /** robots.txt presence + declared crawl-delay (found/absent/unreachable/skipped). */
  robots: RobotsInfo;
  /** Homepage analysis (product links, corporate-vs-store, external stores). */
  homepage?: HomepageDiagnostics;
  /** Human-readable findings/suggestions surfaced to the user. */
  findings: CrawlFinding[];
  /** Verbose discovery log (what the crawler did, in order). */
  log: string[];
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
  /** Per-strategy discovery diagnostics (sitemap / html-crawl / collections). */
  discovery: DiscoveryDiagnostics;
}
