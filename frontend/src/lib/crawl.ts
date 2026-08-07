/**
 * Crawler server functions — Phase 2: queue-backed.
 *
 * The crawler no longer runs inside the SSR process. It runs in standalone
 * worker processes (backend/workers/worker.mjs) that pull jobs from the
 * MongoDB `CrawlJob` queue (architecture §3.3, decision D4). These server
 * functions are thin clients of the Express queue API:
 *
 *   startCrawl({ origin, collections }) → { jobId }
 *     POST /api/crawl-jobs — enqueues a deep crawl; a worker claims it.
 *   getCrawlProgress(jobId)  → CrawlJob | null
 *     GET /api/crawl-jobs/:id — reads the same counters the old in-memory
 *     job exposed, so the Sources UI is unchanged.
 *
 * Recurring crawls are Store records (cadence + params) read by the
 * standalone scheduler process:
 *
 *   scheduleCrawl / getCrawlSchedules / cancelCrawlSchedule
 *     POST|GET /api/crawl-jobs/schedules(/:origin)
 *
 * The proxy gateway URL is sent to the backend with the enqueue request and
 * stored worker-side only; every API response exposes just the boolean, so
 * credentials never reach the client (same rule as the old in-memory path).
 */
import { createServerFn } from "@tanstack/react-start";

export interface CrawlRunInput {
  origin: string;
  /**
   * Job type: `deep` (full crawl — default) or `shallow` (sitemap-only
   * check that fetches just the NEW products, ≈1 request). Shallow runs
   * never soft-delete the catalogue (partial results).
   */
  type?: "shallow" | "deep";
  /** Collection handles to scope the crawl to (e.g. ["silicone-toys"]). */
  collections: string[];
  /** Base delay between requests (ms). Default 1000. */
  delayMs?: number;
  /** Max concurrent requests per host. Default 2 (polite). */
  maxConcurrencyPerHost?: number;
  /** Cap on product URLs fetched per run. Default unlimited. */
  maxPages?: number;
  /** Whether to fetch and enforce robots.txt (default true). */
  respectRobotsTxt?: boolean;
  /**
   * Product-only mode (default true): discovery skips blog/help/policy pages.
   */
  productOnly?: boolean;
  /**
   * Keep snapshot history on the backend (default true); false replaces the
   * latest result for the origin.
   */
  storeSnapshots?: boolean;
  /**
   * Tier 1 — Playwright browser rendering (default true = AUTO). The renderer
   * is available and the engine renders only content-poor JS-shell pages
   * (Nuxt/SPA shells, bot-block pages) — content-rich server-rendered stores
   * never touch the browser. Set false for strict http-only crawls.
   * Requires playwright + Chrome installed.
   */
  useBrowser?: boolean;
  /**
   * Tier 2 — rotating residential proxy gateway URL (default unset = direct
   * requests). Every request in the crawl exits through this proxy. The URL
   * is kept server-side only — never persisted to crawl results or logs, and
   * job responses only record the boolean for the UI badge.
   */
  proxy?: string;
  /**
   * Optional product-URL filter: a regex tested against every discovered URL;
   * only matching URLs are crawled. For stores whose sitemap mixes real
   * product URLs with blog/brand/category pages under the same path tree
   * (e.g. activefitnessstore.com — product URLs end in an EAN/SKU, blog posts
   * don't). Empty = crawl every discovered URL.
   */
  productUrlPattern?: string;
}

export interface CrawlRunResult {
  stats: {
    discovered: number;
    fetched: number;
    skippedUnchanged: number;
    failed: number;
    durationMs: number;
    /** Total HTTP requests made this run (debug; absent on old results). */
    requests?: number;
  };
  failures: Array<{ url: string; error: string }>;
  products: Array<{
    name: string;
    brand: string;
    price: number;
    /** Native currency when the extractor detected one (null = unknown). */
    currency?: string | null;
    available: boolean;
    url: string;
    /** Manufacturer SKU / product code from the parse (for matching). */
    sku: string;
    /** GTIN / UPC / EAN barcode from the parse (for matching). */
    gtin: string;
  }>;
  /** What each discovery strategy contributed, for the Discovery engine card. */
  discovery: {
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
      kind?: "store" | "corporate" | "unknown";
      cms?: string;
      builder?: string;
      seoPlugin?: string;
      server?: string;
      generator?: string;
    };
    /** robots.txt presence + declared crawl-delay (found/absent/unreachable/skipped). */
    robots: {
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
    findings: Array<{
      level: "info" | "warning" | "success";
      message: string;
      action?: { label: string; url: string };
    }>;
    /** Verbose discovery log (what the crawler did, in order). */
    log: string[];
  };
}

