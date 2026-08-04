/**
 * Crawler server functions — job-based, with live progress.
 *
 * The real crawler is a Node-only TypeScript module with native deps
 * (better-sqlite3), so it runs on the TanStack Start server (Nitro SSR) —
 * it is not proxied to Express. See the crawler section of AGENTS.md.
 *
 * TanStack Start server functions are one-shot RPC (no SSE support), so
 * progress is delivered with a job/poll pattern:
 *
 *   startCrawl({ origin, collections }) → { jobId }   (kicks the crawl off in
 *     the background and returns immediately)
 *   getCrawlProgress(jobId)             → CrawlJob | null   (poll this)
 *
 * The job store is a module-scope Map inside the running server process —
 * fine for the single-process demo. The background crawl keeps Node's event
 * loop alive until it finishes, so a returned jobId always has a live job
 * behind it unless the server restarts mid-crawl (the client shows a hint
 * in that case).
 *
 * Two persistence layers:
 *   - **SQLite checkpoint** (`.crawler/crawl-<host>.db`, gitignored): each
 *     product is written as it is crawled, so a crash mid-run loses nothing
 *     already saved and a re-run skips unchanged products (etag/lastmod)
 *     instead of refetching them.
 *   - **MongoDB backend** (`POST /api/data/crawl-results` on the Express
 *     API): when a crawl finishes, the sanitized result is saved so the
 *     dashboard can read it without re-crawling. With `storeSnapshots` the
 *     backend keeps per-origin history (capped); otherwise it replaces.
 *
 * Recurring crawls: `scheduleCrawl` registers a frequency (1h/6h/daily/
 * weekly) in an in-memory store and a lazy 30s interval (started only from a
 * handler) kicks off due crawls. Schedules reset when the server restarts.
 */
import { createServerFn } from "@tanstack/react-start";

export interface CrawlRunInput {
  origin: string;
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
   * Tier 1 — Playwright browser rendering (default false). Renders JS-shell
   * pages in a headless browser before discovery/extraction, unlocking
   * JS-rendered stores. Slower; requires playwright + Chrome installed.
   */
  useBrowser?: boolean;
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
}

export type CrawlFrequency = "1h" | "6h" | "daily" | "weekly";

export const FREQUENCY_MS: Record<CrawlFrequency, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** A recurring crawl registration (in-memory; resets on server restart). */
export interface CrawlSchedule {
  origin: string;
  collections: string[];
  frequency: CrawlFrequency;
  params: CrawlJobParams;
  lastRunAt: number | null;
  nextRunAt: number;
  running: boolean;
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
}

/** Live snapshot of a crawl job, returned by `getCrawlProgress`. */
export interface CrawlJob {
  status: "running" | "done" | "error";
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

// Single-process job store. Lives on the server; along with the handler code
// it is stripped from the client bundle by the Start plugin.
const jobs = new Map<string, CrawlJob>();
let nextJobId = 0;

// Single-process schedule store (in-memory; resets on server restart) and
// the lazy scheduler interval. The interval is only ever started from a
// server-function handler, so the client bundle never executes it.
const schedules = new Map<string, CrawlSchedule>();
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

function createJobId(): string {
  nextJobId += 1;
  return `crawl-${Date.now().toString(36)}-${nextJobId}`;
}

/** Removes terminal jobs older than 10 minutes so the store stays bounded. */
function pruneFinishedJobs(): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && (job.finishedAt ?? 0) < cutoff) {
      jobs.delete(id);
    }
  }
}

function validateCrawlInput(input: CrawlRunInput): CrawlRunInput {
  // SSRF guard: the crawler fetches server-side, so only http(s) origins
  // are accepted.
  const origin = input.origin.trim();
  if (!/^https?:\/\/\S+/i.test(origin)) {
    throw new Error("Origin must be a valid http(s) URL");
  }
  // Clamp crawl parameters to sane ranges.
  const delayMs =
    input.delayMs == null
      ? undefined
      : Math.min(10_000, Math.max(100, Math.round(input.delayMs)));
  const maxConcurrencyPerHost =
    input.maxConcurrencyPerHost == null
      ? undefined
      : Math.min(12, Math.max(1, Math.round(input.maxConcurrencyPerHost)));
  const maxPages =
    input.maxPages == null
      ? undefined
      : Math.max(1, Math.round(input.maxPages));
  return {
    ...input,
    origin,
    delayMs,
    maxConcurrencyPerHost,
    maxPages,
    respectRobotsTxt: input.respectRobotsTxt !== false,
    productOnly: input.productOnly !== false,
    storeSnapshots: input.storeSnapshots !== false,
    useBrowser: input.useBrowser === true,
  };
}

/**
 * Starts a crawl in the background and returns its job id immediately. The
 * client polls `getCrawlProgress` for live progress, then the final result.
 */
