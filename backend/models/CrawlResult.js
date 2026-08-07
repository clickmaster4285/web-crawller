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
 *
 * Legacy model: it embeds the full product array per snapshot doc, which is
 * exactly what the Phase-1 `Product`/`Snapshot` split replaces. It stays
 * dual-written through the migration and is dropped in Phase 5 (decision D1).
 * The stats/failure/discovery shapes are shared with the new `Snapshot` model
 * via `./shared` so the dual-write window can't drift.
 */
const mongoose = require('mongoose');

const { statsSchema, discoverySchema, failureSchema } = require('./shared');

const productSchema = new mongoose.Schema(
  {
    name: String,
    brand: String,
    price: Number,
    // Native currency captured by the extractor (null = unknown — never a
    // silent 'USD' default; the normalized Product model does the same).
    currency: { type: String, default: null },
    available: Boolean,
    url: String,
    // Identity fields captured by the crawler — the matching layer matches
    // GTIN > SKU > slug > fuzzy, so exact identity must survive persistence.
    sku: { type: String, default: '' },
    gtin: { type: String, default: '' }
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
    /**
     * Job type this snapshot came from: 'shallow' (sitemap-only check that
     * fetched only new products) or 'deep' (full crawl). Absent on docs saved
     * before the field landed — those were all full crawls, so the UI reads
     * missing as 'deep'.
     */
    type: { type: String, enum: ['shallow', 'deep'], default: 'deep' },
    collections: {
      type: [String],
      default: []
    },
    stats: { type: statsSchema, default: () => ({}) },
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
