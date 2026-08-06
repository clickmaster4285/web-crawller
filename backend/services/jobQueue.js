/**
 * jobQueue — the DB-backed crawl queue (architecture §3.3, Phase 2).
 *
 * Express/scheduler enqueue; workers claim atomically, heartbeat, and
 * complete/fail. Stale claims (heartbeat expired) are released and requeued
 * with exponential backoff; attempts-exhausted jobs go `dead` for triage.
 *
 * `publicJob` maps a CrawlJob doc to the exact shape the frontend's
 * `getCrawlProgress` expects (see `frontend/src/lib/crawl.ts` CrawlJob):
 * queued/claimed/retrying → "running", done → "done",
 * failed/dead → "error". The proxy gateway URL is ALWAYS stripped here —
 * only the boolean reaches clients.
 */
const CrawlJob = require('../models/CrawlJob');
const { normalizeHost } = require('../utils/identity');

const HEARTBEAT_TIMEOUT_MS = Number(process.env.PARITY_HEARTBEAT_TIMEOUT_MS ?? 60_000);
// Backstop against a wedged crawl: a job claimed longer than this is treated
// as stuck and released even if heartbeats are fresh (architecture §10 — "a
// misbehaving worker must not hold a store's job forever"). Generous: a
// 10k-product polite deep crawl takes 10-40 min.
const JOB_TIMEOUT_MS = Number(process.env.PARITY_JOB_TIMEOUT_MS ?? 6 * 60 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.PARITY_MAX_ATTEMPTS ?? 3);
const BACKOFF_BASE_MS = Number(process.env.PARITY_BACKOFF_BASE_MS ?? 15_000);
const BACKOFF_CAP_MS = 15 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff for a given attempt count (1-indexed). */
function backoffFor(attempts) {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
}

/**
 * Inserts a crawl job. `params` = the crawl-config snapshot (see the
 * CrawlJob model's params schema — fullCrawl, proxyUrl etc.).
 */
async function enqueueJob({ origin, type = 'deep', params = {}, scheduledAt = new Date() }) {
  const job = await CrawlJob.create({
    origin,
    key: normalizeHost(origin),
    type,
    status: 'queued',
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    scheduledAt,
    params: {
      collections: [],
      delayMs: 1000,
      maxConcurrencyPerHost: 2,
      maxPages: null,
      respectRobotsTxt: true,
      productOnly: true,
      storeSnapshots: true,
      useBrowser: false,
      proxy: false,
      proxyUrl: null,
      fullCrawl: type === 'deep',
      ...params
    }
  });
  return job;
}

/**
 * True when a job exists for this origin+type that is still in flight
 * (queued/claimed/retrying) and was enqueued within `withinMs` of `now`.
 * The scheduler's double-fire guard (decision D4): even two racing scheduler
 * instances cannot enqueue twice within the store's min-interval.
 */
async function hasActiveJob({ origin, type, withinMs, now = Date.now() }) {
  return CrawlJob.exists({
    origin,
    type,
    status: { $in: ['queued', 'claimed', 'retrying'] },
    createdAt: { $gt: new Date(now - withinMs) }
  });
}

/**
 * Releases claims whose heartbeat is older than HEARTBEAT_TIMEOUT_MS — a
 * crashed worker's job must not hold a store forever (architecture §10).
 * Released jobs requeue with exponential backoff; exhausted attempts go dead.
 */
async function releaseStaleClaims() {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);
  const timeoutCutoff = new Date(Date.now() - JOB_TIMEOUT_MS);
  const stale = await CrawlJob.find({
    status: 'claimed',
    // Either the worker stopped heartbeating (crashed) or the crawl has run
    // far past any sane duration (wedged — fresh heartbeats don't save it).
    $or: [{ heartbeatAt: { $lt: cutoff } }, { startedAt: { $lt: timeoutCutoff } }]
  })
    .select('_id attempts maxAttempts startedAt heartbeatAt')
    .lean();
  for (const job of stale) {
    const reason =
      job.heartbeatAt && job.heartbeatAt < cutoff
        ? 'heartbeat expired'
        : 'job timeout exceeded';
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts >= (job.maxAttempts ?? MAX_ATTEMPTS)) {
      await CrawlJob.updateOne(
        { _id: job._id, status: 'claimed' },
        {
          $set: {
            status: 'dead',
            error: `Worker ${reason}`,
            finishedAt: new Date()
          },
          $unset: { workerId: 1, heartbeatAt: 1 }
        }
      );
      console.warn(`🔓 CrawlJob ${job._id} → dead (${reason}, ${attempts} attempts)`);
    } else {
      await CrawlJob.updateOne(
        { _id: job._id, status: 'claimed' },
        {
          $set: {
            status: 'retrying',
            attempts,
            scheduledAt: new Date(Date.now() + backoffFor(attempts))
          },
          $unset: { workerId: 1, heartbeatAt: 1 }
        }
      );
      console.warn(
        `🔓 CrawlJob ${job._id} released (${reason}) → retry in ${backoffFor(attempts) / 1000}s`
      );
    }
  }
  return stale.length;
}

/**
 * Atomically claims the next due job for this worker:
 * findOneAndUpdate on { status in [queued, retrying], scheduledAt <= now }
 * so two workers can never claim the same job. `retrying` jobs are claimed
 * once their backoff `scheduledAt` passes (a retry is just a queued job with
 * a future due time).
 */
