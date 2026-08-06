/**
 * ProductMatch — persisted your↔competitor product pairs. Written by the
 * match pipeline (Phase 3) at ingest and maintained incrementally; the UI
 * reads paginated matches + latest prices — never recomputes on the request
 * path (architecture §4.3).
 */
const mongoose = require('mongoose');

const productMatchSchema = new mongoose.Schema(
  {
    mineProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Your product id is required']
    },
    mineOrigin: {
      type: String,
      required: [true, 'Your origin is required'],
      trim: true
    },
    competitorKey: {
      type: String,
      required: [true, 'Competitor key is required'],
      trim: true,
      lowercase: true
    },
    competitorProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Competitor product id is required']
    },
    method: {
      type: String,
      required: [true, 'Match method is required'],
      enum: ['GTIN', 'SKU', 'URL slug', 'fuzzy']
    },
    confidence: { type: Number, min: 0, max: 100, default: 100 }
  },
  { timestamps: true }
);

// One match per (your product, competitor store) — a product sold by 5
// competitors appears in 5 rows. Upsert key for the match pipeline.
productMatchSchema.index(
  { mineProductId: 1, competitorKey: 1 },
  { unique: true }
);
productMatchSchema.index({ competitorKey: 1, method: 1 });

module.exports = mongoose.model('ProductMatch', productMatchSchema);
