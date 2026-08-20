import type { CrawlControl } from "./control.ts";
import type {
  StorefrontPrice,
  StorefrontUrlInfo,
} from "../adapters/storefront.ts";

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
   * Cooperative pause/resume/cancel handle (see `core/control.ts`). When set,
   * the engine checks it between units of work: `pause` finishes the
   * in-flight request then waits until cleared (resume); `cancel` throws
   * `CrawlCancelledError`, which unwinds the crawl cleanly (the worker marks
   * the job cancelled instead of persisting a result). Omit to run freely.
   */
  control?: CrawlControl;
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
  /**
   * Custom User-Agent. Defaults to a ParityBot UA. The `"browser"` sentinel
   * resolves to a Chrome UA (see core/http.ts resolveUserAgent) for WAF
   * stores that 403 the ParityBot UA; any other string is sent as-is.
   */
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
   * Render-miss circuit breaker (default 25): when a crawl runs with browser
   * rendering ON (auto JS rendering) and N CONSECUTIVE rendered pages extract
   * no product, the fetch loop stops early. A page that was genuinely
   * rendered and still yielded nothing is a strong "this store loads its
   * prices via a client-side API the crawler can't see" signal (observed Aug
   * 2026: activefitnessstore.com rendered 11k pages to extract 16 products).
   * The partial result is kept, `capped` is set so the ingest diff doesn't
   * read the skipped URLs as removals, and a finding explains the stop. Set
   * to 0/negative to disable.
   */
  renderMissBreaker?: number;
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
   * Tier 1 — Playwright browser rendering. Default (unset/true) is AUTO:
   * the renderer is always wired and `core/http.ts` renders only content-poor
   * JS-shell pages (Nuxt/SPA shells, bot-block pages) — content-rich
   * server-rendered pages are never re-rendered, so regular stores pay
   * nothing. Set to `false` to disable rendering entirely (http-only).
   * Requires playwright + Chrome (see `core/browser.ts`).
   */
  useBrowser?: boolean;
  /**
   * Optional per-crawl product-URL filter: a regex tested against every
   * discovered URL. When set, only matching URLs are kept — the escape hatch
   * for stores whose sitemap mixes real product URLs with blog/brand/
   * category pages under the SAME path tree (the flat-taxonomy heuristic
   * can't tell a blog post from a product there). Example —
   * activefitnessstore.com product URLs end in an EAN/SKU
   * (`…-bs-4067898979432`, `…-tf-1575`) while blog posts end in a word
   * (`…/10-ramadan-health-and-fitness-tips`): use `/\d{4,}$/`. An invalid
   * regex is ignored with a warning finding (crawl proceeds unfiltered).
   */
  productUrlPattern?: string;
  /**
   * Optional region/locale token (e.g. "om", "ae", "sa", "en", "ar").
   * Multi-country GCC stores publish a SEPARATE sitemap set per country
   * (activefitnessstore.com: `/om/sitemaps/en/sitemap.xml` … `/bh/…`,
   * `/qa/…`, `/kw/…`, `/sa/…`; lifetimefitnessstore.com:
   * `sitemap_ae.xml` … `sitemap_qa.xml`) — the same products in different
   * currencies. When set, discovery keeps only sitemap candidates (and
   * index children) whose URL carries the token as a path segment
   * (`/om/…`) or filename suffix (`sitemap_om.xml`), so a crawl fetches
   * ONE country's catalogue (~4× less work, one currency) instead of
   * walking every region and mixing AED/SAR/OMR prices. Empty = all
   * regions (the pre-locale behavior). Stores with a single sitemap are
   * unaffected (the default `/sitemap.xml` candidates are never filtered).
   */
  locale?: string;
  /**
   * Tier 2 — rotating residential proxy (opt-in per crawl). A single HTTP(S)
   * proxy gateway URL (e.g. Oxylabs
   * `http://user-USER:pass@pr.oxylabs.io:7777`, Bright Data
   * `http://brd-customer-…:pass@brd.superproxy.io:33335`, or Smartproxy
   * `http://user-…:pass@gate.smartproxy.com:7000`). Rotation is
   * provider-side — every request exits through a different residential IP,
   * fixing the IP-reputation 403 blocks on dawlance/techmen/teslalaptops.
   * When set, every HTTP request in the crawl (robots.txt, discovery,
   * product fetches) flows through the proxy via undici's `ProxyAgent`, and
   * JS-shell pages rendered by the Playwright fallback exit through the
   * proxy too (Playwright context proxy) — a WAF can't spare the browser
   * path. Retries, politeness and the robots gate are unchanged. The URL
   * lives only in server memory / the user's own browser storage — never
   * persisted to crawl results or logs, and redacted from error text.
   */
  proxy?: string;
  /** Called after each product is fetched. */
  onProgress?: (fetched: number, discovered: number) => void;
  /**
   * Structured run-log lines — lifecycle + warnings emitted by the engine
   * (crawl start, robots outcome, discovery done, fetch-phase start, HTTP
   * 429 rate-limit warnings, completion summary, discovery failure). The
   * worker appends them to the CrawlJob's capped `progress.log` so a crawl's
   * story survives the process (vs console output, which is lost on
   * restart). `level` ∈ "info" | "warn" | "error".
   */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /**
   * Called during the discovery phase with live per-strategy counts (sitemap
   * URLs found, HTML pages visited, product URLs accumulated) so a UI can
   * show discovery progress instead of a bare spinner.
   */
  onDiscoveryProgress?: (progress: DiscoveryProgress) => void;
  /**
   * Debug — called with the running HTTP-request count after every request
   * (robots.txt, discovery, product fetches; retried attempts each count).
   * The worker surfaces it on the crawl job for the Active crawls page.
   */
  onRequestCount?: (count: number) => void;
  /**
   * Mid-crawl checkpoint (Step 4, Aug 2026): a JSON-serializable snapshot of
   * the run's fetch-phase state emitted periodically while the crawl runs
   * (throttled to ~every CHECKPOINT_INTERVAL_MS). The worker persists it on
   * the job so a backend restart / worker crash re-claims the job and
   * RESUMES — discovery is skipped, already-processed URLs are not re-fetched
   * (the storefront fetchPage walk + price batches included) — instead of
   * re-running everything from zero. `resumeCheckpoint` is the same shape
   * fed back in on a resumed run. Omit both to run as before.
   */
  onCheckpoint?: (checkpoint: CrawlCheckpoint) => void;
  /**
   * A checkpoint captured by an earlier (possibly dead) run of this job — see
   * `onCheckpoint`. When present (and `v` matches), the engine skips
   * discovery entirely, seeds the products/failures/counters captured so far,
   * and skips the URLs in `done` instead of re-fetching them.
   */
  resumeCheckpoint?: CrawlCheckpoint | null;
}

