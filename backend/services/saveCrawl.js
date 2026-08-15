/**
 * saveCrawl — the shared post-crawl persistence pipeline (Phase 2, D1
 * endgame).
 *
 * Called by the standalone crawl worker (which saves directly, no HTTP
 * round-trip — the old `POST /api/data/crawl-results` entry point was
 * removed):
 *
 *   1. Normalized model via `syncNewModel` (Product / Snapshot / ProductEvent)
 *   2. `Store` upsert (platform profile + lastCrawl + productCount) — the
 *      scheduler's input (decision D4)
 *   3. Phase 3: persisted `ProductMatch` reconciliation
 *
 * The legacy `CrawlResult` dual-write was REMOVED (Aug 2026, D1): every read
 * path now serves the normalized collections, and the legacy model/controller
 * were deleted — only the frozen `crawlresults` collection's data remains
 * (teardown code, keep data). A dual-write failure is surfaced, never fatal
 * to the crawl.
 */
const Store = require('../models/Store');
const { syncNewModel } = require('./crawlSync');
const { reconcileForOrigin } = require('./matchService');
const { normalizeHost } = require('../utils/identity');

/**
 * Saves a finished crawl through the normalized pipeline.
 * @param {object} params
 * @param {string} params.origin
 * @param {string[]} [params.collections]
 * @param {object} [params.stats]
 * @param {Array} [params.products]
 * @param {Array} [params.failures]
 * @param {object|null} [params.discovery]
 * @param {boolean} [params.storeSnapshots] Legacy replace vs history mode
 *        (accepted for compatibility; the normalized model always appends
 *        history capped at 10 per origin).
 * @param {boolean} [params.fullCrawl] True when products are the full catalogue.
 * @param {'shallow'|'deep'} [params.type] Job type (recorded on Store.lastCrawl).
 * @param {Map} [params.httpStateByUrl] Phase B resume state captured by the
 *        engine (URL → {etag, lastmod}); persisted onto Product.httpState so
 *        the next worker (any machine) can skip unchanged products.
 * @returns {Promise<{doc: null, dualWrite: object, store: object|null}>
 *           matching: object}>}
 */
async function saveFinishedCrawl({
  origin,
  collections,
  stats,
  products,
  failures,
  discovery,
  fullCrawl,
  type = 'deep',
  httpStateByUrl
}) {
  const payload = {
    origin,
    collections: Array.isArray(collections) ? collections : [],
    stats: stats || {},
    products: Array.isArray(products) ? products : [],
    failures: Array.isArray(failures) ? failures : [],
    discovery: discovery || null
  };

  // 1. Normalized dual-write — surfaced, never fatal.
  let dualWrite;
  try {
    dualWrite = await syncNewModel({
      origin,
      products: payload.products,
      stats: payload.stats,
      discovery: payload.discovery,
      failures: payload.failures,
      fullCrawl,
      httpStateByUrl
    });
  } catch (error) {
    console.error(`⚠️ Dual-write to Product/Snapshot/Event failed for ${origin}:`, error);
    dualWrite = { ok: false, error: error.message };
  }

  // 3. Store profile upsert — the scheduler's input. Best-effort: a failure
  //    here must not fail the crawl save (the store is re-upserted next run).
  //    The per-type anchor (`lastShallowAt`/`lastDeepAt`) keeps the
  //    scheduler's two cadences independent.
  let store = null;
  try {
    const key = normalizeHost(origin);
    // productCount mirrors the catalogue — only a run that parsed a genuine
    // catalogue may update it. Zero-product runs (WAF-blocked or brand-page-
    // only crawls, which the ingest removal guard treats as "we didn't really
    // see the store") and capped runs (partial by definition — maxPages cut
    // the catalogue short) must NOT overwrite the last known count: Aug 2026,
    // a 400-brand-page capped run zeroed activefitnessstore.com's store card
    // to 0 while 10,462 products sat untouched in the catalogue.
    const catalogueCount =
      payload.products.length > 0 && !payload.stats?.capped
        ? payload.products.length
        : undefined;
    const set = {
      key,
      platform: payload.discovery?.platform ?? null,
      lastCrawl: {
        at: new Date(),
        type,
        status: 'done',
        durationMs: payload.stats.durationMs ?? 0,
        productCount: payload.products.length
      },
      ...(catalogueCount != null ? { productCount: catalogueCount } : {})
    };
    if (type === 'shallow') set.lastShallowAt = new Date();
    else set.lastDeepAt = new Date();
    store = await Store.findOneAndUpdate(
      { origin },
      { $set: set, $setOnInsert: { origin, name: '' } },
      { upsert: true, new: true, runValidators: true }
    );
  } catch (error) {
    console.error(`⚠️ Store upsert failed for ${origin}:`, error);
  }

  // 4. Phase 3: persist ProductMatch rows for everything this crawl affected
  //    (my-store crawl → re-match vs every competitor; competitor crawl →
  //    re-match vs the my-store). Best-effort — never fatal to the crawl.
  //
  //    Re-matching is SKIPPED when this crawl changed nothing on the origin
  //    (added/removed/price/stock/rename all zero — e.g. a shallow quick-check
  //    that found no new products). Re-running it would re-load both
  //    catalogues and full-replace every ProductMatch row for zero benefit:
  //    prices are read live from Product at read time, so untouched rows stay
  //    correct. A failed dual-write falls back to reconciling — never skip on
  //    unknown state.
  let matching;
  const changed =
    !dualWrite?.ok ||
    (dualWrite?.addedCount ?? 0) +
      (dualWrite?.removedCount ?? 0) +
      (dualWrite?.priceChangedCount ?? 0) +
      (dualWrite?.stockChangedCount ?? 0) +
      (dualWrite?.renamedCount ?? 0) >
      0;
  if (changed) {
    try {
      matching = await reconcileForOrigin(origin);
    } catch (error) {
      console.error(`⚠️ Match reconcile failed for ${origin}:`, error);
      matching = { ok: false, error: error.message };
    }
  } else {
    matching = { ok: true, skipped: true, reason: 'no-changes' };
  }

  // The legacy CrawlResult doc is gone (D1 teardown) — `doc` is kept as null
  // for callers that historically read it.
  return { doc: null, dualWrite, store, matching };
}

module.exports = { saveFinishedCrawl };