async function claimNextJob({ workerId }) {
  await releaseStaleClaims();
  const job = await CrawlJob.findOneAndUpdate(
    { status: { $in: ['queued', 'retrying'] }, scheduledAt: { $lte: new Date() } },
    {
      $set: {
        status: 'claimed',
        workerId,
        heartbeatAt: new Date(),
        startedAt: new Date()
      }
    },
    { sort: { scheduledAt: 1 }, new: true }
  );
  if (job) {
    console.log(
      `🔧 ${workerId} claimed ${job.type} crawl for ${job.origin} (${job._id})`
    );
  }
  return job;
}

/** Worker liveness + live progress counters (throttled by the worker). */
async function heartbeat(jobId, workerId, patch = {}) {
  const set = { heartbeatAt: new Date() };
  if (patch.processed != null || patch.total != null) {
    // progress is a subdoc — $set the counters via dot paths to avoid races.
    if (patch.processed != null) set['progress.processed'] = patch.processed;
    if (patch.total != null) set['progress.total'] = patch.total;
    if (patch.fetchStartedAt != null) set['progress.fetchStartedAt'] = patch.fetchStartedAt;
  }
  if (patch.discovery != null) set['progress.discovery'] = patch.discovery;
  await CrawlJob.updateOne({ _id: jobId, workerId }, { $set: set });
}

/** Marks a job done with the sanitized crawl result. */
async function completeJob(jobId, workerId, { result, persisted = false, progress = {} }) {
  const set = {
    status: 'done',
    finishedAt: new Date(),
    workerId,
    persisted,
    result
  };
  if (progress.processed != null) set['progress.processed'] = progress.processed;
  if (progress.total != null) set['progress.total'] = progress.total;
  // Carried through completion so an ultra-fast crawl (whose throttled
  // heartbeat never wrote it) still reports the phase boundary.
  if (progress.fetchStartedAt != null) {
    set['progress.fetchStartedAt'] = progress.fetchStartedAt;
  }
  await CrawlJob.updateOne({ _id: jobId, workerId }, { $set: set });
}

/**
 * Marks a job failed: retries with exponential backoff until maxAttempts,
 * then goes dead. Returns the new status.
 */
async function failJob(jobId, workerId, error) {
  const job = await CrawlJob.findOne({ _id: jobId }).lean();
  if (!job || job.workerId !== workerId) return 'stale';
  const attempts = (job.attempts ?? 0) + 1;
  if (attempts >= (job.maxAttempts ?? MAX_ATTEMPTS)) {
    await CrawlJob.updateOne(
      { _id: jobId, workerId },
      {
        $set: {
          status: 'dead',
          error: String(error),
          finishedAt: new Date()
        },
        $unset: { heartbeatAt: 1 }
      }
    );
    console.error(`💥 CrawlJob ${jobId} failed permanently: ${error}`);
    return 'dead';
  }
  await CrawlJob.updateOne(
    { _id: jobId, workerId },
    {
      $set: {
        status: 'retrying',
        attempts,
        error: String(error),
        scheduledAt: new Date(Date.now() + backoffFor(attempts))
      },
      $unset: { heartbeatAt: 1 }
    }
  );
  console.error(
    `💥 CrawlJob ${jobId} failed (attempt ${attempts}/${job.maxAttempts}) — retry in ${backoffFor(attempts) / 1000}s: ${error}`
  );
  return 'retrying';
}

/**
 * Maps a CrawlJob doc to the frontend's CrawlJob shape (ms timestamps,
 * running/done/error status, proxy boolean only). Returns null for unknown
 * ids (the UI treats it as a dead/pruned job).
 */
function publicJob(job) {
  if (!job) return null;
  const status =
    job.status === 'done'
      ? 'done'
      : job.status === 'failed' || job.status === 'dead'
        ? 'error'
        : 'running';
  const p = job.params ?? {};
  const pr = job.progress ?? {};
  return {
    status,
    // shallow = sitemap-only check; deep = full crawl (the Sources progress
    // UI badges it, and zero-fetch shallow runs read as "no new products").
    type: job.type ?? 'deep',
    params: {
      delayMs: p.delayMs ?? 1000,
      maxConcurrencyPerHost: p.maxConcurrencyPerHost ?? 2,
      maxPages: p.maxPages ?? null,
      respectRobotsTxt: p.respectRobotsTxt !== false,
      productOnly: p.productOnly !== false,
      storeSnapshots: p.storeSnapshots !== false,
      useBrowser: !!p.useBrowser,
      // proxy URL never leaves the server — boolean only.
      proxy: !!p.proxy
    },
    total: pr.total ?? 0,
    processed: pr.processed ?? 0,
    startedAt: job.startedAt ? job.startedAt.getTime() : job.createdAt?.getTime() ?? Date.now(),
    fetchStartedAt:
      pr.fetchStartedAt instanceof Date ? pr.fetchStartedAt.getTime() : pr.fetchStartedAt ?? null,
    discovery: pr.discovery ?? null,
    finishedAt: job.finishedAt ? job.finishedAt.getTime() : null,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    persisted: !!job.persisted
  };
}

module.exports = {
  enqueueJob,
  hasActiveJob,
  releaseStaleClaims,
  claimNextJob,
  heartbeat,
  completeJob,
  failJob,
  publicJob,
  backoffFor,
  sleep,
  HEARTBEAT_TIMEOUT_MS,
  MAX_ATTEMPTS
};