/**
 * Mid-crawl resume snapshot (Step 4, Aug 2026) — everything the fetch phase
 * needs to continue where a dead run stopped. JSON-safe (no Maps/Sets — maps
 * are entry arrays); stored on the CrawlCheckpoint collection keyed by jobId
 * so a re-claimed job resumes without re-running discovery or re-fetching
 * finished URLs. Versioned so an old engine never misreads a new shape.
 */
export interface CrawlCheckpoint {
  /** Shape version — engines reject checkpoints they don't understand. */
  v: 1;
  /** The fetch-phase URL list (post maxPages cap + stratified sampling). */
  urls: string[];
  /** Sitemap lastmod per URL (discovery's `lastmod` map), for the resume fast-path. */
  lastmod: Array<[string, string]>;
  /** BigCommerce discovery URL→id map (only when that API is public). */
  productIds: Array<[string, number]>;
  /** URLs already fully processed this run (product, cached-skip, or failure). */
  done: string[];
  /** Products extracted so far, in run order. */
  products: CrawledProduct[];
  /** Failures so far. */
  failures: CrawlFailure[];
  /** Freshly-fetched count so far. */
  fetchedCount: number;
  /** Cache-reused count so far. */
  skippedUnchanged: number;
  /** Full discovery URL count (pre-cap) — `stats.discovered` must report it. */
  discoveredCount: number;
  /** Discovery diagnostics — reused verbatim so the resumed result is complete. */
  discovery: DiscoveryDiagnostics;
  /** httpState captured so far (url → etag/lastmod). */
  httpState: Array<[string, { etag: string | null; lastmod: number | null }]>;
  /** Storefront index (url → product id + catalogue URL), when the Tier-4 API is active. */
  storefrontByUrl?: Array<[string, StorefrontUrlInfo]>;
  /** Storefront prices (product id → price), when the Tier-4 API is active. */
  storefrontPrices?: Array<[number, StorefrontPrice]>;
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
  /** ISO 4217 currency of `price` (e.g. "AED"), when the extractor found
   * one (JSON-LD offer currency, OG price:currency, or a symbol guess).
   * Absent for adapters that never see a currency token. */
  priceCurrency?: string;
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
  /**
   * What failed (P4): 'extraction' = the page loaded but no product was
   * parsed from it; 'http' = the fetch itself failed (timeout, rate-limit,
   * WAF block, network). Lets a 0-priced run read honestly — "all
   * extraction misses" vs "blocked by the store". Absent on legacy runs.
   */
  kind?: 'extraction' | 'http';
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
 * Shopify products.json outcome (Tier 3 adapter).
 *
 * Shopify serves the full catalogue at `/products.json` on every storefront;
 * walking it rescues stores whose sitemap is blocked or missing (athletix.ae:
 * `/sitemap.xml` 429'd while `/products.json` paged cleanly). The fetch loop's
 * existing per-product `/products/{handle}.json` probe then parses each URL.
 */
export interface ShopifyDiagnostics {
  /**
   * "public" — the catalogue is enumerable (walked for URLs);
   * "auth-required" — 401/403; "unavailable" — no usable API (404 /
   * non-JSON / robots-disallowed).
   */
  status: "public" | "auth-required" | "unavailable";
  /** Product URLs the API walk contributed to discovery (deduped). */
  urls: number;
  /** Human-readable detail (probe failure). */
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

/**
 * Headless storefront native API outcome (Tier 4 adapter).
 *
 * A class of JS-shell storefronts (activefitnessstore.com and friends)
 * render no server-side prices AND load them via a late XHR, so even
 * Playwright renders extract nothing — but the store's own JSON API
 * (`/api/fetchPage` → catalogue JSON → batched `POST /api/get-price`)
 * returns everything over plain HTTP. When this probe is public, the fetch
 * loop uses the native API instead of the HTML/render chain: ~2 requests
 * per product + 1 per ~100 for prices, no browser, ~100% extraction.
 */
export interface StorefrontApiDiagnostics {
  /**
   * "public" — fetchPage pattern detected (recipe usable by the fetch
   * loop); "unavailable" — no storefront API (probe failed / not a
   * JS-shell storefront).
   */
  status: "public" | "unavailable";
  /** Product URLs this adapter contributed to discovery (always 0 — the
   * storefront API adds prices/data, not URLs; the sitemap has the URLs). */
  urls: number;
  /** Human-readable detail (probe failure or what was found). */
  message?: string;
  /** The detected recipe (endpoints + tokens) the fetch loop uses. */
  recipe?: {
    origin: string;
    country: string | null;
    lang: string;
    fetchPagePath: string;
    priceApiUrl: string | null;
    catalogueBaseUrl: string | null;
  };
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
  /** Shopify products.json outcome (Tier 3 adapter), when probed. */
  shopifyApi?: ShopifyDiagnostics;
  /** Headless storefront native API outcome (Tier 4 adapter), when probed. */
  storefrontApi?: StorefrontApiDiagnostics;
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
  /** Total HTTP requests made this run (every attempt counts). */
  requests: number;
  /**
   * True when the run was capped by `maxPages` (discovery found MORE URLs
   * than the cap, so only the first `maxPages` were fetched). A capped run
   * is NOT a full catalogue — the ingest pipeline must not treat the URLs
   * beyond the cap as removals, and the run must never become the removal-
   * anchor snapshot.
   */
  capped?: boolean;
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
