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
  /**
   * Crawl mode (architecture §3.2):
   *   - "deep" (default) — full discovery (platform detection, homepage
   *     analysis, collections, API probes, sitemap + HTML crawl) and the
   *     complete fetch loop (API-first adapters, Shopify JSON, HTML chain).
   *   - "shallow" — sitemap-only check: fetch the sitemap, keep only product
   *     URLs NOT in `knownUrls`, and fetch just those new pages via the HTML
   *     extractor (no platform detection, no homepage analysis, no HTML BFS,
   *     no API probes, no API-first fetching). Cost ≈ 1 request + new
   *     product pages, which is what a frequent shallow cadence needs.
   */
  mode?: "shallow" | "deep";
  /**
   * URLs the system already knows for this origin (from the Product
   * collection). In shallow mode, discovery keeps only URLs NOT in this set
   * — a shallow check therefore never re-fetches known products, so the
   * "new products only" promise holds even for stores without a public
   * platform API. Ignored in deep mode.
   */
  knownUrls?: Set<string>;
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
   * Phase B (architecture §3.1): `resumeState` is the cross-worker
   * replacement — when both are set, `resumeState` wins (SQLite is then the
   * per-run scratch only).
   */
  checkpointPath?: string;
  /**
   * Phase B cross-worker resume state (architecture §3.1): a URL → cached
   * product + etag/lastmod map loaded from `Product.httpState` (plus the
   * stored product fields) for this origin. ANY worker can resume a store
   * because the skip-unchanged state lives in Mongo, not on one machine's
   * disk. The engine skips URLs whose sitemap lastmod matches the stored
   * value and reuses the cached product as-is (so the ingest diff still
   * sees the full catalogue); freshly fetched etag/lastmod is returned via
   * `CrawlResult.httpStateByUrl` for the pipeline to persist. The etag is
   * captured + persisted for future conditional-request revalidation but is
   * NOT yet a skip signal itself (the skip key is the sitemap lastmod — a
   * store whose sitemap carries no lastmod refetches every run, matching
   * the pre-Phase-B checkpoint behavior for lastmod-less sitemaps). Omit
   * to run stateless (or with `checkpointPath`).
   */
  resumeState?: Map<
    string,
    {
      etag: string | null;
      lastmod: number | null;
      product: CrawledProduct;
    }
  >;
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
  /**
   * Tier 2 — rotating residential proxy (opt-in per crawl). A single HTTP(S)
   * proxy gateway URL (e.g. Oxylabs
   * `http://user-USER:pass@pr.oxylabs.io:7777`, Bright Data
   * `http://brd-customer-…:pass@brd.superproxy.io:33335`, or Smartproxy
   * `http://user-…:pass@gate.smartproxy.com:7000`). Rotation is
   * provider-side — every request exits through a different residential IP,
   * fixing the IP-reputation 403 blocks on dawlance/techmen/teslalaptops.
   * When set, every HTTP request in the crawl (robots.txt, discovery,
   * product fetches) flows through the proxy via undici's `ProxyAgent`;
   * retries, politeness and the robots gate are unchanged. (Pages rendered
   * by the Playwright browser fallback use Chromium's own network stack and
   * are not proxied.) The URL lives only in server memory / the user's own
   * browser storage — never persisted to crawl results or logs, and never
   * echoed in Parity's own error text.
   */
  proxy?: string;
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

/**
 * WooCommerce native REST API outcome (Tier 3 adapter).
 *
 * WooCommerce exposes `/wp-json/wc/v3/products` but most stores protect it
 * behind consumer-key credentials, so a crawl must report which case it hit
 * rather than silently falling back.
 */
export interface WooCommerceDiagnostics {
  /**
   * "public" — the API served products (walked for URLs + parsed per
   * product); "auth-required" — 401/403 (needs consumer credentials);
   * "unavailable" — no usable API (404 / non-JSON / robots-disallowed).
   */
  status: "public" | "auth-required" | "unavailable";
  /** Total products the API reported (`X-WP-Total`), when known. */
  total: number | null;
  /** Product URLs this API walk contributed to discovery (deduped). */
  urls: number;
  /** Human-readable detail (auth hint or probe failure). */
  message?: string;
}

/**
 * BigCommerce Storefront API outcome (Tier 3 adapter).
 *
 * BigCommerce exposes `/api/storefront/catalog/products` (public, no
 * credentials in most themes), but stores can disable it or gate it, so a
 * crawl must report which case it hit rather than silently falling back.
 */
export interface BigCommerceDiagnostics {
  /**
   * "public" — the API served products (walked for URLs + parsed per
   * product); "auth-required" — 401/403 (needs credentials);
   * "unavailable" — no usable API (404 / non-JSON / robots-disallowed).
   */
  status: "public" | "auth-required" | "unavailable";
  /** Total products the API reported (`pagination.total`), when known. */
  total: number | null;
  /** Product URLs this API walk contributed to discovery (deduped). */
  urls: number;
  /** Human-readable detail (auth hint or probe failure). */
  message?: string;
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
  /** WooCommerce native REST API outcome (Tier 3 adapter), when probed. */
  wooCommerce?: WooCommerceDiagnostics;
  /** BigCommerce Storefront API outcome (Tier 3 adapter), when probed. */
  bigCommerce?: BigCommerceDiagnostics;
  /** Human-readable findings/suggestions surfaced to the user. */
  findings: CrawlFinding[];
  /** Verbose discovery log (what the crawler did, in order). */
  log: string[];
}

export interface CrawlStats {
  discovered: number;
  fetched: number;
  /** Products reused from the checkpoint/resume cache instead of re-fetched. */
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
  /**
   * Per-strategy discovery diagnostics (sitemap / html-crawl / collections).
   */
  discovery: DiscoveryDiagnostics;
  /**
   * Phase B — the etag/lastmod captured for every URL this run touched
   * (fetched AND reused). The worker hands it to the ingest pipeline so
   * `Product.httpState` is updated in Mongo — the next worker (any machine)
   * resumes from that state instead of re-fetching unchanged products.
   */
  httpStateByUrl?: Map<string, { etag: string | null; lastmod: number | null }>;
}
