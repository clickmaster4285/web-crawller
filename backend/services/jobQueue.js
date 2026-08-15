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
async function enqueueJob({
  origin,
  type = 'deep',
  params = {},
  analysis = null,
  scheduledAt = new Date()
}) {
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
      // AUTO by default: the renderer is available and the engine renders
      // only content-poor JS-shell pages (see core/http.ts needsBrowserRender).
      useBrowser: true,
      proxy: false,
      proxyUrl: null,
      fullCrawl: type === 'deep',
      productUrlPattern: null,
      locale: null,
      userAgent: null,
      ...params
    },
    analysis
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
  // Sweep: jobs cancelled while they sat in the queue never get claimed —
  // they're marked cancelled here so the caller's cancel takes effect even
  // if no worker was around to see the request. (Claimed jobs handle cancel
  // via the worker's control poll instead.)
  const swept = await CrawlJob.updateMany(
    { status: { $in: ['queued', 'retrying'] }, control: 'cancel' },
    {
      $set: { status: 'cancelled', finishedAt: new Date() },
      $unset: { control: 1 }
    }
  );
  if (swept.modifiedCount > 0) {
    console.log(`🗑️  ${workerId} cancelled ${swept.modifiedCount} queued job(s)`);
  }
  const job = await CrawlJob.findOneAndUpdate(
    {
      status: { $in: ['queued', 'retrying'] },
      // Paused jobs stay queued until resumed (control cleared); a cancel
      // request landing between the sweep above and this claim must also
      // not be claimed (it self-heals via the worker's control poll, but
      // skipping it here avoids wasting a claim + a crawl start).
      control: { $nin: ['pause', 'cancel'] },
      scheduledAt: { $lte: new Date() }
    },
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
  if (patch.requests != null) set['progress.requests'] = patch.requests;
  const ops = [{ updateOne: { filter: { _id: jobId, workerId }, update: { $set: set } } }];
  // Run-log append (Phase 5 observability): `patch.log` is an array of NEW
  // {at, level, message} lines since the last beat — appended atomically and
  // capped so a long crawl can't balloon the job doc. $push+$slice in one op
  // with the $set above (single write, no race between counters and log).
  const push = logPush(patch.log);
  if (push) ops[0].updateOne.update.$push = push;
  await CrawlJob.bulkWrite(ops);
}

/**
 * Marks a job done with the sanitized crawl result. `log` (optional) is the
 * worker's remaining buffered run-log lines — flushed atomically with the
 * status flip so the final lifecycle line survives the heartbeat timers
 * being torn down.
 */
async function completeJob(jobId, workerId, { result, persisted = false, progress = {}, log }) {
  const set = {
    status: 'done',
    finishedAt: new Date(),
    workerId,
    persisted,
    result
  };
  if (progress.processed != null) set['progress.processed'] = progress.processed;
  if (progress.total != null) set['progress.total'] = progress.total;
  if (progress.requests != null) set['progress.requests'] = progress.requests;
  // Carried through completion so an ultra-fast crawl (whose throttled
  // heartbeat never wrote it) still reports the phase boundary.
  if (progress.fetchStartedAt != null) {
    set['progress.fetchStartedAt'] = progress.fetchStartedAt;
  }
  const update = { $set: set };
  const push = logPush(log);
  if (push) update.$push = push;
  await CrawlJob.updateOne({ _id: jobId, workerId }, update);
}

/**
 * Marks a job failed: retries with exponential backoff until maxAttempts,
 * then goes dead. Returns the new status. `log` (optional) is the worker's
 * buffered run-log lines, flushed atomically with the failure write.
 */
