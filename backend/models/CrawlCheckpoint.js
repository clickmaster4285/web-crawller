/**
 * CrawlCheckpoint — mid-crawl resume snapshot (Step 4, Aug 2026).
 *
 * One doc per in-flight CrawlJob holding the engine's periodic fetch-phase
 * snapshot (see `CrawCheckpoint` in backend/crawler/core/types.ts): the URL
 * list, already-processed URLs, products/failures captured so far, the
 * discovery diagnostics and the storefront-API index/prices. The worker
 * upserts it every ~15s while a crawl runs and deletes it when the job
 * reaches a terminal state.
 *
 * Why a SEPARATE collection instead of a field on CrawlJob: the snapshot
 * grows with the run (a 10k-product store's products array alone can reach
 * several MB) — putting it on the job doc would bloat every `listActiveJobs`
 * read and risk Mongo's 16MB doc limit. Keyed by jobId, the checkpoint is
 * only ever read by the worker that re-claims the same job.
 *
 * Cleanup: docs are deleted on job completion/cancel/failure. A doc orphaned
 * by a crash mid-run is deliberately kept until the job reaches a terminal
 * state (that IS the resume path); the job's own TTL (finishedAt, ~1h)
 * bounds how long a zombie checkpoint can linger after the job is swept.
 */
const mongoose = require('mongoose');

const checkpointSchema = new mongoose.Schema(
  {
    /** The CrawlJob this snapshot belongs to (1:1, unique). */
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true
    },
    /** Origin being crawled (debug + easy cleanup). */
    origin: { type: String, default: '' },
    /** The engine's serialized CrawlCheckpoint (v1). */
    blob: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Last write time — debug; also drives the update filter. */
    updatedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// Orphan safety net: a checkpoint whose job was swept to `dead` by the
// stale-claim sweep never gets a worker delete (the sweep has no worker to
// run the cleanup). TTL removes such rows ~6h after their last write — long
// enough to cover the JOB_TIMEOUT_MS ceiling (6h) plus backoff retries, and
// short enough that abandoned checkpoints can't accumulate forever. Active
// crawls refresh `updatedAt` every ~15s, so their rows never expire.
checkpointSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 6 * 60 * 60 }
);

module.exports = mongoose.model('CrawlCheckpoint', checkpointSchema);
