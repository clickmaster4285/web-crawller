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

const require = createRequire(import.meta.url);
require('dotenv').config();

const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database.js');
const {
  claimNextJob,
  heartbeat,
  completeJob,
  failJob,
  sleep
} = require('../services/jobQueue.js');
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

// The crawler engine lives in the frontend package. Node 24 strips types on
// import, so we load it directly — `PARITY_CRAWLER_MODULE` overrides it for
// tests (must be a path relative to this file or a file:// URL).
//
// Path note: `new URL(path, import.meta.url)` resolves against THIS file
// (backend/workers/), so the sibling frontend package is TWO levels up — a
// single `../` would land in backend/frontend/ and crash every worker boot
// with ERR_MODULE_NOT_FOUND.
const crawlerModule =
  process.env.PARITY_CRAWLER_MODULE ?? '../../frontend/src/lib/crawler/index.ts';
const crawlerUrl = new URL(crawlerModule, import.meta.url);
const { runCrawl } = await import(crawlerUrl.href);

const workerId =
  process.env.PARITY_WORKER_ID ??
  `worker-${process.pid}-${Date.now().toString(36)}`;
const HEARTBEAT_MS = Number(process.env.PARITY_HEARTBEAT_MS ?? 2000);
const IDLE_WAIT_MS = Number(process.env.PARITY_WORKER_IDLE_MS ?? 2000);

let shuttingDown = false;

function shutdown() {
  shuttingDown = true;
}

/**
 * Sanitizes a crawler result into the persisted shape (the same mapping the
 * old in-SSR `runJob` used): identity fields survive the crawl → Mongo
 * boundary, failures stay capped, the full catalogue is kept.
 */
function sanitizeResult(result) {
  return {
    stats: {
      discovered: result.stats.discovered,
      fetched: result.stats.fetched,
      skippedUnchanged: result.stats.skippedUnchanged,
      failed: result.stats.failed,
      durationMs: result.stats.durationMs
    },
    failures: result.stats.failures.slice(0, 100),
    products: result.products.map((p) => ({
      name: p.name,
      brand: p.brand,
      price: p.price,
      available: p.available,
      url: p.url,
      sku: p.variants?.[0]?.sku ?? '',
      gtin: p.variants?.[0]?.barcode ?? ''
    })),
    discovery: result.discovery
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
  const beat = (patch) => {
    const now = Date.now();
    if (now - lastBeat < HEARTBEAT_MS) return;
    lastBeat = now;
    heartbeat(jobId, workerId, patch).catch(() => {});
  };
  // Liveness beat even when there's nothing to report (discovery in progress).
  const beatTimer = setInterval(
    () => heartbeat(jobId, workerId).catch(() => {}),
    HEARTBEAT_MS
  );

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
    }

    console.log(`🕷️  ${workerId} crawling ${origin} (${type})`);
    const result = await runCrawl({
      origin,
      collections: p.collections ?? [],
      mode: isShallow ? 'shallow' : 'deep',
      knownUrls,
      resumeState,
      delayMs: p.delayMs,
      maxConcurrencyPerHost: p.maxConcurrencyPerHost,
      maxPages: p.maxPages ?? undefined,
      respectRobotsTxt: p.respectRobotsTxt !== false,
      productOnly: p.productOnly !== false,
      useBrowser: !!p.useBrowser,
      proxy: p.proxyUrl ?? undefined,
      maxRetries: 1,
      onProgress: (processed, total) => {
        const patch = { processed, total };
        // First tick with a known URL count marks the end of discovery —
        // the UI computes its ETA from fetch-phase throughput alone.
        if (fetchStartedAt === null && total > 0) {
          fetchStartedAt = new Date();
          patch.fetchStartedAt = fetchStartedAt;
        }
        beat(patch);
      },
      onDiscoveryProgress: (discovery) => beat({ discovery })
    });

    const sanitized = sanitizeResult(result);
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
    await completeJob(jobId, workerId, {
      result: sanitized,
      persisted: true,
      progress: {
        processed: result.products.length,
        total: result.stats.discovered,
        fetchStartedAt
      }
    });
    console.log(
      `✅ ${workerId} finished ${origin}: ${result.products.length} products` +
        ` (${result.stats.fetched} fetched, ${result.stats.skippedUnchanged} cached, ` +
        `${result.stats.failed} failed) in ${result.stats.durationMs}ms`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(jobId, workerId, message);
  } finally {
    clearInterval(beatTimer);
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
  }

  console.log(`👋 ${workerId} shutting down`);
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

main();
