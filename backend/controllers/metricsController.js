/**
 * metricsController — Phase 5 observability: `GET /api/data/metrics` serves
 * crawl-job health from the CrawlJob queue itself (no counters to maintain —
 * everything is derived live from the collection, so it can never drift from
 * what the workers actually did):
 *
 *   - queue        — live depth by status (queued/claimed/retrying/terminal)
 *   - workers      — distinct workers with fresh heartbeats, stale claims,
 *                    jobs in flight
 *   - throughput   — jobs finished in the last 24h / 7d, split by type
 *                    (deep vs shallow) with success/failure rates
 *   - durations    — avg / median / p95 wall time of finished deep + shallow
 *                    jobs in each window
 *   - requests     — total HTTP requests reported across claimed+finished
 *                    jobs in each window (progress.requests)
 *   - schedules    — how many recurring crawls are enabled (Store docs)
 *
 * A claimed job is considered alive when its heartbeat is fresh
 * (`HEARTBEAT_TIMEOUT_MS` — same constant the queue release sweep uses, so
 * the metric agrees with when a claim would be released).
 */
const CrawlJob = require('../models/CrawlJob');
const Store = require('../models/Store');

const HEARTBEAT_TIMEOUT_MS = Number(process.env.PARITY_HEARTBEAT_TIMEOUT_MS ?? 60_000);

const DAY_MS = 24 * 60 * 60 * 1000;

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

/**
 * Builds the per-window summary for finished jobs (done/failed/dead/
 * cancelled with a finishedAt in [since, now]).
 */
async function windowSummary(since) {
  const jobs = await CrawlJob.find({
    status: { $in: ['done', 'failed', 'dead', 'cancelled'] },
    finishedAt: { $gte: since }
  })
    .select('status type finishedAt startedAt progress')
    .lean();

  const byStatus = { done: 0, failed: 0, dead: 0, cancelled: 0 };
  const byType = { deep: 0, shallow: 0 };
  const durations = [];
  const failedDurations = [];
  let requests = 0;

  for (const j of jobs) {
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    const t = j.type === 'shallow' ? 'shallow' : 'deep';
    byType[t]++;
    const durationMs =
      j.startedAt && j.finishedAt
        ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()
        : null;
    if (durationMs != null && Number.isFinite(durationMs) && durationMs >= 0) {
      durations.push(durationMs);
      if (j.status === 'failed' || j.status === 'dead') failedDurations.push(durationMs);
    }
    requests += j.progress?.requests ?? 0;
  }

  const total = jobs.length;
  const succeeded = byStatus.done;

  return {
    total,
    byStatus,
    byType,
    successRate: pct(succeeded, total),
    failureRate: pct(byStatus.failed + byStatus.dead, total),
    durations: {
      count: durations.length,
      avgMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
      medianMs: median(durations),
      p95Ms: p95(durations)
    },
    failedDurations: {
      count: failedDurations.length,
      avgMs: failedDurations.length
        ? Math.round(failedDurations.reduce((a, b) => a + b, 0) / failedDurations.length)
        : null
    },
    requests
  };
}

/** GET /api/data/metrics — crawl-job health snapshot. */
const getMetrics = async (req, res) => {
  try {
    const now = Date.now();
    const cutoff = new Date(now - HEARTBEAT_TIMEOUT_MS);

    const [queueCounts, claimed, [last24h, last7d], schedules] = await Promise.all([
      // Live queue depth by status (one grouped aggregation).
      CrawlJob.aggregate([
        { $group: { _id: '$status', n: { $sum: 1 } } }
      ]),
      // Claimed jobs — the live worker picture (fresh vs stale heartbeats).
      CrawlJob.find({ status: 'claimed' })
        .select('workerId heartbeatAt origin type')
        .lean(),
      // Throughput windows run sequentially (both cheap, indexed on
      // finishedAt's TTL index).
      Promise.all([
        windowSummary(new Date(now - DAY_MS)),
        windowSummary(new Date(now - 7 * DAY_MS))
      ]),
      Store.countDocuments({ 'cadence.enabled': true })
    ]);

    const queue = { queued: 0, claimed: 0, retrying: 0, done: 0, failed: 0, dead: 0, cancelled: 0 };
    for (const r of queueCounts) {
      if (r._id in queue) queue[r._id] = r.n;
    }
    queue.inFlight = queue.queued + queue.claimed + queue.retrying;

    // Workers: distinct ids across claimed jobs; alive = at least one fresh
    // heartbeat. Stale claims = claimed jobs whose worker stopped beating.
    const workers = new Map();
    let staleClaims = 0;
    for (const j of claimed) {
      const fresh = j.heartbeatAt && new Date(j.heartbeatAt).getTime() >= cutoff;
      if (!fresh) staleClaims++;
      if (!j.workerId) continue;
      const w = workers.get(j.workerId) ?? { workerId: j.workerId, alive: false, jobs: [] };
      w.alive = w.alive || !!fresh;
      w.jobs.push({ jobId: String(j._id), origin: j.origin, type: j.type ?? 'deep' });
      workers.set(j.workerId, w);
    }

    res.json({
      success: true,
      data: {
        generatedAt: new Date(now).toISOString(),
        queue,
        workers: {
          active: [...workers.values()],
          activeCount: workers.size,
          aliveCount: [...workers.values()].filter((w) => w.alive).length,
          staleClaims,
          heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS
        },
        throughput: {
          last24h,
          last7d
        },
        schedules: {
          active: schedules
        }
      }
    });
  } catch (error) {
    console.error('Metrics error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { getMetrics };
