/**
 * CrawlResult — persisted snapshot of a completed crawl for an origin.
 *
 * The TanStack server posts a sanitized crawl result here when a crawl
 * finishes. Two modes:
 *   - **snapshots** (default, `storeSnapshots: true`): each run appends a new
 *     document, keeping history for trend analysis (capped per origin by the
 *     controller).
 *   - **replace** (`storeSnapshots: false`): one document per origin — the
 *     latest run replaces the previous one.
 */
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: String,
    brand: String,
    price: Number,
    available: Boolean,
    url: String
  },
  { _id: false }
);

const failureSchema = new mongoose.Schema(
  {
    url: String,
    error: String
  },
  { _id: false }
);

const discoveryCollectionSchema = new mongoose.Schema(
  {
    collection: String,
    handles: Number,
    error: String
  },
  { _id: false, suppressReservedKeysWarning: true }
);

const sitemapCandidateSchema = new mongoose.Schema(
  {
    url: String,
    source: { type: String, enum: ['robots.txt', 'default'], default: 'default' },
    status: { type: String, enum: ['ok', 'html', 'error'], default: 'ok' },
    urls: { type: Number, default: 0 },
    productUrls: { type: Number, default: 0 },
    error: String
  },
  { _id: false }
);

const externalStoreLinkSchema = new mongoose.Schema(
  {
    url: String,
    host: String,
    label: String
  },
  { _id: false }
);

const homepageSchema = new mongoose.Schema(
  {
    productLinks: { type: Number, default: 0 },
    categoryLinks: { type: Number, default: 0 },
    looksLikeStore: { type: Boolean, default: false },
    externalStoreLinks: { type: [externalStoreLinkSchema], default: [] },
    note: String
  },
  { _id: false }
);

const findingActionSchema = new mongoose.Schema(
  {
    label: String,
    url: String
  },
  { _id: false }
);

const findingSchema = new mongoose.Schema(
  {
    level: { type: String, enum: ['info', 'warning', 'success'], default: 'info' },
    message: String,
    action: { type: findingActionSchema, default: null }
  },
  { _id: false }
);

const discoverySchema = new mongoose.Schema(
  {
    collections: { type: [discoveryCollectionSchema], default: [] },
    sitemap: {
      urls: { type: Number, default: 0 },
      lastmod: { type: Number, default: 0 },
      error: String,
      candidates: { type: [sitemapCandidateSchema], default: [] }
    },
    htmlCrawl: {
      urls: { type: Number, default: 0 },
      pagesVisited: { type: Number, default: 0 },
      truncated: { type: Boolean, default: false },
      error: String
    },
    platform: {
      platform: { type: String, default: 'Unknown' },
      signal: { type: String, default: '' },
      kind: { type: String, enum: ['store', 'corporate', 'unknown'], default: 'unknown' },
      cms: String,
      builder: String,
      seoPlugin: String,
      server: String,
      generator: String
    },
    robots: {
      status: {
        type: String,
        enum: ['found', 'absent', 'unreachable', 'skipped'],
        default: 'skipped'
      },
      crawlDelayMs: { type: Number, default: null }
    },
    homepage: { type: homepageSchema, default: null },
    findings: { type: [findingSchema], default: [] },
    log: { type: [String], default: [] }
  },
  { _id: false }
);

const crawlResultSchema = new mongoose.Schema(
  {
    origin: {
      type: String,
      required: [true, 'Origin is required'],
      trim: true
    },
    collections: {
      type: [String],
      default: []
    },
    stats: {
      discovered: { type: Number, default: 0 },
      fetched: { type: Number, default: 0 },
      skippedUnchanged: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 }
    },
    products: {
      type: [productSchema],
      default: []
    },
    failures: {
      type: [failureSchema],
      default: []
    },
    discovery: {
      type: discoverySchema,
      default: null
    }
  },
  { timestamps: true }
);

// History mode: multiple snapshots per origin, newest first. The legacy
// unique-origin index is dropped on boot (see backend/index.js) so history
// inserts don't collide.
crawlResultSchema.index({ origin: 1, createdAt: -1 });

module.exports = mongoose.model('CrawlResult', crawlResultSchema);
