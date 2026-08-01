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
    }
  },
  { timestamps: true }
);

// History mode: multiple snapshots per origin, newest first. The legacy
// unique-origin index is dropped on boot (see backend/index.js) so history
// inserts don't collide.
crawlResultSchema.index({ origin: 1, createdAt: -1 });

module.exports = mongoose.model('CrawlResult', crawlResultSchema);