export const startCrawl = createServerFn({ method: "POST" })
  .validator((input: CrawlRunInput) => validateCrawlInput(input))
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    pruneFinishedJobs();
    const jobId = createJobId();
    jobs.set(jobId, {
      status: "running",
      total: 0,
      processed: 0,
      startedAt: Date.now(),
      fetchStartedAt: null,
      discovery: null,
      finishedAt: null,
      params: {
        delayMs: data.delayMs ?? 1000,
        maxConcurrencyPerHost: data.maxConcurrencyPerHost ?? 2,
        maxPages: data.maxPages ?? null,
        respectRobotsTxt: data.respectRobotsTxt !== false,
        productOnly: data.productOnly !== false,
        storeSnapshots: data.storeSnapshots !== false,
        useBrowser: data.useBrowser === true,
      },
    });
    // Fire and forget — the client polls progress. The event loop stays
    // alive while the crawl's fetches are in flight.
    void runJob(jobId, data);
    return { jobId };
  });

/** Returns the current snapshot of a crawl job, or null for an unknown id. */
export const getCrawlProgress = createServerFn({ method: "POST" })
  .validator((jobId: string) => jobId)
  .handler(({ data: jobId }): CrawlJob | null => jobs.get(jobId) ?? null);

const FREQUENCIES: CrawlFrequency[] = ["1h", "6h", "daily", "weekly"];

function validateScheduleInput(input: ScheduleCrawlInput): ScheduleCrawlInput {
  const origin = input.origin.trim();
  if (!/^https?:\/\/\S+/i.test(origin)) {
    throw new Error("Origin must be a valid http(s) URL");
  }
  if (!FREQUENCIES.includes(input.frequency)) {
    throw new Error(`Unsupported frequency: ${String(input.frequency)}`);
  }
  const delayMs =
    input.delayMs == null
      ? undefined
      : Math.min(10_000, Math.max(100, Math.round(input.delayMs)));
  const maxConcurrencyPerHost =
    input.maxConcurrencyPerHost == null
      ? undefined
      : Math.min(12, Math.max(1, Math.round(input.maxConcurrencyPerHost)));
  const maxPages =
    input.maxPages == null
      ? undefined
      : Math.max(1, Math.round(input.maxPages));
  return {
    origin,
    collections: input.collections,
    frequency: input.frequency,
    delayMs,
    maxConcurrencyPerHost,
    maxPages,
    respectRobotsTxt: input.respectRobotsTxt !== false,
    productOnly: input.productOnly !== false,
    storeSnapshots: input.storeSnapshots !== false,
    useBrowser: input.useBrowser === true,
  };
}

/**
 * Registers (or replaces) a recurring crawl for an origin. Schedules live in
 * memory on the server and reset on restart; the 30s tick starts due crawls
 * as background jobs visible through the normal progress flow.
 */
export const scheduleCrawl = createServerFn({ method: "POST" })
  .validator((input: ScheduleCrawlInput) => validateScheduleInput(input))
  .handler(({ data }): CrawlSchedule => {
    ensureSchedulerStarted();
    const now = Date.now();
    const sched: CrawlSchedule = {
      origin: data.origin,
      collections: data.collections,
      frequency: data.frequency,
      params: {
        delayMs: data.delayMs ?? 1000,
        maxConcurrencyPerHost: data.maxConcurrencyPerHost ?? 2,
        maxPages: data.maxPages ?? null,
        respectRobotsTxt: data.respectRobotsTxt !== false,
        productOnly: data.productOnly !== false,
        storeSnapshots: data.storeSnapshots !== false,
        useBrowser: data.useBrowser === true,
      },
      lastRunAt: null,
      nextRunAt: now + FREQUENCY_MS[data.frequency],
      running: false,
    };
    schedules.set(data.origin, sched);
    return sched;
  });

/** Lists the active recurring crawls (newest registration first). */
export const getCrawlSchedules = createServerFn({ method: "POST" }).handler(
  (): CrawlSchedule[] => [...schedules.values()].reverse(),
);

/** Removes the recurring crawl for an origin. */
export const cancelCrawlSchedule = createServerFn({ method: "POST" })
  .validator((origin: string) => origin.trim())
  .handler(({ data: origin }): { cancelled: boolean } => {
    schedules.delete(origin);
    return { cancelled: true };
  });

/** Starts the scheduler interval on first use (handler-only, never client). */
function ensureSchedulerStarted(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    const now = Date.now();
    for (const [origin, sched] of [...schedules.entries()]) {
      if (sched.running || sched.nextRunAt > now) continue;
      sched.running = true;
      sched.lastRunAt = now;
      sched.nextRunAt = now + FREQUENCY_MS[sched.frequency];
      void runScheduledCrawl(origin, sched);
    }
  }, 30_000);
}

/** Runs a due scheduled crawl as a normal background job. */
async function runScheduledCrawl(
  origin: string,
  sched: CrawlSchedule,
): Promise<void> {
  const jobId = createJobId();
  jobs.set(jobId, {
    status: "running",
    total: 0,
    processed: 0,
    startedAt: Date.now(),
    fetchStartedAt: null,
    discovery: null,
    finishedAt: null,
    params: sched.params,
  });
  try {
    await runJob(jobId, {
      origin: sched.origin,
      collections: sched.collections,
      delayMs: sched.params.delayMs,
      maxConcurrencyPerHost: sched.params.maxConcurrencyPerHost,
      maxPages: sched.params.maxPages ?? undefined,
      respectRobotsTxt: sched.params.respectRobotsTxt,
      productOnly: sched.params.productOnly,
      storeSnapshots: sched.params.storeSnapshots,
      useBrowser: sched.params.useBrowser,
    });
  } finally {
    // Clear the running flag in a finally so an unexpected throw (e.g. a
    // transport failure) can never wedge the schedule. Only clear it if the
    // stored schedule is still this one — a cancelled-then-re-added schedule
    // for the same origin mid-run must not have its flag cleared by the
    // stale run.
    if (schedules.get(origin) === sched) sched.running = false;
  }
}