/**
 * Live discovery progress while a crawl's discovery phase is running,
 * surfaced through `getCrawlProgress` so the UI can render real numbers
 * (sitemap URLs found, pages visited) instead of a bare spinner.
 */
export interface CrawlJobDiscovery {
  phase: "collections" | "sitemap" | "htmlCrawl" | "done";
  urlsFound: number;
  sitemapUrls: number;
  htmlUrls: number;
  htmlPagesVisited: number;
  collectionHandles: number;
  /** Detected store platform (set once detection runs, usually at "done"). */
  platform?: string;
  /** Human-readable line describing what discovery is doing right now. */
  step?: string;
  /** Accumulated verbose log of discovery steps so far (oldest first). */
  log: string[];
}

/** Crawl parameters the job was started with (captured at start). */
export interface CrawlJobParams {
  delayMs: number;
  maxConcurrencyPerHost: number;
  maxPages: number | null;
  respectRobotsTxt: boolean;
  productOnly: boolean;
  storeSnapshots: boolean;
  useBrowser: boolean;
  /** True when the crawl was routed through a residential proxy. */
  proxy: boolean;
  /**
   * Product-URL filter regex (null = every discovered URL crawled). Shown on
   * the live progress panel so you can verify which filter a run used.
   */
  productUrlPattern: string | null;
}

export type CrawlFrequency = "1h" | "6h" | "daily" | "weekly";

export const FREQUENCY_MS: Record<CrawlFrequency, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * A recurring crawl registration (persisted on the backend `Store` record;
 * the standalone scheduler process turns it into jobs).
 */
export interface CrawlSchedule {
  origin: string;
  collections: string[];
  frequency: CrawlFrequency;
  params: CrawlJobParams;
  lastRunAt: number | null;
  nextRunAt: number;
  running: boolean;
  /**
   * The proxy gateway URL for scheduled runs. Server-side only — stripped
   * from every response so it never reaches the client.
   */
  proxyUrl?: string;
}

export interface ScheduleCrawlInput {
  origin: string;
  collections: string[];
  frequency: CrawlFrequency;
  delayMs?: number;
  maxConcurrencyPerHost?: number;
  maxPages?: number;
  respectRobotsTxt?: boolean;
  productOnly?: boolean;
  storeSnapshots?: boolean;
  useBrowser?: boolean;
  /** Tier 2 — residential proxy gateway URL (server-side only). */
  proxy?: string;
  /** Optional product-URL filter regex (see CrawlRunInput.productUrlPattern). */
  productUrlPattern?: string;
}

