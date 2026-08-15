/**
 * Worker — standalone crawl process (architecture §3.3, Phase 2, decision D4).
 *
 * Loop: atomically claim the next due CrawlJob → run the existing crawler
 * engine → save through the shared post-crawl pipeline → complete/fail.
 * Heartbeats every ~2s so a crashed worker's job is released and requeued;
 * failures retry with exponential backoff until attempts are exhausted.
 *
 * Packaging: this is an `.mjs` ESM file. Backend modules are CommonJS and
 * load via `createRequire`; the crawler is frontend TypeScript and loads via
 * Node 24's native type-stripping `import()` (the same trick `npm run crawl`
 * in the frontend uses). No build step, no bundler.
 *
 * Run: `npm run worker` (from backend/), or let `index.js` spawn it in dev.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('dotenv').config();

const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database.js');
const {
  claimNextJob,
  heartbeat,
  completeJob,
  failJob,
  cancelJob,
  enqueueJob,
  sleep
} = require('../services/jobQueue.js');
const CrawlJob = require('../models/CrawlJob.js');
const { saveFinishedCrawl } = require('../services/saveCrawl.js');
const Product = require('../models/Product.js');

/**
 * Phase B (architecture §3.1): loads the origin's durable resume state —
 * `Product.httpState` (etag/lastmod) + the stored product fields — into the
 * `resumeState` map the engine uses to skip unchanged products. Because the
 * state lives in Mongo, ANY worker (any machine) resumes where another
 * stopped: the SQLite checkpoint is no longer the cross-run state source.
 */
async function loadResumeState(origin) {
  const docs = await Product.find({ origin })
    .select(
      'url name brand category price compareAtPrice available image sku gtin slug httpState'
    )
    .lean();
  const resumeState = new Map();
  for (const d of docs) {
    if (!d.url) continue;
    const st = d.httpState ?? {};
    const variant = {
      id: 0,
      title: 'Default',
      sku: d.sku ?? '',
      price: typeof d.price === 'number' ? d.price : 0,
      compareAtPrice: d.compareAtPrice ?? null,
      available: d.available !== false,
      inventoryQuantity: d.available !== false ? 1 : 0,
      barcode: d.gtin ?? ''
    };
    const now = new Date().toISOString();
    resumeState.set(d.url, {
      etag: st.etag ?? null,
      lastmod: typeof st.lastmod === 'number' ? st.lastmod : null,
      product: {
        id: 0,
        handle: d.slug ?? d.url.split('/').filter(Boolean).pop() ?? '',
        url: d.url,
        name: d.name ?? '',
        brand: d.brand ?? '',
        category: d.category ?? '',
        description: '',
        tags: [],
        image: d.image ?? null,
        price: typeof d.price === 'number' ? d.price : 0,
        compareAtPrice: d.compareAtPrice ?? null,
        available: d.available !== false,
        variants: [variant],
        createdAt: now,
        updatedAt: now,
        crawledAt: now
      }
    });
  }
  return resumeState;
}

// The crawler engine lives in the backend package (P6 — moved from
// crawler on Aug 10 so the server-side-only engine, its deps
// and its typecheck live where it runs; see improvement-plan.md P6). Node 24
// strips types on import, so
// we load it directly — `PARITY_CRAWLER_MODULE` overrides it for tests (must
// be a path relative to this file or a file:// URL). The `.ts` files are ESM
// syntax; Node 24's module-syntax detection loads them as ESM even under
// backend's CommonJS package (a benign MODULE_TYPELESS_PACKAGE_JSON warning
// is logged once per process — the nested type:module package.json that would
// silence it is intentionally omitted: everything-in-backend, no nested pkg).
const crawlerModule =
  process.env.PARITY_CRAWLER_MODULE ?? '../crawler/index.ts';
const crawlerUrl = new URL(crawlerModule, import.meta.url);
const { runCrawl, isCrawlCancelled, sanitizeProxyFromMessage } = await import(
  crawlerUrl.href
);

