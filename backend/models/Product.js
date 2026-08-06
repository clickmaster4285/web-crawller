/**
 * Product — current state of one product on one origin, keyed by a stable
 * identity key (gtin > sku > slug > url-hash). Stored ONCE per
 * (origin, identityKey); history lives in Snapshot + ProductEvent + the
 * capped priceHistory array, never in duplicated catalogues (architecture
 * §2.2).
 */
const mongoose = require('mongoose');

/** Max points kept in a product's price series (appended only on change;
 * the post-crawl pipeline trims to the latest PRICE_HISTORY_LIMIT). */
const PRICE_HISTORY_LIMIT = 90;

const pricePointSchema = new mongoose.Schema(
  {
    t: { type: Date, required: true },
    price: { type: Number, required: true },
    available: { type: Boolean, default: true }
  },
  { _id: false }
);

/** Incremental-fetch resume state (architecture §3.1, Phase B) — lets ANY
 * worker resume a store, replacing today's per-machine SQLite checkpoint. */
const httpStateSchema = new mongoose.Schema(
  {
    etag: String,
    lastmod: Number
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    origin: {
      type: String,
      required: [true, 'Origin URL is required'],
      trim: true
    },
    key: {
      type: String,
      required: [true, 'Normalized host is required'],
      trim: true,
      lowercase: true
    },
    // Stable per-product key: first non-empty of gtin > sku > slug, else a
    // URL hash. Used for BOTH change detection (same product over time) and
    // matching across stores.
    identityKey: {
      type: String,
      required: [true, 'Identity key is required']
    },
    name: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: '' },
    price: Number,
    compareAtPrice: Number,
    currency: { type: String, trim: true, uppercase: true, default: 'USD' },
    available: { type: Boolean, default: true },
    url: { type: String, trim: true, default: '' },
    image: { type: String, trim: true, default: '' },
    // Raw identity fields for the match tiers (GTIN > SKU > slug). Leave
    // UNDEFINED when absent so the sparse indexes stay lean (an empty string
    // would occupy an index entry for every product).
    gtin: { type: String, trim: true },
    sku: { type: String, trim: true },
    slug: { type: String, trim: true },
    // Normalized name tokens — the fuzzy inverted index (architecture §4.2).
    // A multikey index makes `tokens: { $in: myTokens }` the candidate query;
    // only those candidates are similarity-scored. Written at ingest.
    tokens: { type: [String], default: [] },
    // Character trigrams of the name — the fuzzy RECALL tier (recovers
    // near-duplicate names that share no tokens, e.g. "Nike Air" vs
    // "NikeAri"). Multikey-indexed per origin like tokens; the candidate
    // query is bounded by a rare-gram frequency cap (see matchService).
    trigrams: { type: [String], default: [] },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    priceUpdatedAt: Date,
    priceHistory: { type: [pricePointSchema], default: [] },
    httpState: { type: httpStateSchema, default: null }
  },
  { timestamps: true }
);

// Upsert key + dedupe guarantee.
productSchema.index({ origin: 1, identityKey: 1 }, { unique: true });
// Match tiers become index lookups (§4.1). Sparse: products without the
// field don't appear, so lookups stay O(rows-with-field).
productSchema.index({ gtin: 1 }, { sparse: true });
productSchema.index({ sku: 1 }, { sparse: true });
productSchema.index({ slug: 1 }, { sparse: true });
// "Currently active" = lastSeenAt >= last crawl time; soft-deleted products
// drop out of live views with this query.
productSchema.index({ origin: 1, lastSeenAt: -1 });
// Market aggregation + cross-store lookup.
productSchema.index({ identityKey: 1, updatedAt: -1 });
// Store search/sort.
productSchema.index({ key: 1, name: 1 });
// Store read path (architecture §6): catalogue list newest-first per store
// (GET /api/stores/:key/products).
productSchema.index({ key: 1, lastSeenAt: -1 });
// Fuzzy inverted index — token → products within an origin.
productSchema.index({ origin: 1, tokens: 1 });
// Trigram recall tier — gram → products within an origin.
productSchema.index({ origin: 1, trigrams: 1 });

const Product = mongoose.model('Product', productSchema);
Product.PRICE_HISTORY_LIMIT = PRICE_HISTORY_LIMIT;

module.exports = Product;