/**
 * Runs the real crawler for a job, updating the shared job record.
 *
 * Honors the crawl parameters from the Sources page (delay, concurrency,
 * max pages), defaulting to the polite values: max 2 concurrent requests
 * per host, robots.txt respected, adaptive throttle. A per-origin SQLite
 * checkpoint persists every product as it is crawled (crash-safe) and skips
 * unchanged products on re-runs. On completion the sanitized result is
 * upserted to the Express/MongoDB backend before the job flips to "done".
 */
async function runJob(jobId: string, input: CrawlRunInput): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    const { runCrawl } = await import("@/lib/crawler/index.ts");
    // Node-only imports stay inside the handler so the client bundle never
    // sees them (same pattern as the crawler dynamic import).
    const { join } = await import("node:path");
    const host = new URL(input.origin).host.replace(/[^a-z0-9.-]/gi, "_");
    // Default to <cwd>/.crawler (gitignored); override with
    // PARITY_CHECKPOINT_DIR when the server isn't started from `frontend/`.
    const checkpointDir =
      process.env.PARITY_CHECKPOINT_DIR ?? join(process.cwd(), ".crawler");
    const checkpointPath = join(checkpointDir, `crawl-${host}.db`);
    const result = await runCrawl({
      origin: input.origin,
      collections: input.collections,
      delayMs: input.delayMs,
      maxConcurrencyPerHost: input.maxConcurrencyPerHost,
      maxPages: input.maxPages,
      respectRobotsTxt: input.respectRobotsTxt,
      productOnly: input.productOnly,
      useBrowser: input.useBrowser === true,
      maxRetries: 1,
      // Per-product incremental saves + skip-unchanged on re-runs. The
      // engine writes each product to SQLite as it is fetched, so a crash
      // mid-run never loses what's already been crawled.
      checkpointPath,
      // `onProgress` fires after each URL: first arg = products in hand
      // (freshly fetched + cache-reused), second = URLs discovered.
      onProgress: (processed, total) => {
        const current = jobs.get(jobId);
        if (current) {
          // First tick with a known URL count marks the end of discovery:
          // from here the ETA can be computed on fetch throughput alone.
          if (current.fetchStartedAt === null && total > 0) {
            current.fetchStartedAt = Date.now();
          }
          current.processed = processed;
          current.total = total;
        }
      },
      // `onDiscoveryProgress` fires throughout the discovery phase so the
      // progress panel can show live sitemap/page counts, not a spinner.
      onDiscoveryProgress: (progress) => {
        const current = jobs.get(jobId);
        if (current) {
          current.discovery = progress;
        }
      },
    });
    const current = jobs.get(jobId);
    if (current) {
      const sanitized: CrawlRunResult = {
        stats: {
          discovered: result.stats.discovered,
          fetched: result.stats.fetched,
          skippedUnchanged: result.stats.skippedUnchanged,
          failed: result.stats.failed,
          durationMs: result.stats.durationMs,
        },
        // The full catalogue is saved — comparisons and every product view
        // need all of it, not a sample. Failures stay capped (they're retried
        // on the next run anyway).
        failures: result.stats.failures.slice(0, 100),
        products: result.products.map((p) => ({
          name: p.name,
          brand: p.brand,
          price: p.price,
          available: p.available,
          url: p.url,
        })),
        discovery: result.discovery,
      };
      // Persist to MongoDB BEFORE flipping to "done" so the client's final
      // poll sees an accurate `persisted` flag. Best-effort: a down backend
      // just means the badge doesn't show; the checkpoint cache still holds
      // the data.
      let persisted = false;
      try {
        const backendUrl =
          process.env.PARITY_BACKEND_URL ?? "http://localhost:3000";
        const res = await fetch(`${backendUrl}/api/data/crawl-results`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: input.origin,
            collections: input.collections,
            stats: sanitized.stats,
            products: sanitized.products,
            failures: sanitized.failures,
            discovery: sanitized.discovery,
            storeSnapshots: input.storeSnapshots,
          }),
        });
        persisted = res.ok;
      } catch {
        persisted = false;
      }
      current.status = "done";
      current.total = result.stats.discovered;
      current.processed = result.products.length;
      current.finishedAt = Date.now();
      current.result = sanitized;
      current.persisted = persisted;
    }
  } catch (error) {
    const current = jobs.get(jobId);
    if (current) {
      current.status = "error";
      current.finishedAt = Date.now();
      current.error = error instanceof Error ? error.message : String(error);
    }
  }
}
