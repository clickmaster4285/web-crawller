/**
 * Snapshot — metadata for one completed crawl run (shallow or deep): stats,
 * add/remove/change counts and capped key lists. NO product arrays — the
 * catalogue lives in Product. History is capped per origin by the post-crawl
 * pipeline (SNAPSHOT_LIMIT, decision D3).
 */
const mongoose = require('mongoose');

const { statsSchema, discoverySchema, failureSchema } = require('./shared');

/** Max snapshots kept per origin (decision D3 — trimmed from the legacy 20). */
const SNAPSHOT_LIMIT = 10;

/** Max identity keys kept in the added/removed summaries (pipeline caps). */
const KEYS_SUMMARY_LIMIT = 500;

/** Max failures kept per snapshot (pipeline caps). */
const FAILURES_LIMIT = 100;

const snapshotSchema = new mongoose.Schema(
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
    startedAt: Date,
    finishedAt: {
      type: Date,
      required: [true, 'Finished time is required']
    },
    durationMs: Number,
    stats: { type: statsSchema, default: () => ({}) },
    // True when this run saw the COMPLETE catalogue (deep crawl). Shallow
    // checks (Phase 2) write full:false — the removal diff anchors on the
    // last full snapshot so a partial run never shifts the active-set
    // boundary and hides a later removal.
    full: { type: Boolean, default: true },
    productCount: { type: Number, default: 0 },
    addedCount: { type: Number, default: 0 },
    removedCount: { type: Number, default: 0 },
    priceChangedCount: { type: Number, default: 0 },
    stockChangedCount: { type: Number, default: 0 },
    addedKeys: { type: [String], default: [] },
    removedKeys: { type: [String], default: [] },
    discovery: { type: discoverySchema, default: null },
    failures: { type: [failureSchema], default: [] }
  },
  { timestamps: true }
);

snapshotSchema.index({ origin: 1, finishedAt: -1 });

const Snapshot = mongoose.model('Snapshot', snapshotSchema);
Snapshot.SNAPSHOT_LIMIT = SNAPSHOT_LIMIT;
Snapshot.KEYS_SUMMARY_LIMIT = KEYS_SUMMARY_LIMIT;
Snapshot.FAILURES_LIMIT = FAILURES_LIMIT;

module.exports = Snapshot;
