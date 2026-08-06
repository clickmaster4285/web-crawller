/**
 * ProductEvent — the change log. One row per product change
 * (added / removed / price_changed / stock_changed), computed ONCE at ingest;
 * everything downstream ("what's new", sparklines, biggest movers, the alerts
 * engine) reads these rows instead of recomputing diffs on page load
 * (architecture §5.2).
 */
const mongoose = require('mongoose');

/** How long event rows live (TTL index on `at`). If long-range trends are
 * ever needed, older rows roll up into daily aggregates (architecture §10). */
const EVENT_TTL_SECONDS = 90 * 24 * 60 * 60;

const eventDeltaSchema = new mongoose.Schema(
  {
    price: Number,
    available: Boolean
  },
  { _id: false }
);

const productEventSchema = new mongoose.Schema(
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
    type: {
      type: String,
      required: [true, 'Event type is required'],
      enum: ['added', 'removed', 'price_changed', 'stock_changed']
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product id is required']
    },
    identityKey: {
      type: String,
      required: [true, 'Identity key is required']
    },
    // Denormalized onto the event so reads need no join.
    name: { type: String, trim: true, default: '' },
    url: { type: String, trim: true, default: '' },
    old: { type: eventDeltaSchema, default: null },
    new: { type: eventDeltaSchema, default: null },
    snapshotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Snapshot',
      default: null
    },
    at: { type: Date, default: Date.now }
  },
  // Events are immutable rows with a semantic `at` — there is no meaningful
  // updatedAt, so don't track one (saves ~40 B × hundreds of thousands of
  // rows/day).
  { timestamps: { createdAt: true, updatedAt: false } }
);

productEventSchema.index({ origin: 1, at: -1 });
productEventSchema.index({ type: 1, at: -1 });
productEventSchema.index({ productId: 1, at: -1 });
// TTL: rows expire EVENT_TTL_SECONDS after `at`.
productEventSchema.index({ at: 1 }, { expireAfterSeconds: EVENT_TTL_SECONDS });

const ProductEvent = mongoose.model('ProductEvent', productEventSchema);
ProductEvent.EVENT_TTL_SECONDS = EVENT_TTL_SECONDS;

module.exports = ProductEvent;