// P4 worker code versioning: stamp the DEPLOYED engine version on every job
// (fixes have bit us twice by not reaching already-running workers — this
// makes a stale worker visible instead of a mystery). Best-effort: backend
// package version + git short SHA read at boot; 'dev' when git isn't
// available. Restarting the backend IS the deploy step — this value is what
// that restart actually shipped.
const ENGINE_VERSION = (() => {
  try {
    const { execSync } = require('node:child_process');
    const pkg = require('../package.json');
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
      encoding: 'utf8',
    }).trim();
    return `${pkg.version}+${sha}`;
  } catch {
    return 'dev';
  }
})();

const workerId =
  process.env.PARITY_WORKER_ID ??
  `worker-${process.pid}-${Date.now().toString(36)}`;
const HEARTBEAT_MS = Number(process.env.PARITY_HEARTBEAT_MS ?? 2000);
const IDLE_WAIT_MS = Number(process.env.PARITY_WORKER_IDLE_MS ?? 2000);
// How often the worker re-reads the job's `control` field so a pause/cancel
// from the API lands within ~1.5s of being requested (the engine itself
// checks between URLs — this poll bridges the API → engine gap).
const CONTROL_POLL_MS = Number(process.env.PARITY_CONTROL_POLL_MS ?? 1500);

let shuttingDown = false;

function shutdown() {
  shuttingDown = true;
}

/**
 * Forces a full GC so V8 returns freed heap to the OS. Works because the
 * worker is spawned with `--expose-gc` (see spawn.js / the npm script);
 * without the flag this is a harmless no-op (manual `node worker.mjs` runs
 * without the flag still work). Called between jobs and periodically mid-
 * crawl: a long deep crawl otherwise leaves V8's heap at its multi-GB peak
 * forever — the machine grinds to a halt at ~97% RAM as workers + API +
 * Mongo fight for what's left.
 */
function gcNow() {
  try {
    global.gc?.();
  } catch {
    // --expose-gc missing — nothing to do.
  }
}

/**
 * Sanitizes a crawler result into the persisted shape (the same mapping the
 * old in-SSR `runJob` used): identity fields survive the crawl → Mongo
 * boundary, failures stay capped, the full catalogue is kept.
 */
function sanitizeResult(result, proxyUrl) {
  // Defense-in-depth (Tier 2): the gateway URL — especially its embedded
  // credentials — must NEVER land in persisted failure text or discovery
  // logs. The crawler's HTTP layer already redacts network-error messages,
  // but a failure string built elsewhere could still embed the URL; this
  // boundary net blanket-redacts everything that gets written to Mongo.
  const redact = proxyUrl
    ? (text) => sanitizeProxyFromMessage(text, proxyUrl)
    : (text) => text;
  const discovery = result.discovery;
  return {
    stats: {
      discovered: result.stats.discovered,
      fetched: result.stats.fetched,
      skippedUnchanged: result.stats.skippedUnchanged,
      failed: result.stats.failed,
      durationMs: result.stats.durationMs,
      requests: result.stats.requests ?? 0,
      // True when `maxPages` cut the run short of the full catalogue — the
      // ingest pipeline must never soft-delete the URLs beyond the cap.
      capped: result.stats.capped ?? false
    },
    failures: result.stats.failures.slice(0, 100).map((f) => ({
      ...f,
      error: redact(f.error)
    })),
    products: result.products.map((p) => ({
      name: p.name,
      brand: p.brand,
      price: p.price,
      // Real currency captured by the extractor (JSON-LD/OG/symbol guess),
      // when there was one — the ingest pipeline stops defaulting to USD.
      currency: p.priceCurrency ?? null,
      available: p.available,
      url: p.url,
      sku: p.variants?.[0]?.sku ?? '',
      gtin: p.variants?.[0]?.barcode ?? ''
    })),
    discovery: discovery
      ? {
          ...discovery,
          ...(Array.isArray(discovery.findings)
            ? {
                findings: discovery.findings.map((f) => ({
                  ...f,
                  message: redact(f.message)
                }))
              }
            : {}),
          ...(Array.isArray(discovery.log)
            ? { log: discovery.log.map((line) => redact(line)) }
            : {})
        }
      : discovery
  };
}

/**
 * Runs one claimed job end-to-end. Heartbeats are throttled (a 10k-product
 * crawl must not write Mongo once per URL); the UI polls at 800ms and just
 * sees slightly-lagged counters.
 */
