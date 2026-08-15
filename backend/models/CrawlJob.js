/**
 * CrawlJob — the DB-backed crawl queue (architecture §3.3, Phase 2). One doc
 * per crawl run, claimed atomically by a worker, heartbeat-expired so a
 * crashed worker releases the job, retried with exponential backoff, and
 * TTL-cleaned shortly after finishing.
 *
 * Status machine:
 *   queued → claimed → done
 *   queued → claimed → retrying → (claimed again after backoff) …
 *   retrying/failed → dead (attempts exhausted)
 *
 * The proxy gateway URL (if any) is stored in `params.proxyUrl` — the only
 * place a cross-process worker can receive it. It is STRIPPED from every API
 * response (`publicJob` in `services/jobQueue.js`) so credentials never
 * leave the server; crawl results/logs never contain it.
 */
const mongoose = require('mongoose');

const crawlParamsSchema = new mongoose.Schema(
  {
    // Collection handles to scope the crawl to (e.g. ['silicone-toys']).
    collections: { type: [String], default: [] },
    delayMs: { type: Number, default: 1000 },
    maxConcurrencyPerHost: { type: Number, default: 2 },
    maxPages: { type: Number, default: null },
    respectRobotsTxt: { type: Boolean, default: true },
    productOnly: { type: Boolean, default: true },
    storeSnapshots: { type: Boolean, default: true },
    // AUTO by default: renderer available; only content-poor JS-shell pages
    // are rendered per-page (core/http.ts needsBrowserRender). false = http-only.
    useBrowser: { type: Boolean, default: true },
    /** Whether the crawl routes through a residential proxy (UI badge). */
    proxy: { type: Boolean, default: false },
    /**
     * Worker-only proxy gateway URL. Never returned by any API — `publicJob`
     * exposes only the boolean above.
     */
    proxyUrl: { type: String, default: null },
    /**
     * True when the products list is the COMPLETE catalogue, so the ingest
     * pipeline may detect removals. Deep crawls set true; shallow checks set
     * false (a partial list must never soft-delete the rest of the store).
     */
    fullCrawl: { type: Boolean, default: true },
    /**
     * Optional product-URL filter regex (engine discoverProducts): only
     * discovered URLs matching it are crawled. Kept on the job so the live
     * progress panel can show which filter a run used.
     */
    productUrlPattern: { type: String, default: null },
    /**
     * Optional region/locale token (engine discoverProducts sitemap filter):
     * only sitemaps matching this region are crawled — one country's
     * catalogue for multi-country GCC stores (~4× less work, one currency).
     * Kept on the job so the live progress panel can show which region ran.
     */
    locale: { type: String, default: null },
    /**
     * Per-store User-Agent: `"browser"` (sentinel — the engine resolves it
     * to a Chrome UA for WAF-blocked stores that 403 the ParityBot UA) or a
     * raw UA string; null = default ParityBot UA. MUST live in the schema or
     * Mongoose strict mode silently drops it (the Aug 2026 lesson).
     */
    userAgent: { type: String, default: null }
  },
  { _id: false }
);

const progressSchema = new mongoose.Schema(
  {
    processed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    /** When the fetch phase began (first tick with a known URL count). */
    fetchStartedAt: Date,
    /** Live discovery diagnostics while the discovery phase runs. */
    discovery: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Live HTTP-request count (debug — Active crawls page). */
    requests: { type: Number, default: 0 },
    /**
     * Structured run log (Phase 5 observability) — capped at
     * LOG_LIMIT entries. The engine emits lifecycle lines via its onLog
     * callback and the worker appends them here (throttled with the other
     * heartbeat patches); HTTP-level warnings (429 rate limits) flow through
     * the same path. Kept on the job so a crawl's story survives the worker
     * process — the UI reads it live, and it rides the job's existing TTL.
     */
    log: {
      type: [
        {
          at: { type: Date, default: Date.now },
          level: {
            type: String,
            enum: ['info', 'warn', 'error'],
            default: 'info'
          },
          message: { type: String, default: '' }
        }
      ],
      default: []
    }
  },
  { _id: false }
);

const crawlJobSchema = new mongoose.Schema(
  {
    origin: {
      type: String,
      required: [true, 'Origin URL is required'],
      trim: true,
      lowercase: true
    },
    key: {
      type: String,
      required: [true, 'Normalized host is required'],
      trim: true,
      lowercase: true
    },
    /** shallow = sitemap-only check (new/removed products); deep = full crawl. */
    type: { type: String, enum: ['shallow', 'deep'], default: 'deep' },
    status: {
      type: String,
      enum: ['queued', 'claimed', 'retrying', 'done', 'failed', 'dead', 'cancelled'],
      default: 'queued',
      index: true
    },
    /**
     * Cooperative control request (architecture §3.3 + background-crawler
     * UI): 'pause' holds the job (a worker's engine waits until cleared),
     * 'cancel' requests cancellation (a worker throws CrawlCancelledError
     * and marks the job cancelled; queued jobs are cancelled by the claim
     * sweep). null = run freely. Cleared once the worker acts on it.
     */
    control: { type: String, enum: ['pause', 'cancel'], default: null },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    scheduledAt: { type: Date, default: Date.now },
    startedAt: Date,
    finishedAt: Date,
    workerId: String,
    /** Last worker heartbeat — stale claims are released and requeued. */
    heartbeatAt: Date,
    params: { type: crawlParamsSchema, default: () => ({}) },
    progress: { type: progressSchema, default: () => ({}) },
    /**
     * Pre-crawl analysis snapshot (P2 Phase 2 — analyze-first crawls): the
     * Website Intelligence Analyzer result folded into the job at enqueue
     * time for manual deep crawls — recommendation tier, platform/rendering
     * verdict, sitemap size, what was auto-applied to the captured params
     * (`applied`) and any WAF warning. Null for shallow checks, scheduled
     * runs, and crawls whose probe failed (the crawl still starts). Never
     * contains the proxy URL.
     */
    analysis: { type: mongoose.Schema.Types.Mixed, default: null },
    /**
     * The sanitized crawl result (stats, failures, discovery, products) —
     * written on completion so the final poll can render the result without
     * an extra read. Transient: the TTL index on finishedAt removes the doc
     * ~1h after the run ends (products live on in the Product collection).
     */
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    /** True when the finished result was saved to the data store. */
    persisted: { type: Boolean, default: false },
    error: String
  },
  { timestamps: true }
);

/** Cap on `progress.log` entries kept per job (run-log observability). */
crawlJobSchema.statics.LOG_LIMIT = 200;

// Architecture §3.3 — queue claim order.
crawlJobSchema.index({ status: 1, scheduledAt: 1 });
// Per-store dedupe guard (scheduler must not double-fire) + store history.
crawlJobSchema.index({ origin: 1, type: 1, status: 1, createdAt: -1 });
// TTL cleanup: terminal jobs (done/failed/dead) are removed ~1h after they
// finish. Running jobs have finishedAt null and are untouched.
crawlJobSchema.index(
  { finishedAt: 1 },
  { expireAfterSeconds: 60 * 60 }
);

module.exports = mongoose.model('CrawlJob', crawlJobSchema);