async function failJob(jobId, workerId, error, log) {
  const job = await CrawlJob.findOne({ _id: jobId }).lean();
  if (!job || job.workerId !== workerId) return 'stale';
  const attempts = (job.attempts ?? 0) + 1;
  if (attempts >= (job.maxAttempts ?? MAX_ATTEMPTS)) {
    const update = {
      $set: {
        status: 'dead',
        error: String(error),
        finishedAt: new Date()
      },
      $unset: { heartbeatAt: 1 }
    };
    const push = logPush(log);
    if (push) update.$push = push;
    await CrawlJob.updateOne({ _id: jobId, workerId }, update);
    console.error(`💥 CrawlJob ${jobId} failed permanently: ${error}`);
    return 'dead';
  }
  const update = {
    $set: {
      status: 'retrying',
      attempts,
      error: String(error),
      scheduledAt: new Date(Date.now() + backoffFor(attempts))
    },
    $unset: { heartbeatAt: 1 }
  };
  const push = logPush(log);
  if (push) update.$push = push;
  await CrawlJob.updateOne({ _id: jobId, workerId }, update);
  console.error(
    `💥 CrawlJob ${jobId} failed (attempt ${attempts}/${job.maxAttempts}) — retry in ${backoffFor(attempts) / 1000}s: ${error}`
  );
  return 'retrying';
}

/**
 * Builds the `$push` op for a run-log append (Phase 5 observability) — the
 * same $push+$slice used by `heartbeat`, shared by the terminal writes so a
 * worker's final lifecycle lines flush atomically with the status flip.
 * Returns null when there's nothing to append.
 */
function logPush(log) {
  return Array.isArray(log) && log.length > 0
    ? { 'progress.log': { $each: log, $slice: -CrawlJob.LOG_LIMIT } }
    : null;
}

/**
 * Maps a CrawlJob doc to the frontend's CrawlJob shape (ms timestamps,
 * running/done/error status, proxy boolean only). Returns null for unknown
 * ids (the UI treats it as a dead/pruned job).
 *
 * `options.includeResult` (default true) drops the (potentially huge) result
 * payload — list endpoints never ship a finished crawl's full product array.
 */
function publicJob(job, options = {}) {
  if (!job) return null;
  const { includeResult = true } = options;
  const status =
    job.status === 'done'
      ? 'done'
      : job.status === 'failed' || job.status === 'dead'
        ? 'error'
        : job.status === 'cancelled'
          ? 'cancelled'
          : 'running';
  const p = job.params ?? {};
  const pr = job.progress ?? {};
  // Worker liveness: a claimed job whose heartbeat is older than
  // HEARTBEAT_TIMEOUT_MS may have a crashed worker (the release sweep only
  // requeues it when another worker claims, so it can sit visible here for a
  // while). The UI warns on this so a dead worker is visible without grepping
  // logs. Null for queued/terminal jobs (never heartbeated or released).
  const heartbeatAt =
    job.heartbeatAt instanceof Date ? job.heartbeatAt.getTime() : null;
  const heartbeatStale =
    job.status === 'claimed' &&
    (heartbeatAt == null || Date.now() - heartbeatAt > HEARTBEAT_TIMEOUT_MS);
  return {
    // Raw backend state (queued/claimed/retrying/…) — the active-jobs UI
    // badges queued vs running vs retrying from it.
    state: job.status ?? 'queued',
    id: String(job._id),
    origin: job.origin,
    /** Worker that claimed/owns the job (null while queued — debugging). */
    workerId: job.workerId ?? null,
    /** Last worker heartbeat (ms) — null while queued/terminal. */
    heartbeatAt,
    /**
     * True when a claimed job's worker stopped heartbeating within the
     * timeout — the worker may have crashed (amber warning in the UI).
     */
    heartbeatStale,
    /** Live HTTP-request count (debug — Active crawls page). */
    requests: pr.requests ?? 0,
    /** Cooperative control request: 'pause' | 'cancel' | null (run freely). */
    control: job.control ?? null,
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
      proxy: !!p.proxy,
      productUrlPattern: p.productUrlPattern ?? null,
      locale: p.locale ?? null,
      // 'browser' (engine resolves to a Chrome UA) or a raw UA string; null =
      // default ParityBot UA.
      userAgent: p.userAgent ?? null
    },
    total: pr.total ?? 0,
    processed: pr.processed ?? 0,
    startedAt: job.startedAt ? job.startedAt.getTime() : job.createdAt?.getTime() ?? Date.now(),
    fetchStartedAt:
      pr.fetchStartedAt instanceof Date ? pr.fetchStartedAt.getTime() : pr.fetchStartedAt ?? null,
    discovery: pr.discovery ?? null,
    // Structured run log — newest LAST, ms timestamps (the UI appends live
    // lines as they arrive). Capped server-side at CrawlJob.LOG_LIMIT.
    log: Array.isArray(pr.log)
      ? pr.log.map((line) => ({
          at: line.at instanceof Date ? line.at.getTime() : line.at ?? Date.now(),
          level: line.level ?? 'info',
          message: line.message ?? ''
        }))
      : [],
    finishedAt: job.finishedAt ? job.finishedAt.getTime() : null,
    // Pre-crawl analysis snapshot (P2 Phase 2) — the strategy the job was
    // started with, already sanitized at enqueue (no proxy URL in it).
    analysis: job.analysis ?? null,
    result: includeResult ? (job.result ?? undefined) : undefined,
    error: job.error ?? undefined,
    persisted: !!job.persisted
  };
}

