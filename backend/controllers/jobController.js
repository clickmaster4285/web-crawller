/**
 * jobController — Phase 2 crawl queue endpoints (architecture §3.3, D4).
 *
 *   POST   /api/crawl-jobs               enqueue a one-off deep crawl
 *   GET    /api/crawl-jobs/:id           UI-shaped progress/result (publicJob)
 *   POST   /api/crawl-jobs/schedules     register/replace a recurring crawl
 *   GET    /api/crawl-jobs/schedules     list active recurring crawls
 *   DELETE /api/crawl-jobs/schedules/:origin   cancel a recurring crawl
 *
 * The queue itself lives in `services/jobQueue.js`; the Sources page keeps its
 * exact behavior because `publicJob`/`publicSchedule` return the shapes the
 * frontend server functions (`src/lib/crawl.ts`) already produce.
 */
const mongoose = require('mongoose');
const Store = require('../models/Store');
const {
  enqueueJob,
  hasActiveJob,
  setJobControl,
  listActiveJobs,
  publicJob
} = require('../services/jobQueue');
const { runAnalyzer, persistStoreHealth } = require('./analyzeController');

const HOUR_MS = 60 * 60 * 1000;

/** Frequency → ms (mirrors the frontend's FREQUENCY_MS in src/lib/crawl.ts). */
const FREQUENCY_MS = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS
};

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Validates + normalizes a crawl-enqueue body (the frontend's CrawlRunInput).
 * SSRF guard: only http(s) origins are accepted. Proxy URL is kept in
 * `params.proxyUrl` (worker-only) and never echoed by any response.
 */
function normalizeCrawlInput(body = {}) {
  const origin = String(body.origin ?? '').trim();
  if (!/^https?:\/\/\S+/i.test(origin)) {
    throw httpError(400, 'Origin must be a valid http(s) URL');
  }
  const proxy = body.proxy != null ? String(body.proxy).trim() : '';
  if (proxy && !/^https?:\/\/\S+/i.test(proxy)) {
    throw httpError(400, 'Proxy must be a valid http(s) URL');
  }
  const maxPages =
    body.maxPages == null || body.maxPages === ''
      ? null
      : Math.max(1, Math.round(Number(body.maxPages)));
  if (maxPages != null && !Number.isFinite(maxPages)) {
    throw httpError(400, 'maxPages must be a positive number');
  }
  // Optional product-URL filter regex (trimmed, capped — the engine ignores
  // invalid patterns with a warning finding, so no validation error here).
  const productUrlPattern =
    body.productUrlPattern != null && String(body.productUrlPattern).trim()
      ? String(body.productUrlPattern).trim().slice(0, 200)
      : null;
  // Optional region/locale token (trimmed, lowercased, capped) — filters
  // sitemap candidates to one country for multi-country GCC stores.
  const locale =
    body.locale != null && String(body.locale).trim()
      ? String(body.locale).trim().toLowerCase().slice(0, 10)
      : null;
  // Per-store User-Agent: only the 'browser' sentinel is accepted today (the
  // engine resolves it to a Chrome UA — for WAF stores that 403 ParityBot:
  // dawlance/prosportsae/athletix). Any other value is ignored → the default
  // ParityBot UA stays.
  const userAgent = body.userAgent === 'browser' ? 'browser' : null;
  // Job type: 'shallow' (sitemap-only check) or 'deep' (full crawl) — anything
  // that isn't explicitly shallow is a deep crawl (matches CrawlJob's default).
  const type = body.type === 'shallow' ? 'shallow' : 'deep';
  return {
    origin,
    type,
    collections: Array.isArray(body.collections)
      ? body.collections.filter((c) => typeof c === 'string')
      : [],
    delayMs: clamp(body.delayMs, 100, 10_000, 1000),
    maxConcurrencyPerHost: clamp(body.maxConcurrencyPerHost, 1, 12, 2),
    maxPages,
    respectRobotsTxt: body.respectRobotsTxt !== false,
    productOnly: body.productOnly !== false,
    storeSnapshots: body.storeSnapshots !== false,
    // Auto-detect JS rendering (default): renderer available, only content-
    // poor shell pages rendered per-page. Explicit false = http-only.
    useBrowser: body.useBrowser !== false,
    proxy: proxy.length > 0,
    proxyUrl: proxy || null,
    productUrlPattern,
    locale,
    userAgent,
    // A shallow check fetches ONLY new products — a partial catalogue must
    // never count as authoritative, or the ingest removal diff would wipe the
    // rest of the store (the worker's removal guard reads this flag).
    fullCrawl: type === 'deep'
  };
}

/**
 * Pre-crawl analysis (P2 Phase 2 — "analyze first, then crawl of that
 * type"): runs the Website Intelligence Analyzer's five probes against the
 * store BEFORE a manual deep crawl is enqueued and folds the recommendation
 * into the job's captured params:
 *
 *   - csr-shell rendering → force `useBrowser: true` (pages are JS shells;
 *     prices only exist after a browser render). Recorded in `applied` so
 *     the UI shows the auto-configuration.
 *   - WAF-blocking without a proxy → attach a visible `warning` (the crawl
 *     still proceeds — the user explicitly started it — but the risk is
 *     surfaced instead of a silent 0-product run). Rate-limit blocks (HTTP
 *     429) additionally get the documented gentler config applied
 *     (concurrency → 1, delay ≥ 2s) — challenge blocks need a proxy, so
 *     they're warning-only.
 *
 * Shallow quick-checks and scheduled runs bypass this: the scheduler
 * enqueues directly and must stay cheap, and recurring runs shouldn't pay a
 * ~10s probe each time. Degrades to `null` on probe failure — the crawl
 * still starts with the user's params (never block a crawl on analysis).
 */
async function analyzeBeforeCrawl(params) {
  const startedAt = Date.now();
  try {
    const profile = await runAnalyzer(
      params.origin,
      params.proxyUrl ?? undefined,
      // Probe with the same UA the crawl will use — a WAF that 403s ParityBot
      // must not hide its real answers from the pre-crawl analysis.
      params.userAgent ?? undefined
    );
    const applied = [];
    let renderingForced = false;
    if (profile.rendering.verdict === 'csr-shell') {
      params.useBrowser = true;
      renderingForced = true;
      applied.push(
        'auto JS rendering ON — pages are client-rendered shells, prices need the browser'
      );
    }
    let warning = null;
    if (profile.protection.blocking && !params.proxy) {
      warning =
        `${profile.protection.evidence} — this store blocks automated requests from ` +
        'this machine. Add a Tier-2 residential proxy (or lower concurrency and ' +
        'raise the delay) for the crawl to stand a chance.';
      // Rate-limit blocks respond to gentler crawling — apply the documented
      // slowdown automatically (transparent via `applied`). Challenge blocks
      // (Cloudflare JS) can't be fixed by pacing; warning only.
      if (profile.protection.provider === 'rate-limited') {
        params.maxConcurrencyPerHost = Math.min(params.maxConcurrencyPerHost, 1);
        params.delayMs = Math.max(params.delayMs, 2000);
        applied.push(
          'rate-limited store — concurrency cut to 1 and delay raised to ≥2s'
        );
      }
    }
    // P4 store-health pass: flag the expensive dead ends BEFORE worker hours
    // burn — a no-products/corporate verdict means the crawl will likely end
    // at ~0 products (lifetimefitnessstore: 39k landing pages, nothing to
    // parse). Warning-only; the crawl still proceeds (the user asked for it).
    const health = profile.health;
    if (!warning && health?.verdict === 'no-products') {
      warning =
        'Analysis flags this store as having NO parseable product data — ' +
        'expect ~0 products. It serves pages, but no Product schema/API/' +
        'product sitemap was found.';
    }
    if (!warning && health?.verdict === 'corporate') {
      const hosts = (profile.homepage?.externalStoreLinks ?? [])
        .map((l) => l.host)
        .join(', ');
      warning = hosts
        ? `Analysis flags this as a corporate site — prices likely live on ${hosts}. Crawling this domain will probably find no products.`
        : 'Analysis flags this as a corporate site — expect ~0 products here.';
    }
    // Persist the health verdict for the Sources profile + /crawls list.
    await persistStoreHealth(params.origin, health);
    return {
      tier: profile.recommendation.tier,
      platform: profile.platform.name,
      rendering: profile.rendering.verdict,
      renderingForced,
      protection: profile.protection.blocking
        ? profile.protection.evidence
        : null,
      sitemap: profile.sitemap.found ? profile.sitemap.urls : null,
      durationMs: Date.now() - startedAt,
      requests: profile.requests,
      applied,
      warning,
      // P4 store-health: the verdict rides on the snapshot so the progress
      // panel can render the flag next to the tier badge.
      healthVerdict: health?.verdict ?? null
    };
  } catch (error) {
    console.error(`Pre-crawl analysis failed for ${params.origin}:`, error);
    return null;
  }
}

/** POST /api/crawl-jobs — enqueue a one-off crawl (deep by default, or a
 *  shallow sitemap-only check when `type: 'shallow'`), return its id.
 *
 *  Manual DEEP crawls are analyze-first: the store is probed before the job
 *  is created so it starts with the recommended strategy (see
 *  `analyzeBeforeCrawl`). `analyze: false` in the body opts out — instant
 *  re-crawls of already-known stores skip the ~5–15s probe. The analysis
 *  snapshot rides on the job + response so the UI can show "Analyzed:
 *  <platform> · <tier>" immediately.
 */
const enqueueCrawlJob = async (req, res) => {
  try {
    const params = normalizeCrawlInput(req.body);
    const shouldAnalyze =
      params.type === 'deep' && req.body?.analyze !== false;
    const analysis = shouldAnalyze ? await analyzeBeforeCrawl(params) : null;
    const job = await enqueueJob({
      origin: params.origin,
      type: params.type,
      params,
      analysis
    });
    res.status(201).json({
      success: true,
      data: { jobId: String(job._id), analysis }
    });
  } catch (error) {
    const status = error.status ?? 500;
    console.error('Enqueue crawl job error:', error);
    res.status(status).json({ success: false, message: error.message });
  }
};

/** GET /api/crawl-jobs/:id — UI-shaped progress/result (null for unknown). */
const getCrawlJob = async (req, res) => {
  try {
    const { id } = req.params;
    const valid = mongoose.Types.ObjectId.isValid(id);
    const job = valid ? await mongoose.model('CrawlJob').findById(id).lean() : null;
    res.json({ success: true, data: publicJob(job) });
  } catch (error) {
    console.error('Get crawl job error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Maps a Store doc to the frontend's CrawlSchedule shape (ms timestamps,
 * proxy boolean only). `running` reflects a live deep job for the origin.
 */
function publicSchedule(store) {
  const sched = store.scheduledCrawl ?? {};
  const p = sched.params ?? {};
  const freqMs = FREQUENCY_MS[sched.frequency] ?? null;
  const lastRunAt = store.lastCrawl?.at ? new Date(store.lastCrawl.at).getTime() : null;
  const now = Date.now();
  return {
    origin: store.origin,
    collections: sched.collections ?? [],
    frequency: sched.frequency,
    params: {
      delayMs: p.delayMs ?? 1000,
      maxConcurrencyPerHost: p.maxConcurrencyPerHost ?? 2,
      maxPages: p.maxPages ?? null,
      respectRobotsTxt: p.respectRobotsTxt !== false,
      productOnly: p.productOnly !== false,
      storeSnapshots: p.storeSnapshots !== false,
      useBrowser: !!p.useBrowser,
      proxy: !!p.proxy,
      productUrlPattern: p.productUrlPattern ?? null,
      locale: p.locale ?? null,
      userAgent: p.userAgent ?? null
    },
    lastRunAt,
    nextRunAt: freqMs ? (lastRunAt ?? now) + freqMs : null,
    running: false
  };
}

/** POST /api/crawl-jobs/schedules — register/replace a recurring crawl. */
const upsertSchedule = async (req, res) => {
  try {
    const origin = String(req.body?.origin ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(origin)) {
      throw httpError(400, 'Origin must be a valid http(s) URL');
    }
    const frequency = req.body?.frequency;
    if (!FREQUENCY_MS[frequency]) {
      throw httpError(400, `Unsupported frequency: ${String(frequency)}`);
    }
    const proxy = req.body?.proxy != null ? String(req.body.proxy).trim() : '';
    if (proxy && !/^https?:\/\/\S+/i.test(proxy)) {
      throw httpError(400, 'Proxy must be a valid http(s) URL');
    }
    const maxPages =
      req.body?.maxPages == null || req.body?.maxPages === ''
        ? null
        : Math.max(1, Math.round(Number(req.body.maxPages)));
    const { normalizeHost } = require('../utils/identity');
    const store = await Store.findOneAndUpdate(
      { origin },
      {
        // cadence.enabled flips scheduling on; the shallow/deep hours stay at
        // their schema defaults and are DERIVED from `scheduledCrawl.frequency`
        // by the scheduler (deep floored at 6h — the schema's min).
        $set: {
          key: normalizeHost(origin),
          'cadence.enabled': true,
          scheduledCrawl: {
            frequency,
            collections: Array.isArray(req.body.collections)
              ? req.body.collections.filter((c) => typeof c === 'string')
              : [],
            params: {
              delayMs: clamp(req.body.delayMs, 100, 10_000, 1000),
              maxConcurrencyPerHost: clamp(req.body.maxConcurrencyPerHost, 1, 12, 2),
              maxPages,
              respectRobotsTxt: req.body.respectRobotsTxt !== false,
              productOnly: req.body.productOnly !== false,
              storeSnapshots: req.body.storeSnapshots !== false,
              // Auto-detect JS rendering (default) — see normalizeCrawlInput.
              useBrowser: req.body.useBrowser !== false,
              proxy: proxy.length > 0,
              proxyUrl: proxy || null,
              productUrlPattern:
                req.body.productUrlPattern != null &&
                String(req.body.productUrlPattern).trim()
                  ? String(req.body.productUrlPattern).trim().slice(0, 200)
                  : null,
              locale:
                req.body.locale != null && String(req.body.locale).trim()
                  ? String(req.body.locale).trim().toLowerCase().slice(0, 10)
                  : null,
              userAgent: req.body.userAgent === 'browser' ? 'browser' : null
            }
          }
        },
        $setOnInsert: { origin, name: '' }
      },
      { upsert: true, new: true, runValidators: true }
    );
    const running = await hasActiveJob({
      origin,
      type: 'deep',
      withinMs: FREQUENCY_MS[frequency]
    });
    res.json({ success: true, data: { ...publicSchedule(store.toObject()), running: !!running } });
  } catch (error) {
    const status = error.status ?? 500;
    console.error('Upsert schedule error:', error);
    res.status(status).json({ success: false, message: error.message });
  }
};

/** GET /api/crawl-jobs/schedules — list active recurring crawls. */
const listSchedules = async (req, res) => {
  try {
    const stores = await Store.find({ 'cadence.enabled': true })
      .sort({ updatedAt: -1 })
      .lean();
    const out = [];
    for (const store of stores) {
      const freqMs = FREQUENCY_MS[store.scheduledCrawl?.frequency] ?? HOUR_MS;
      const running = await hasActiveJob({
        origin: store.origin,
        type: 'deep',
        withinMs: freqMs
      });
      out.push({ ...publicSchedule(store), running: !!running });
    }
    res.json({ success: true, data: out });
  } catch (error) {
    console.error('List schedules error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * GET /api/crawl-jobs/active — background-crawler list: in-flight jobs
 * (queued/claimed/retrying) plus the last 15 min of finished ones.
 */
const listActive = async (req, res) => {
  try {
    const data = await listActiveJobs();
    res.json({ success: true, data });
  } catch (error) {
    console.error('List active jobs error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** Resolves a job id, throwing a 404 for malformed/unknown ids. */
function requireJobId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(404, 'Job not found');
  }
  return id;
}

/** POST /api/crawl-jobs/:id/pause — cooperative pause (worker waits). */
const pauseJob = async (req, res) => {
  try {
    const id = requireJobId(req.params.id);
    const job = await setJobControl(id, 'pause');
    if (!job) throw httpError(404, 'Job not found');
    res.json({ success: true, data: { id, control: 'pause' } });
  } catch (error) {
    const status = error.status ?? 500;
    console.error('Pause crawl job error:', error);
    res.status(status).json({ success: false, message: error.message });
  }
};

/** POST /api/crawl-jobs/:id/resume — clears a pause request. */
const resumeJob = async (req, res) => {
  try {
    const id = requireJobId(req.params.id);
    const job = await setJobControl(id, null);
    if (!job) throw httpError(404, 'Job not found');
    res.json({ success: true, data: { id, control: null } });
  } catch (error) {
    const status = error.status ?? 500;
    console.error('Resume crawl job error:', error);
    res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crawl-jobs/:id/cancel — queued jobs cancel immediately; claimed
 * jobs get a control request the worker turns into a clean cancellation
 * (no partial result is persisted).
 */
const cancelJob = async (req, res) => {
  try {
    const id = requireJobId(req.params.id);
    const job = await setJobControl(id, 'cancel');
    if (!job) throw httpError(404, 'Job not found');
    res.json({ success: true, data: { id, control: 'cancel' } });
  } catch (error) {
    const status = error.status ?? 500;
    console.error('Cancel crawl job error:', error);
    res.status(status).json({ success: false, message: error.message });
  }
};

/** DELETE /api/crawl-jobs/schedules/:origin — cancel a recurring crawl. */
const cancelSchedule = async (req, res) => {
  try {
    const origin = String(req.params.origin ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(origin)) {
      throw httpError(400, 'Origin must be a valid http(s) URL');
    }
    await Store.updateOne({ origin }, { $set: { 'cadence.enabled': false } });
    res.json({ success: true, data: { cancelled: true, origin } });
  } catch (error) {
    const status = error.status ?? 500;
    console.error('Cancel schedule error:', error);
    res.status(status).json({ success: false, message: error.message });
  }
};

module.exports = {
  enqueueCrawlJob,
  getCrawlJob,
  listActive,
  pauseJob,
  resumeJob,
  cancelJob,
  upsertSchedule,
  listSchedules,
  cancelSchedule
};
