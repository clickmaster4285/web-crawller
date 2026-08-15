/**
 * Shared embedded schemas used by the normalized collections (`Snapshot`).
 * Originally shared with the legacy `CrawlResult` model during the D1
 * dual-write window; that model is gone, the schemas live on for Snapshot.
 */
const mongoose = require('mongoose');

// --- Crawl stats (Snapshot.stats) ---
const statsSchema = new mongoose.Schema(
  {
    discovered: { type: Number, default: 0 },
    fetched: { type: Number, default: 0 },
    skippedUnchanged: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 }
  },
  { _id: false }
);

// --- Per-URL crawl failures (Snapshot.failures) ---
const failureSchema = new mongoose.Schema(
  {
    url: String,
    error: String
  },
  { _id: false }
);

// --- Discovery diagnostics (Snapshot.discovery) ---
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

/** Detected store platform (Shopify/WooCommerce/…) plus the signal used. */
const platformSchema = new mongoose.Schema(
  {
    platform: { type: String, default: 'Unknown' },
    signal: { type: String, default: '' },
    kind: { type: String, enum: ['store', 'corporate', 'unknown'], default: 'unknown' },
    cms: String,
    builder: String,
    seoPlugin: String,
    server: String,
    generator: String
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
    platform: { type: platformSchema, default: null },
    robots: {
      status: {
        type: String,
        enum: ['found', 'absent', 'unreachable', 'skipped'],
        default: 'skipped'
      },
      crawlDelayMs: { type: Number, default: null }
    },
    homepage: { type: homepageSchema, default: null },
    wooCommerce: {
      status: {
        type: String,
        enum: ['public', 'auth-required', 'unavailable'],
        default: 'unavailable'
      },
      total: { type: Number, default: null },
      urls: { type: Number, default: 0 },
      message: String
    },
    bigCommerce: {
      status: {
        type: String,
        enum: ['public', 'auth-required', 'unavailable'],
        default: 'unavailable'
      },
      total: { type: Number, default: null },
      urls: { type: Number, default: 0 },
      message: String
    },
    findings: { type: [findingSchema], default: [] },
    log: { type: [String], default: [] }
  },
  { _id: false }
);

module.exports = { statsSchema, failureSchema, discoverySchema, platformSchema };