async function processJob(job) {
  const jobId = String(job._id);
  const { origin, type } = job;
  const p = job.params ?? {};

  let lastBeat = 0;
  let fetchStartedAt = null;
  // Phase 5 run-log: lines since the last beat, flushed with it (the engine's
  // onLog emissions + this worker's own lifecycle lines). Kept in the job's
  // capped progress.log so a crawl's story survives the process.
  const logBuffer = [];
  const logLine = (level, message) => {
    logBuffer.push({ at: new Date(), level, message });
  };
  // `force` bypasses the 2s throttle — needed for one-shot writes like the
  // fetchStartedAt transition below: if the very first fetch-phase patch
  // landed within 2s of the last discovery tick, the throttled beat would
  // DROP it, and since fetchStartedAt is only ever set once per job, no
  // later beat would carry it — the Sources ETA would read "Estimating
  // time…" for the whole run (progress bars kept working, the boundary
  // didn't).
  const beat = (patch, force = false) => {
    const now = Date.now();
    if (!force && now - lastBeat < HEARTBEAT_MS) return;
    lastBeat = now;
    const withLog = { ...patch };
    if (logBuffer.length > 0) {
      withLog.log = logBuffer.splice(0, logBuffer.length);
    }
    heartbeat(jobId, workerId, withLog).catch(() => {});
  };
  // P4: stamp the deployed engine version on the job immediately (forced
  // beat so the very first throttled tick can't drop it) and open the run
  // log with it — the UI's first line says what code this crawl runs.
  logLine('info', `engine v${ENGINE_VERSION} — restarting the backend deploys this`);
  beat({ crawlerVersion: ENGINE_VERSION }, true);
  // Liveness beat even when there's nothing to report (discovery in progress
  // or the engine is paused and waiting). Buffered run-log lines ride along
  // (a crawl that logs between progress ticks still flushes its story).
  const beatTimer = setInterval(
    () => {
      if (logBuffer.length > 0) {
        beat({}, true);
      } else {
        heartbeat(jobId, workerId).catch(() => {});
      }
    },
    HEARTBEAT_MS
  );

  // Cooperative control bridge: poll the job's `control` field and mirror it
  // into the object the engine checks between URLs. The heartbeat timer keeps
  // the job alive while paused; a cancel here throws CrawlCancelledError from
  // the engine, and the catch below marks the job cancelled without persisting
  // a partial result.
  const controlRef = { action: null };
  const controlTimer = setInterval(async () => {
    try {
      const doc = await CrawlJob.findById(jobId).select('control').lean();
      controlRef.action = doc?.control ?? null;
    } catch {
      // Transient DB error — keep the last known control state.
    }
  }, CONTROL_POLL_MS);

  try {
    const isShallow = type === 'shallow';
    // Phase B: load the origin's durable resume state ONCE per job (one
    // indexed projection — at 10k products a few MB, fine). The engine skips
    // unchanged products from it, so ANY worker resumes where another
    // stopped. The known URL set for shallow checks is derived from the same
    // load (no second query).
    const resumeState = await loadResumeState(origin);
    const knownUrls = new Set(resumeState.keys());
    if (isShallow) {
      console.log(
        `🔎 ${workerId} shallow-checking ${origin}: ${knownUrls.size} products already known`
      );
      logLine(
        'info',
        `${workerId}: shallow check — ${knownUrls.size.toLocaleString()} products already known`
      );
    }

    console.log(`🕷️  ${workerId} crawling ${origin} (${type})`);
    logLine('info', `${workerId}: crawling ${origin} (${type})`);
    const result = await runCrawl({
      origin,
      collections: p.collections ?? [],
      mode: isShallow ? 'shallow' : 'deep',
      knownUrls,
      resumeState,
      control: controlRef,
      delayMs: p.delayMs,
      maxConcurrencyPerHost: p.maxConcurrencyPerHost,
      maxPages: p.maxPages ?? undefined,
      respectRobotsTxt: p.respectRobotsTxt !== false,
      productOnly: p.productOnly !== false,
      useBrowser: !!p.useBrowser,
      // Optional product-URL filter (only discovered URLs matching the regex
      // are crawled — blog/brand/category pages stay out of the catalogue).
      productUrlPattern: p.productUrlPattern ?? undefined,
      // Optional region/locale token — discovery keeps only sitemaps matching
      // this region (GCC stores: one sitemap set per country, ~4× less work).
      locale: p.locale ?? undefined,
      // Per-store User-Agent: 'browser' (sentinel) or a raw UA string — the
      // engine resolves 'browser' to a Chrome UA so WAF stores that 403 the
      // ParityBot UA (dawlance/prosportsae/athletix) can be crawled.
      userAgent: p.userAgent ?? undefined,
      proxy: p.proxyUrl ?? undefined,
      maxRetries: 1,
      onProgress: (processed, total) => {
        const patch = { processed, total };
        // First tick with a known URL count marks the end of discovery —
        // the UI computes its ETA from fetch-phase throughput alone. This
        // one-shot write is FORCED through the throttle (see beat above): a
        // discovery tick that landed <2s ago must not eat the boundary.
        const firstFetchTick = fetchStartedAt === null && total > 0;
        if (firstFetchTick) {
          fetchStartedAt = new Date();
          patch.fetchStartedAt = fetchStartedAt;
        }
        beat(patch, firstFetchTick);
        // Periodic full GC mid-crawl (every 1000 products): the engine
        // allocates large transient HTML/JSON per page and V8's heap only
        // grows to the peak — this actively brings RSS back down so a
        // 20-minute crawl can't freeze the machine.
        if (processed > 0 && processed % 1000 === 0) gcNow();
      },
      onDiscoveryProgress: (discovery) => beat({ discovery }),
      // Debug: surface the live HTTP-request count on the job (throttled by
      // beat, so a 10k-page crawl doesn't write Mongo per request).
      onRequestCount: (count) => beat({ requests: count }),
      // Structured run-log: engine lifecycle + HTTP warnings land on the
      // job's capped progress.log (flushed with the next heartbeat).
      onLog: (level, message) => logLine(level, message)
    });

    const sanitized = sanitizeResult(result, p.proxyUrl);

    // Auto browser-rendering (decision Aug 2026): a deep crawl that ran with
    // rendering OFF and fetched pages but extracted ZERO prices is a
    // client-rendered store — the HTML-only extractors can't see JS-loaded
    // prices (activefitnessstore.com, miraclefitnessuae.com). Instead of
    // leaving a silently 0-priced catalogue, re-run it once with rendering
    // ON. The follow-up itself runs with useBrowser:true, so the condition
    // below never fires twice (no loop).
    let autoBrowserFollowup = false;
    if (type === 'deep' && !p.useBrowser) {
      const fetched = sanitized.stats.fetched ?? 0;
      const priced = sanitized.products.filter(
        (x) => typeof x.price === 'number' && x.price > 0
      ).length;
      if (fetched >= 10 && priced === 0) {
        autoBrowserFollowup = true;
        sanitized.discovery.findings = [
          ...(sanitized.discovery?.findings ?? []),
          {
            level: 'info',
            message: `No prices extracted from ${fetched} fetched pages — this store looks JS-rendered. Auto-started a re-crawl with browser rendering ON.`
          }
        ];
      }
    }

    // Persist BEFORE flipping to done so the final poll sees persisted=true.
    await saveFinishedCrawl({
      origin,
      collections: p.collections ?? [],
      stats: sanitized.stats,
      products: sanitized.products,
      failures: sanitized.failures,
      discovery: sanitized.discovery,
      storeSnapshots: p.storeSnapshots !== false,
      // Shallow checks are partial catalogues — they must never soft-delete
      // the rest of the store (the ingest pipeline's removal guard).
      fullCrawl: p.fullCrawl ?? type === 'deep',
      type,
      // Phase B: persist the etag/lastmod captured this run so the NEXT
      // worker (any machine) skips unchanged products on resume.
      httpStateByUrl: result.httpStateByUrl
    });
    // Phase 5 run-log: final lifecycle line + any follow-up note, flushed
    // ATOMICALLY with the completion write below — the heartbeat timers are
    // torn down in `finally`, so this is the last chance to persist the
    // buffered story (a beat after completeJob would race the status flip).
    // P4: the failed count splits extraction-miss vs http (same as the
    // engine's finish line) so a 0-priced run reads honestly.
    const failedList = sanitized.stats.failures ?? [];
    const extractionMisses = failedList.filter(
      (f) => f.kind === 'extraction'
    ).length;
    const httpFailures = failedList.length - extractionMisses;
    logLine(
      'info',
      `${workerId}: finished ${origin} — ${result.products.length.toLocaleString()} products ` +
        `(${result.stats.fetched.toLocaleString()} fetched, ` +
        `${result.stats.skippedUnchanged.toLocaleString()} cached, ` +
        `${result.stats.failed} failed [${extractionMisses} extraction-miss · ${httpFailures} http]) ` +
        `in ${(result.stats.durationMs / 1000).toFixed(1)}s`
    );
    if (autoBrowserFollowup) {
      logLine(
        'warn',
        `0 prices from ${sanitized.stats.fetched} fetched pages — looks JS-rendered; auto re-crawling with browser rendering ON`
      );
    }
    await completeJob(jobId, workerId, {
      result: sanitized,
      persisted: true,
      progress: {
        processed: result.products.length,
        total: result.stats.discovered,
        requests: result.stats.requests ?? 0,
        fetchStartedAt
      },
      log: logBuffer.splice(0, logBuffer.length)
    });
    if (autoBrowserFollowup) {
      await enqueueJob({
        origin,
        type: 'deep',
        // Clone the run's params with rendering forced on — the follow-up
        // can't re-trigger the auto-render (useBrowser is true this time).
        params: { ...p, useBrowser: true, fullCrawl: true }
      });
      console.log(
        `🖥️ ${workerId} ${origin} looks JS-rendered (0 prices from ${sanitized.stats.fetched} pages) — auto re-crawling with browser rendering ON`
      );
    }
    console.log(
      `✅ ${workerId} finished ${origin}: ${result.products.length} products` +
        ` (${result.stats.fetched} fetched, ${result.stats.skippedUnchanged} cached, ` +
        `${result.stats.failed} failed) in ${result.stats.durationMs}ms`
    );
  } catch (error) {
    // A user-requested cancel is not a failure: nothing is persisted and the
    // job goes `cancelled` (the API's control request, mirrored into
    // controlRef, made the engine throw CrawlCancelledError).
    if (isCrawlCancelled(error)) {
      logLine('info', `${workerId}: cancelled crawl for ${origin}`);
      await cancelJob(
        jobId,
        workerId,
        logBuffer.splice(0, logBuffer.length)
      );
      console.log(`🗑️  ${workerId} cancelled crawl for ${origin}`);
      return;
    }
    // The shared redactor reproduces the old behavior exactly: it stringifies
    // non-Errors and is a pass-through when no proxy URL is configured — the
    // ternary chain is unnecessary.
    const message = sanitizeProxyFromMessage(error, p.proxyUrl);
    logLine('error', `${workerId}: crawl failed — ${message}`);
    await failJob(
      jobId,
      workerId,
      message,
      logBuffer.splice(0, logBuffer.length)
    );
  } finally {
    clearInterval(beatTimer);
    clearInterval(controlTimer);
  }
}

async function main() {
  await connectDatabase();
  console.log(`🧑‍🔧 ${workerId} online — claiming crawl jobs from Mongo`);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!shuttingDown) {
    let job = null;
    try {
      job = await claimNextJob({ workerId });
    } catch (error) {
      console.error(`[worker] claim failed: ${error.message}`);
      await sleep(3000);
      continue;
    }
    if (!job) {
      await sleep(IDLE_WAIT_MS);
      continue;
    }
    try {
      await processJob(job);
    } catch (error) {
      // processJob reports its own failures; this is a safety net so one bad
      // job can never wedge the claim loop.
      await failJob(String(job._id), workerId, error.message ?? String(error)).catch(
        () => {}
      );
    }
    // Job finished (or failed) — hand the heap back to the OS before the
    // next claim so memory can never ratchet up across consecutive jobs.
    gcNow();
  }

  console.log(`👋 ${workerId} shutting down`);
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

main();
