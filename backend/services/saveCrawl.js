/**
 * saveCrawl — the shared post-crawl persistence pipeline (Phase 2).
 *
 * Used by BOTH the Express controller (`saveCrawlResult`, HTTP back-compat)
 * and the standalone crawl worker (which saves directly, no HTTP round-trip):
 *
 *   1. Legacy `CrawlResult` doc (snapshot history, capped — D1 compat layer)
 *   2. Normalized model via `syncNewModel` (Product / Snapshot / ProductEvent)
 *   3. `Store` upsert (platform profile + lastCrawl + productCount) — the
 *      scheduler's input (decision D4)
 *
 * A dual-write failure is surfaced, never fatal to the crawl; the legacy doc
 * is saved before anything else can fail.
 */
const CrawlResult = require('../models/CrawlResult');
const Store = require('../models/Store');
const { syncNewModel } = require('./crawlSync');
const { reconcileForOrigin } = require('./matchService');
const { normalizeHost } = require('../utils/identity');

/** Legacy CrawlResult history cap (the normalized Snapshot caps at 10, D3). */
const SNAPSHOT_LIMIT = 20;

/**
 * Saves a finished crawl through all three layers.
 * @param {object} params
 * @param {string} params.origin
 * @param {string[]} [params.collections]
 * @param {object} [params.stats]
 * @param {Array} [params.products]
 * @param {Array} [params.failures]
 * @param {object|null} [params.discovery]
 * @param {boolean} [params.storeSnapshots] Legacy replace vs history mode.
 * @param {boolean} [params.fullCrawl] True when products are the full catalogue.
 * @param {'shallow'|'deep'} [params.type] Job type (recorded on Store.lastCrawl).
 * @param {Map} [params.httpStateByUrl] Phase B resume state captured by the
 *        engine (URL → {etag, lastmod}); persisted onto Product.httpState so
 *        the next worker (any machine) can skip unchanged products.
 * @returns {Promise<{doc: object, dualWrite: object, store: object|null}>}
 */
async function saveFinishedCrawl({
  origin,
  collections,
  stats,
  products,
  failures,
  discovery,
  storeSnapshots,
  fullCrawl,
  type = 'deep',
  httpStateByUrl
}) {
  const payload = {
    origin,
    // Recorded on the legacy snapshot too so the /crawls history can badge
    // which runs were sitemap-only checks (default 'deep' covers HTTP posts
    // and pre-field docs).
    type,
    collections: Array.isArray(collections) ? collections : [],
    stats: stats || {},
    products: Array.isArray(products) ? products : [],
    failures: Array.isArray(failures) ? failures : [],
    discovery: discovery || null
  };

  // 1. Legacy CrawlResult doc — the D1 compat layer (reads keep working).
  let doc;
  if (storeSnapshots === false) {
    // Replace mode — keep only the latest snapshot per origin. The metadata
    // check guards a rare race: without a unique index, two concurrent
    // replace-upserts for the same origin can both *insert*; running
    // deleteMany unconditionally would then let each delete the other's doc.
    const result = await CrawlResult.findOneAndUpdate(
      { origin },
      payload,
      { upsert: true, new: true, runValidators: true, includeResultMetadata: true }
    );
    doc = result.value;
    if (result.lastErrorObject?.updatedExisting) {
      await CrawlResult.deleteMany({ origin, _id: { $ne: doc._id } });
    }
  } else {
    // History mode — append a snapshot, then cap history per origin.
    doc = await CrawlResult.create(payload);
    const keep = await CrawlResult.find({ origin })
      .sort({ createdAt: -1 })
      .limit(SNAPSHOT_LIMIT)
      .select('_id');
    await CrawlResult.deleteMany({
      origin,
      _id: { $nin: keep.map((d) => d._id) }
    });
  }

  // 2. Normalized dual-write — surfaced, never fatal.
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
      productCount: payload.products.length
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
  let matching;
  try {
    matching = await reconcileForOrigin(origin);
  } catch (error) {
    console.error(`⚠️ Match reconcile failed for ${origin}:`, error);
    matching = { ok: false, error: error.message };
  }

  return { doc, dualWrite, store, matching };
}

module.exports = { saveFinishedCrawl, SNAPSHOT_LIMIT };
