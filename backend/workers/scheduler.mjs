/**
 * Scheduler — standalone process (architecture §3.3, decision D4).
 *
 * Reads each Store's cadence + last-run times from Mongo and enqueues
 * shallow/deep CrawlJobs with jitter and a per-store min-interval guard.
 * Crash-safe by construction: if the scheduler is down, missed ticks merely
 * delay the next enqueue — nothing is lost, and the `hasActiveJob` guard
 * means even two racing scheduler instances cannot double-fire.
 *
 * Cadence mapping:
 *   - shallowHours === deepHours (UI schedules today) → deep jobs only, at
 *     that interval (a UI "recurring crawl" is a full crawl, as before).
 *   - shallowHours < deepHours → sitemap-only shallow checks at the cheap
 *     cadence and deep price crawls at the slow one; a store that has never
 *     been deep-crawled starts with a deep crawl (the full base).
 *   - Stores with cadence disabled are skipped entirely.
 *
 * Run: `npm run scheduler` (from backend/), `--once` for a single pass, or
 * let `index.js` spawn it in dev.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database.js');
const Store = require('../models/Store.js');
const { enqueueJob, hasActiveJob, sleep } = require('../services/jobQueue.js');

const HOUR_MS = 60 * 60 * 1000;
const TICK_MS = Number(process.env.PARITY_SCHEDULER_TICK_MS ?? 60_000);
const once = process.argv.includes('--once');

/** UI frequency → hours (deep crawls floor at 6h — cadenceSchema min). */
const FREQUENCY_HOURS = { '1h': 1, '6h': 6, daily: 24, weekly: 168 };

/** Jitter so 100 stores never fire on the same second (≤15% of interval). */
function jitterMs(intervalMs) {
  return Math.floor(Math.random() * Math.min(intervalMs * 0.15, 15 * 60_000));
}

/** Builds the job-params snapshot from a store's saved schedule config. */
function paramsFor(store, type) {
  const sched = store.scheduledCrawl ?? {};
  const p = sched.params ?? {};
  return {
    collections: sched.collections ?? [],
    delayMs: p.delayMs ?? 1000,
    maxConcurrencyPerHost: p.maxConcurrencyPerHost ?? 2,
    maxPages: p.maxPages ?? null,
    respectRobotsTxt: p.respectRobotsTxt !== false,
    productOnly: p.productOnly !== false,
    storeSnapshots: p.storeSnapshots !== false,
    useBrowser: !!p.useBrowser,
    proxy: !!p.proxy,
    // Worker-only: the gateway URL never leaves the server (scrubbed by
    // publicJob on every read).
    proxyUrl: p.proxyUrl ?? null,
    fullCrawl: type === 'deep'
  };
}

async function tick() {
  const stores = await Store.find({ 'cadence.enabled': true }).lean();
  let enqueued = 0;
  for (const store of stores) {
    const cadence = store.cadence ?? {};
    // UI schedules store the frequency; the cadence hours derive from it
    // (shallow at the frequency, deep floored at 6h — a 1h schedule does
    // hourly shallow checks + 6-hourly price crawls). Stores configured
    // directly with cadence hours (no frequency) use those values.
    const freqHours = FREQUENCY_HOURS[store.scheduledCrawl?.frequency];
    const shallowHours = freqHours ?? cadence.shallowHours ?? 24;
    const deepHours = freqHours ? Math.max(6, freqHours) : cadence.deepHours ?? 168;
    const minIntervalMs = cadence.minIntervalMs ?? HOUR_MS;
    const now = Date.now();
    // Per-type anchors (written by the worker at ingest). Fall back to the
    // legacy single lastCrawl for docs created before the split.
    const lastDeep =
      store.lastDeepAt != null
        ? new Date(store.lastDeepAt).getTime()
        : store.lastCrawl?.type === 'deep'
          ? new Date(store.lastCrawl.at).getTime()
          : null;
    const lastShallow =
      store.lastShallowAt != null
        ? new Date(store.lastShallowAt).getTime()
        : store.lastCrawl?.type === 'shallow'
          ? new Date(store.lastCrawl.at).getTime()
          : null;
    const deepDue = lastDeep == null || now - lastDeep >= deepHours * HOUR_MS;

    // Never crawled → enqueue the deep crawl first (the full base), then the
    // shallow cadence keeps the catalogue fresh between deep runs.
    if (lastDeep != null && shallowHours < deepHours) {
      const shallowDue =
        lastShallow == null || now - lastShallow >= shallowHours * HOUR_MS;
      if (
        shallowDue &&
        !(await hasActiveJob({
          origin: store.origin,
          type: 'shallow',
          withinMs: minIntervalMs
        }))
      ) {
        await enqueueJob({
          origin: store.origin,
          type: 'shallow',
          params: paramsFor(store, 'shallow'),
          scheduledAt: new Date(now + jitterMs(shallowHours * HOUR_MS))
        });
        enqueued++;
      }
    }

    if (
      deepDue &&
      !(await hasActiveJob({
        origin: store.origin,
        type: 'deep',
        withinMs: minIntervalMs
      }))
    ) {
      await enqueueJob({
        origin: store.origin,
        type: 'deep',
        params: paramsFor(store, 'deep'),
        scheduledAt: new Date(now + jitterMs(deepHours * HOUR_MS))
      });
      enqueued++;
    }
  }
  if (enqueued > 0) {
    console.log(`⏰ scheduler tick: enqueued ${enqueued} job(s)`);
  }
  return enqueued;
}

async function main() {
  await connectDatabase();
  console.log('⏰ scheduler online — watching Store cadence');

  if (once) {
    const n = await tick();
    console.log(`scheduler --once: enqueued ${n} job(s)`);
    await mongoose.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    console.log('⏰ scheduler shutting down');
    mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('⏰ scheduler shutting down');
    mongoose.disconnect().catch(() => {});
    process.exit(0);
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick();
    } catch (error) {
      console.error(`scheduler tick failed: ${error.message}`);
    }
    await sleep(TICK_MS);
  }
}

main();
