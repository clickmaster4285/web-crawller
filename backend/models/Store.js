/**
 * Store — one document per crawled origin: platform profile, crawl cadence
 * and last-run stats. Written/updated at ingest (Phase 1) and read by the
 * scheduler to enqueue shallow/deep crawl jobs (Phase 2, decision D4).
 */
const mongoose = require('mongoose');

const { platformSchema } = require('./shared');

// Per-store crawl cadence. Shallow = sitemap-only check (spots new/removed
// products), deep = full price crawl. minIntervalMs guards the queue against
// double-firing a store (architecture §3.3).
// Per-store crawl cadence. Shallow = sitemap-only check (spots new/removed
// products), deep = full price crawl. minIntervalMs guards the queue against
// double-firing a store (architecture §3.3). `enabled` defaults to FALSE: a
// store is only auto-scheduled when the user registers a schedule (the UI's
// schedule endpoints flip it on), never merely because it was crawled.
const cadenceSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    shallowHours: { type: Number, default: 24, min: 1 },
    deepHours: { type: Number, default: 168, min: 6 },
    minIntervalMs: { type: Number, default: 60 * 60 * 1000 }
  },
  { _id: false }
);

const lastCrawlSchema = new mongoose.Schema(
  {
    at: Date,
    type: { type: String, enum: ['shallow', 'deep'], default: null },
    status: { type: String, enum: ['done', 'failed'], default: null },
    durationMs: Number,
    productCount: Number,
    error: String
  },
  { _id: false }
);

// Crawl params the UI's schedule registered (Phase 2). `proxyUrl` mirrors the
// CrawlJob rule: worker-only, never returned by any API response.
const crawlParamsSchema = new mongoose.Schema(
  {
    delayMs: { type: Number, default: 1000 },
    maxConcurrencyPerHost: { type: Number, default: 2 },
    maxPages: { type: Number, default: null },
    respectRobotsTxt: { type: Boolean, default: true },
    productOnly: { type: Boolean, default: true },
    storeSnapshots: { type: Boolean, default: true },
    // AUTO by default: renderer available; only content-poor JS-shell pages
    // are rendered per-page (core/http.ts needsBrowserRender). false = http-only.
    useBrowser: { type: Boolean, default: true },
    proxy: { type: Boolean, default: false },
    proxyUrl: { type: String, default: null },
    // Optional product-URL filter regex — MUST live in the schema or Mongoose
    // strict mode silently drops it from scheduled-crawl params (the UA
    // lesson from Aug 2026: same trap, same fix).
    productUrlPattern: { type: String, default: null },
    // Optional region/locale token (sitemap filter for multi-country GCC
    // stores) — same MUST-live-in-the-schema rule as productUrlPattern.
    locale: { type: String, default: null },
    // Per-store User-Agent: "browser" sentinel (engine resolves to a Chrome
    // UA for WAF stores that 403 ParityBot) or a raw UA string; null = the
    // default ParityBot UA. MUST live in the schema (same trap, same fix).
    userAgent: { type: String, default: null }
  },
  { _id: false }
);

// P4 store-health pass: the last pre-flight verdict for this store, persisted
// so the Sources profile + /crawls list can flag 0-product stores without a
// fresh analysis. Written by the analyzer controller / pre-crawl gate.
const storeHealthSchema = new mongoose.Schema(
  {
    verdict: {
      type: String,
      enum: ['healthy', 'no-products', 'blocked', 'corporate', 'unclear'],
      default: null
    },
    score: { type: Number, min: 0, max: 100, default: null },
    flags: { type: [String], default: [] },
    analyzedAt: Date
  },
  { _id: false }
);

// The UI's recurring-crawl registration (frequency + the params to run with).
// The scheduler reads this to enqueue shallow/deep jobs (decision D4).
const scheduledCrawlSchema = new mongoose.Schema(
  {
    frequency: {
      type: String,
      enum: ['1h', '6h', 'daily', 'weekly'],
      default: null
    },
    collections: { type: [String], default: [] },
    params: { type: crawlParamsSchema, default: () => ({}) }
  },
  { _id: false }
);

const storeSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: [true, 'Store key (normalized host) is required'],
      trim: true,
      lowercase: true,
      unique: true
    },
    origin: {
      type: String,
      required: [true, 'Origin URL is required'],
      trim: true,
      lowercase: true,
      unique: true
    },
    name: { type: String, trim: true, default: '' },
    platform: { type: platformSchema, default: null },
    cadence: { type: cadenceSchema, default: () => ({}) },
    scheduledCrawl: { type: scheduledCrawlSchema, default: null },
    lastCrawl: { type: lastCrawlSchema, default: null },
    // Per-type last-run anchors so the scheduler's shallow and deep cadences
    // never blur (a shallow run must not push out the deep crawl).
    lastShallowAt: Date,
    lastDeepAt: Date,
    // Latest live count of active products — kept at ingest so
    // `GET /api/stores` needs no per-read aggregation over Product.
    productCount: { type: Number, default: 0 },
    // P4 store-health pass — last pre-flight verdict (see storeHealthSchema).
    health: { type: storeHealthSchema, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Store', storeSchema);
