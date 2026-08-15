/**
 * prune-terminal-jobs — scale hygiene for the CrawlJob collection.
 *
 * Finished jobs embed the FULL product array in `result` (a deep crawl of a
 * 10k-product store can be ~1 MB per job doc) — the same data already lives
 * in `products`/`snapshots`, so it's pure duplication that inflates the
 * collection. This script strips `result` from terminal jobs (done / failed
 * / dead / cancelled) OLDER than a keep window, so the last hour of history
 * stays fully readable and everything older shrinks to its metadata + run
 * log. The run log (`progress.log`) is KEPT — that's the observability story.
 *
 * Safe: only touches terminal jobs, only unsets `result`, never touches
 * queued/claimed/retrying jobs, idempotent, dry-run by default.
 *
 * Run:  npm run prune-terminal-jobs            (dry run — reports only)
 *       npm run prune-terminal-jobs -- --apply  (actually prune)
 *       KEEP_MS=3600000 npm run prune-terminal-jobs -- --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const CrawlJob = require('../models/CrawlJob');

// Keep fully-readable history for the last hour (matches the TTL window the
// UI already treats as "recent"). Override with KEEP_MS.
const KEEP_MS = Number(process.env.KEEP_MS ?? 60 * 60 * 1000);

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDatabase();

  const cutoff = new Date(Date.now() - KEEP_MS);
  const terminal = await CrawlJob.find({
    status: { $in: ['done', 'failed', 'dead', 'cancelled'] },
    finishedAt: { $lt: cutoff },
    result: { $exists: true, $ne: null },
  })
    .select('_id origin type status finishedAt')
    .lean();

  console.log(
    `${apply ? '🧹' : '🔍'} ${terminal.length} terminal job(s) older than ` +
      `${new Date(cutoff).toISOString()} still carry a full result payload.`
  );
  if (terminal.length === 0) {
    console.log('✅ Nothing to prune.');
    await mongoose.disconnect();
    process.exit(0);
  }
  if (!apply) {
    console.log('Dry run — pass `--apply` to actually strip `result`.');
    await mongoose.disconnect();
    process.exit(0);
  }

  let freed = 0;
  for (const job of terminal) {
    // ~size of the payload being dropped (the avg doc is ~1 MB; the result
    // is nearly all of it). Rough but useful for the summary line.
    const before = (await CrawlJob.findOne({ _id: job._id }).select('result').lean())
      ?.result;
    const approxBytes = before ? JSON.stringify(before).length : 0;
    const r = await CrawlJob.updateOne(
      { _id: job._id, status: job.status },
      { $unset: { result: 1 } }
    );
    if (r.modifiedCount > 0) {
      freed += approxBytes;
      console.log(
        `  - ${job.origin} [${job.type}] ${job.status} · ${(approxBytes / 1024 / 1024).toFixed(1)} MB`
      );
    }
  }
  console.log(
    `✅ Pruned ${terminal.length} job(s) — roughly ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB of duplicate product arrays freed.`
  );
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error('💥 prune failed:', error);
  process.exit(1);
});
