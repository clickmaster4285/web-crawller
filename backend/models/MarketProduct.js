/**
 * MarketProduct — per-identity aggregate across stores: which stores sell
 * identity K, price range and store count. Updated at ingest (decision D2 —
 * built now, minimal scope: the text index and market search are deferred
 * until the Catalogue page needs them). Makes pricing/dashboard reads one
 * indexed lookup (architecture §4.4).
 */
const mongoose = require('mongoose');

const marketStoreSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    price: Number,
    available: { type: Boolean, default: true },
    updatedAt: Date
  },
  { _id: false }
);

const marketProductSchema = new mongoose.Schema(
  {
    // Cross-store identity — a GTIN/SKU-based identityKey is the same string
    // on every store, so this aggregate needs no match rows to be correct.
    identityKey: {
      type: String,
      required: [true, 'Identity key is required']
    },
    name: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },
    storeCount: { type: Number, default: 0 },
    minPrice: Number,
    maxPrice: Number,
    avgPrice: Number,
    stores: { type: [marketStoreSchema], default: [] }
  },
  { timestamps: true }
);

marketProductSchema.index({ identityKey: 1 }, { unique: true });

module.exports = mongoose.model('MarketProduct', marketProductSchema);