/** Live snapshot of a crawl job, returned by `getCrawlProgress`. */
export interface CrawlJob {
  /**
   * UI-facing status. `running` covers queued/claimed/retrying; `cancelled`
   * is a user-requested stop (no result persisted). See `state` for the raw
   * backend enum.
   */
  status: "running" | "done" | "error" | "cancelled";
  /** Raw backend state: queued/claimed/retrying/done/failed/dead/cancelled. */
  state: string;
  /** Backend job id (the active-jobs list pages off it). */
  id: string;
  /** Store origin this job crawls. */
  origin: string;
  /**
   * Worker that claimed/owns the job (debug — matches worker logs). Null
   * while the job is still queued.
   */
  workerId: string | null;
  /**
   * Last worker heartbeat (ms) — null while queued/terminal (never
   * heartbeated, or released after a crash).
   */
  heartbeatAt: number | null;
  /**
   * True when a claimed job's worker stopped heartbeating within the server
   * timeout (PARITY_HEARTBEAT_TIMEOUT_MS) — the worker may have crashed, so
   * the Active crawls UI warns amber instead of showing it as healthy.
   */
  heartbeatStale: boolean;
  /**
   * Live HTTP-request count for this run (debug — every attempt counts,
   * including robots.txt, discovery and retries).
   */
  requests: number;
  /**
   * Cooperative control request: "pause" holds the crawl (engine waits),
   * "cancel" requests cancellation, null = running freely. `paused` is
   * derived client-side as `control === "pause"` (the backend sends the raw
   * request, not a computed flag).
   */
  control: "pause" | "cancel" | null;
  /** shallow = sitemap-only check (new products only); deep = full crawl. */
  type: "shallow" | "deep";
  /** Crawl parameters captured at start (used by the UI's progress text). */
  params: CrawlJobParams;
  /** URLs discovered so far (0 while still in the discovery phase). */
  total: number;
  /** Products fetched/reused so far — progress through `total`. */
  processed: number;
  startedAt: number;
  /**
   * When the fetch phase began (first progress tick with a known URL count),
   * so the UI can exclude the discovery phase from the ETA and show the two
   * phases separately. Null while still discovering.
   */
  fetchStartedAt: number | null;
  /** Live discovery counts while the discovery phase runs (null after). */
  discovery: CrawlJobDiscovery | null;
  finishedAt: number | null;
  /** Present when status === "done". */
  result?: CrawlRunResult;
  /** Present when status === "error". */
  error?: string;
  /** True when a finished result was saved to the MongoDB backend. */
  persisted?: boolean;
}

/** Base backend URL for the Express API (dev-proxied same-origin otherwise). */
const backendUrl = () =>
  process.env.PARITY_BACKEND_URL ?? "http://localhost:3000";

/** Reads the backend's error message out of a failed response. */
async function backendError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { message?: string };
    return new Error(body.message ?? `Request failed (${res.status})`);
  } catch {
    return new Error(`Request failed (${res.status})`);
  }
}

/** Trims + validates a proxy gateway URL — http(s) only, never echoed back. */
function normalizeProxy(proxy: string | undefined): string | undefined {
  const trimmed = proxy?.trim() || undefined;
  if (trimmed && !/^https?:\/\/\S+/i.test(trimmed)) {
    throw new Error("Proxy must be a valid http(s) URL");
  }
  return trimmed;
}

/** Trims + caps the optional product-URL pattern (empty → undefined). */
function normalizeUrlPattern(pattern: string | undefined): string | undefined {
  const trimmed = pattern?.trim() || undefined;
  return trimmed?.slice(0, 200) || undefined;
}

/** Light client-side validation (the backend clamps + re-validates). */
function validateCrawlInput(input: CrawlRunInput): CrawlRunInput {
  const origin = input.origin.trim();
  if (!/^https?:\/\/\S+/i.test(origin)) {
    throw new Error("Origin must be a valid http(s) URL");
  }
  return {
    ...input,
    origin,
    type: input.type === "shallow" ? "shallow" : "deep",
    proxy: normalizeProxy(input.proxy),
    productUrlPattern: normalizeUrlPattern(input.productUrlPattern),
  };
}

/**
 * Starts a crawl: enqueues a deep CrawlJob on the backend queue and returns
 * its id immediately. A worker process picks it up; the client polls
 * `getCrawlProgress` for live progress, then the final result.
 */
export const startCrawl = createServerFn({ method: "POST" })
  .validator((input: CrawlRunInput) => validateCrawlInput(input))
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    const res = await fetch(`${backendUrl()}/api/crawl-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: { jobId: string };
    };
    return { jobId: body.data.jobId };
  });

/** Returns the current snapshot of a crawl job, or null for an unknown id. */
export const getCrawlProgress = createServerFn({ method: "POST" })
  .validator((jobId: string) => jobId)
  .handler(async ({ data: jobId }): Promise<CrawlJob | null> => {
    const res = await fetch(
      `${backendUrl()}/api/crawl-jobs/${encodeURIComponent(jobId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: CrawlJob | null;
    };
    return body.data ?? null;
  });