/**
 * Cooperative control (background-crawler UI): pause / resume / cancel.
 *
 * - pause on an unclaimed job → it stays queued (claimNextJob skips
 *   `control: 'pause'`); on a claimed job → the worker's engine waits.
 * - resume clears the request.
 * - cancel on an unclaimed job → cancelled immediately; on a claimed job →
 *   the worker's control poll throws CrawlCancelledError and marks it
 *   cancelled (no result persisted). Returns null when the job is unknown
 *   or already terminal.
 */
async function setJobControl(jobId, action) {
  const job = await CrawlJob.findOne({
    _id: jobId,
    status: { $in: ['queued', 'claimed', 'retrying'] }
  });
  if (!job) return null;
  if (action === 'cancel' && job.status !== 'claimed') {
    // No worker is involved — cancel right now.
    await CrawlJob.updateOne(
      { _id: jobId },
      {
        $set: { status: 'cancelled', control: null, finishedAt: new Date() }
      }
    );
  } else if (action === 'cancel') {
    // Claimed — hand the request to the worker's control poll.
    await CrawlJob.updateOne({ _id: jobId }, { $set: { control: 'cancel' } });
  } else {
    // pause / resume: store the request; the worker (or claim filter) acts.
    await CrawlJob.updateOne({ _id: jobId }, { $set: { control: action } });
  }
  return job;
}

/**
 * Marks a claimed job cancelled (called by the worker after a user cancel).
 * `log` (optional) is the worker's buffered run-log lines, flushed with the
 * status flip so the cancellation reason survives.
 */
async function cancelJob(jobId, workerId, log) {
  const update = {
    $set: { status: 'cancelled', finishedAt: new Date() },
    $unset: { control: 1, heartbeatAt: 1 }
  };
  const push = logPush(log);
  if (push) update.$push = push;
  await CrawlJob.updateOne({ _id: jobId, workerId }, update);
}

/**
 * Background-crawler list: in-flight jobs (queued/claimed/retrying — paused
 * ones included) plus the last 15 minutes of finished ones, so a cancel or
 * completion is immediately visible. Results are never shipped here.
 */
async function listActiveJobs() {
  const active = await CrawlJob.find({
    status: { $in: ['queued', 'claimed', 'retrying'] }
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  const recent = await CrawlJob.find({
    status: { $in: ['done', 'failed', 'dead', 'cancelled'] },
    finishedAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) }
  })
    .sort({ finishedAt: -1 })
    .limit(15)
    .lean();
  return {
    active: active.map((j) => publicJob(j, { includeResult: false })),
    recent: recent.map((j) => publicJob(j, { includeResult: false }))
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
  cancelJob,
  setJobControl,
  listActiveJobs,
  publicJob,
  backoffFor,
  sleep,
  HEARTBEAT_TIMEOUT_MS,
  MAX_ATTEMPTS
};