function validateScheduleInput(input: ScheduleCrawlInput): ScheduleCrawlInput {
  const origin = input.origin.trim();
  if (!/^https?:\/\/\S+/i.test(origin)) {
    throw new Error("Origin must be a valid http(s) URL");
  }
  if (!FREQUENCY_MS[input.frequency]) {
    throw new Error(`Unsupported frequency: ${String(input.frequency)}`);
  }
  return {
    ...input,
    origin,
    proxy: normalizeProxy(input.proxy),
    productUrlPattern: normalizeUrlPattern(input.productUrlPattern),
  };
}

/**
 * Registers (or replaces) a recurring crawl for an origin — persisted on the
 * backend `Store` record, ticked by the standalone scheduler process, so
 * schedules survive API restarts (unlike the old in-memory store).
 */
export const scheduleCrawl = createServerFn({ method: "POST" })
  .validator((input: ScheduleCrawlInput) => validateScheduleInput(input))
  .handler(async ({ data }): Promise<CrawlSchedule> => {
    const res = await fetch(`${backendUrl()}/api/crawl-jobs/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: CrawlSchedule;
    };
    return body.data;
  });

/** Lists the active recurring crawls (most recently updated first). */
export const getCrawlSchedules = createServerFn({ method: "POST" }).handler(
  async (): Promise<CrawlSchedule[]> => {
    const res = await fetch(`${backendUrl()}/api/crawl-jobs/schedules`);
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: CrawlSchedule[];
    };
    return body.data ?? [];
  },
);

/** Removes the recurring crawl for an origin. */
export const cancelCrawlSchedule = createServerFn({ method: "POST" })
  .validator((origin: string) => origin.trim())
  .handler(async ({ data: origin }): Promise<{ cancelled: boolean }> => {
    const res = await fetch(
      `${backendUrl()}/api/crawl-jobs/schedules/${encodeURIComponent(origin)}`,
      { method: "DELETE" },
    );
    if (!res.ok) throw await backendError(res);
    return { cancelled: true };
  });

/**
 * Lists the background crawlers: in-flight jobs (queued/claimed/retrying,
 * paused ones included) plus the last 15 minutes of finished ones. Results
 * are never shipped — the list stays light even for 10k-product stores.
 */
export const listActiveCrawlJobs = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ active: CrawlJob[]; recent: CrawlJob[] }> => {
    const res = await fetch(`${backendUrl()}/api/crawl-jobs/active`);
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: { active: CrawlJob[]; recent: CrawlJob[] };
    };
    return body.data ?? { active: [], recent: [] };
  },
);

/** Pauses a running (or queued) crawl — the engine holds until resumed. */
export const pauseCrawlJob = createServerFn({ method: "POST" })
  .validator((jobId: string) => jobId)
  .handler(async ({ data: jobId }): Promise<{ id: string }> => {
    const res = await fetch(
      `${backendUrl()}/api/crawl-jobs/${encodeURIComponent(jobId)}/pause`,
      { method: "POST" },
    );
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string };
    };
    return body.data;
  });

/** Resumes a paused crawl. */
export const resumeCrawlJob = createServerFn({ method: "POST" })
  .validator((jobId: string) => jobId)
  .handler(async ({ data: jobId }): Promise<{ id: string }> => {
    const res = await fetch(
      `${backendUrl()}/api/crawl-jobs/${encodeURIComponent(jobId)}/resume`,
      { method: "POST" },
    );
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string };
    };
    return body.data;
  });

/**
 * Cancels a crawl: queued jobs cancel immediately; running jobs stop cleanly
 * at the next checkpoint (no partial result is persisted).
 */
export const cancelCrawlJob = createServerFn({ method: "POST" })
  .validator((jobId: string) => jobId)
  .handler(async ({ data: jobId }): Promise<{ id: string }> => {
    const res = await fetch(
      `${backendUrl()}/api/crawl-jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    );
    if (!res.ok) throw await backendError(res);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string };
    };
    return body.data;
  });
