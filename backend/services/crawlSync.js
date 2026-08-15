/**
 * crawlSync — the ingest pipeline (architecture §9.5 step 3, decision D1) —
 * mirrors a finished crawl into the normalized model:
 *
 *   - `Product`       — current state, one doc per (origin, identityKey),
 *                       bulk-upserted; soft-deleted products keep their old
 *                       `lastSeenAt` so they drop out of live views.
 *   - `ProductEvent`  — added / removed / price_changed / stock_changed rows,
 *                       computed once at ingest via an identity-set diff.
 *   - `Snapshot`      — metadata + counts + capped key lists; history capped
 *                       at `SNAPSHOT_LIMIT` per origin (decision D3).
 */
const Product = require('../models/Product');
const Snapshot = require('../models/Snapshot');
const ProductEvent = require('../models/ProductEvent');
const { getRates, toUsd } = require('./fxService');
const { productIdentityKey, normalizeHost } = require('../utils/identity');
const {
  normalizeGtin,
  normalizeSku,
  slugFromUrl,
  nameTokens,
  nameTrigrams
} = require('../utils/matcher');

// The non-product URL classifier — SINGLE source of truth, shared with the
// crawler (backend/crawler/discover/junk-segments.ts — P6 moved the crawler
// into the backend package) and the
// tools/ ops scripts (junk purge/check). Node 24 strips TS types on import,
// so a CJS file
// loads it the same way worker.mjs loads the crawler engine. Cached so each
// process resolves it once (the worker + API already import the crawler this
// way). The ingest-side guard is a second net: the crawler's discovery filter
// strips these at the URL level, but pages that arrive another way (HTML
// link-graph BFS, productOnly off, legacy flows) must not be written as
// Products. A policy page that extracted a title-as-name would otherwise sit
// in the catalogue with price 0 forever (the Aug 2026 urbanfitnesscart.com
// pollution: /uae-en/blog/*, /uae-en/privacy-policy…). Matched at ANY path
// depth so locale prefixes (/uae-en/, /om/) can't hide it.
let junkFilterPromise = null;
function getJunkFilter() {
  junkFilterPromise ??= import(      '../crawler/discover/junk-segments.ts'
  ).then((m) => m);
  return junkFilterPromise;
}

/** True when any path segment of `url` is an unambiguous non-product segment. */
async function hasJunkSegment(url) {
  const { hasJunkSegment: check } = await getJunkFilter();
  return check(url);
}

/** Mongo bulkWrite/insertMany batch size (architecture §10 — never one giant
 * batch; Mongo splits internally, but we cap our own slices too). */
const BATCH_SIZE = 5000;

/**
 * Mirrors a finished crawl into Product / ProductEvent / Snapshot.
 * @param {object} params
 * @param {string} params.origin   Full origin URL of the crawled store.
 * @param {Array}  params.products Crawled products ({name, brand, price,
 *                                 available, url, sku?, gtin?}).
 * @param {object} params.stats    Crawl stats ({discovered, fetched,
 *                                 skippedUnchanged, failed, durationMs,
 *                                 capped?}). `stats.capped` is true when
 *                                 `maxPages` cut the run short of the full
 *                                 catalogue.
 * @param {object|null} params.discovery Discovery diagnostics (reused as-is).
 * @param {Array}  params.failures  Per-URL failures (capped into the Snapshot).
 * @param {boolean} [params.fullCrawl] True when `products` is the COMPLETE
 *                 catalogue for the origin. Removed-product detection only
 *                 runs for full crawls — shallow checks (Phase 2, §3.2) fetch
 *                 only new pages, so a partial list must never soft-delete the
 *                 rest of the store. Defaults to inferring from stats, which
 *                 is correct for today's always-full-crawl results. A run is
 *                 additionally treated as partial when `stats.capped` is set.
 * @param {Date}   [params.at] Crawl completion time. Overrides the clock for
 *                 backfills: replays carry the ORIGINAL crawl timestamp so
 *                 snapshot finishedAt, event `at`, priceHistory points and
 *                 firstSeen/lastSeen stay truthful instead of collapsing onto
 *                 "now". Defaults to the current time.
 * @param {Map}    [params.httpStateByUrl] Phase B resume state (URL →
 *                 {etag, lastmod}) captured by the engine this run; merged
 *                 onto each Product.httpState so ANY worker can skip
 *                 unchanged products on the next crawl (architecture §3.1).
 * @returns {Promise<object>} summary: {ok, productCount, addedCount,
 *          removedCount, priceChangedCount, stockChangedCount, snapshotId}.
 */
async function syncNewModel({
  origin,
  products,
  stats = {},
  discovery,
  failures,
  fullCrawl,
  at,
  httpStateByUrl
}) {
  const key = normalizeHost(origin);
  const now = at ?? new Date();
  const s = stats || {};
  const durationMs = Number.isFinite(s.durationMs) ? s.durationMs : 0;
  // True when `maxPages` cut this run short of the full catalogue (engine
  // computes it as `discovered > maxPages`). A capped run is NOT the whole
  // store — the URLs beyond the cap must never read as removals, and its
  // snapshot must never become the removal anchor.
  const capped = !!(s.capped);
  // Cross-currency normalization (decision Aug 2026): the latest USD-base
  // rate table, fetched once per crawl (cached in-process + in Mongo). Never
  // throws — a rates outage degrades to {} and priceUsd stays null.
  const fxRates = await getRates();
  // Phase B: URL → {etag, lastmod} captured this run. Applied to the upserts
  // below so Product.httpState stays current for cross-worker resume.
  const httpStateOf = (url) =>
    httpStateByUrl instanceof Map ? httpStateByUrl.get(url) : undefined;

  // 1. Previous FULL snapshot (the removal-diff anchor) + current Product
  //    state. A product counts as "active" when its lastSeenAt is >= the last
  //    full-crawl time; soft-deleted products (older lastSeenAt) stay excluded
  //    forever. Anchoring on the last FULL snapshot (not the last of any kind)
  //    means a shallow/partial run never shifts the boundary and hides a
  //    product's later removal.
  const prev = await Snapshot.findOne({ origin, full: true })
    .sort({ finishedAt: -1 })
    .select('finishedAt')
    .lean();
  const prevTime = prev ? prev.finishedAt : new Date(0);

  const existingDocs = await Product.find({ origin })
    .select('identityKey name brand price available lastSeenAt url')
    .lean();
  const existing = new Map(existingDocs.map((p) => [p.identityKey, p]));

  // 1.5 Ingest guard (Aug 2026): drop crawled rows whose URL is an unambiguous
  //     non-product page (blog/policy/collection…). These are pages that slipped
  //     past discovery and extracted a title-as-name with no price — they must
  //     never become catalogue rows (they pollute comparisons and matches).
  //     Products with a real identity (gtin/sku) are always kept — junk pages
  //     never carry one, and a genuine product at an unusual URL must not be
  //     dropped (reviewer note, Aug 2026). Bonus: if a crawl's rows were ALL
  //     junk, products.length becomes 0 → isFull false → the removal guard
  //     preserves the existing catalogue instead of mass-removing it.
  //     (hasJunkSegment loads the shared TS classifier — resolved once.)
  const junkChecks = await Promise.all(
    products.map(async (p) => ({
      keep: !(await hasJunkSegment(p.url)) || !!(p.gtin || p.sku),
      p
    }))
  );
  const keptProducts = junkChecks.filter((x) => x.keep).map((x) => x.p);
  const junkFilteredCount = products.length - keptProducts.length;
  if (junkFilteredCount > 0) {
    console.warn(
      `crawlSync: dropped ${junkFilteredCount}/${products.length} crawled rows for ${origin} — non-product URLs (blog/policy/collection).`
    );
  }
  products = keptProducts;

  // 2. Normalize the crawled products once: identity key + the stored fields
  //    (normalized gtin/sku/slug so the sparse match-tier indexes stay lean
  //    and Phase-3 $in lookups align with the stored values).
  const crawled = products.map((p) => {
    const price =
      typeof p.price === 'number' && Number.isFinite(p.price) ? p.price : undefined;
    const gtin = normalizeGtin(p.gtin || p.barcode);
    const sku = normalizeSku(p.sku);
    const slug = slugFromUrl(p.url);
    const name = String(p.name || '').trim();
    // Real currency when the crawler captured one (null = genuinely unknown
    // — no more silent USD). priceUsd converts it for cross-store comparison.
    const currency = String(p.currency || '').trim().toUpperCase() || null;
    const priceUsd = toUsd(price, currency, fxRates);
    return {
      identityKey: productIdentityKey(p),
      name,
      brand: String(p.brand || '').trim(),
      price,
      currency,
      priceUsd,
      available: p.available !== false,
      url: String(p.url || '').trim(),
      gtin: gtin || undefined,
      sku: sku || undefined,
      slug: slug || undefined,
      // Fuzzy inverted-index vocabulary (architecture §4.2) — refreshed with
      // the name so a rename re-indexes the product. `tokens` is the token
      // inverted index; `trigrams` is the character-trigram recall tier that
      // catches near-duplicate names sharing no tokens ("Nike Air" vs
      // "NikeAri").
      tokens: nameTokens(name),
      trigrams: nameTrigrams(name),
    };
  });

  // 3. Build bulkWrite ops with change detection + event seeds.
  const ops = [];
  const keyByOpIndex = new Map(); // bulkWrite op index -> identityKey
  const eventSeeds = []; // {type, identityKey, name, url, old, new, existing?}
  const seenKeys = new Set();
  let renamedCount = 0;

  for (const c of crawled) {
    seenKeys.add(c.identityKey);
    const prevDoc = existing.get(c.identityKey);
    const point =
      typeof c.price === 'number'
        ? { t: now, price: c.price, available: c.available }
        : null;

    if (!prevDoc) {
      // New product — full insert; the initial observation seeds priceHistory.
      const opIndex = ops.length;
      const httpState = httpStateOf(c.url);
      ops.push({
        updateOne: {
          filter: { origin, identityKey: c.identityKey },
          update: {
            $set: { lastSeenAt: now },
            $setOnInsert: {
              origin,
              key,
              name: c.name,
              brand: c.brand,
              price: c.price,
              currency: c.currency,
              priceUsd: c.priceUsd,
              available: c.available,
              url: c.url,
              ...(c.gtin ? { gtin: c.gtin } : {}),
              ...(c.sku ? { sku: c.sku } : {}),
              ...(c.slug ? { slug: c.slug } : {}),
              tokens: c.tokens,
              trigrams: c.trigrams,
              firstSeenAt: now,
              priceHistory: point ? [point] : [],
              // Phase B resume state from the run that first saw this product.
              ...(httpState ? { httpState } : {}),
            },
          },
          upsert: true,
        },
      });
      keyByOpIndex.set(opIndex, c.identityKey);
      eventSeeds.push({
        type: 'added',
        identityKey: c.identityKey,
        name: c.name,
        url: c.url,
        old: null,
        new: { price: c.price, available: c.available },
      });
      continue;
    }

    // Existing product — detect what changed. priceChanged only fires when the
    // new price is a real number: a crawl that omitted a price (transient
    // extraction failure) must not wipe the stored price or emit a bogus
    // price_changed event.
    const priceChanged =
      typeof c.price === 'number' && prevDoc.price !== c.price;
    const stockChanged = prevDoc.available !== c.available;
    const nameChanged = prevDoc.name !== c.name;
    const brandChanged = prevDoc.brand !== c.brand;

    const set = { lastSeenAt: now };
    const changed = priceChanged || stockChanged;
    if (changed) {
      set.price = c.price;
      set.available = c.available;
      set.priceUpdatedAt = now;
    }
    // Refresh currency + priceUsd on EVERY touch, not only when the price
    // moves (Aug 2026 fix): a re-crawl of a store crawled before the currency
    // capture shipped would otherwise keep its legacy silent-'USD' label and
    // null priceUsd forever — the exact cause of "different currencies" on
    // matches where both sides have real prices (urbanfitness AED rows only
    // gained priceUsd when their price changed). Captures are now correct
    // (JSON-LD/OG/symbol), so an unchanged product just gets the right
    // currency + conversion written back. Only set when actually captured:
    // a null currency never overwrites a previously-good value.
    if (c.currency) set.currency = c.currency;
    if (c.priceUsd != null) set.priceUsd = c.priceUsd;
    if (nameChanged) {
      set.name = c.name;
      set.tokens = c.tokens; // rename → re-index the fuzzy vocabulary
      set.trigrams = c.trigrams; // …and the trigram recall vocabulary
      renamedCount++;
    }
    if (brandChanged) set.brand = c.brand;
    // Phase B: refresh the durable resume state whenever this run touched the
    // product (the engine captured etag/lastmod for fetched + reused URLs).
    const httpState = httpStateOf(c.url);
    if (httpState) set.httpState = httpState;

    // priceHistory is appended ONLY on change (architecture §2.2) — an
    // unchanged product must not accumulate a point per crawl.
    const update =
      changed && point
        ? {
            $set: set,
            $push: {
              priceHistory: { $each: [point], $slice: -Product.PRICE_HISTORY_LIMIT },
            },
          }
        : { $set: set };
    ops.push({ updateOne: { filter: { origin, identityKey: c.identityKey }, update } });

    if (priceChanged) {
      eventSeeds.push({
        type: 'price_changed',
        identityKey: c.identityKey,
        name: c.name,
        url: c.url,
        old: { price: prevDoc.price, available: prevDoc.available },
        new: { price: c.price, available: c.available },
        existing: prevDoc,
      });
    }
    if (stockChanged) {
      eventSeeds.push({
        type: 'stock_changed',
        identityKey: c.identityKey,
        name: c.name,
        url: c.url,
        old: { price: prevDoc.price, available: prevDoc.available },
        new: { price: c.price, available: c.available },
        existing: prevDoc,
      });
    }
  }

  // 4. Removed products = previously active keys not seen this crawl. Only
  //    for FULL catalogues: the run must have been asked for the whole store
  //    (fullCrawl), not capped short by maxPages (a capped run deliberately
  //    fetches only the first N URLs — the rest are not removals), and must
  //    actually have parsed products (a run that fetched 0 pages — e.g. a
  //    WAF-blocked or unrenderable store — must never mass-remove the
  //    catalogue: Aug 2026, activefitnessstore.com's 10,522-discovered /
  //    0-fetched run soft-deleted all 10,462 products this way).
  //    `products.length` (not discovered/fetched) is the honest "we really
  //    saw this store" signal; shallow/partial runs (fullCrawl === false)
  //    are excluded regardless.
  const isFull = fullCrawl !== false && !capped && products.length > 0;
  const authoritative = isFull;
  const removedKeys = [];
  if (authoritative) {
    for (const [k, doc] of existing) {
      if (!seenKeys.has(k) && doc.lastSeenAt >= prevTime) removedKeys.push(k);
    }
  }

  // 5. Execute the upserts (chunked; remap per-chunk upsertedIds to keys).
  const upsertedByKey = new Map();
  for (let start = 0; start < ops.length; start += BATCH_SIZE) {
    const chunk = ops.slice(start, start + BATCH_SIZE);
    const result = await Product.bulkWrite(chunk, { ordered: false });
    for (const [idx, id] of Object.entries(result.upsertedIds)) {
      const identityKey = keyByOpIndex.get(start + Number(idx));
      if (identityKey) upsertedByKey.set(identityKey, id);
    }
  }

  // 6. Persist events (added/changed need the new/known product id; removed
  //    use the existing doc's id). Skipped only if the id can't be resolved
  //    (an insert race — the other run emitted its own event).
  const eventRows = [];
  for (const seed of eventSeeds) {
    const productId = seed.existing
      ? seed.existing._id
      : upsertedByKey.get(seed.identityKey);
    if (!productId) {
      console.warn(
        `crawlSync: skipped ${seed.type} event for ${origin} (${seed.identityKey}) — no product id`
      );
      continue;
    }
    eventRows.push({
      origin,
      key,
      type: seed.type,
      productId,
      identityKey: seed.identityKey,
      name: seed.name,
      url: seed.url,
      old: seed.old ?? null,
      new: seed.new ?? null,
      at: now,
    });
  }
  for (const k of removedKeys) {
    const doc = existing.get(k);
    eventRows.push({
      origin,
      key,
      type: 'removed',
      productId: doc._id,
      identityKey: k,
      name: doc.name,
      url: doc.url,
      old: { price: doc.price, available: doc.available },
      new: null,
      at: now,
    });
  }
  for (let i = 0; i < eventRows.length; i += BATCH_SIZE) {
    await ProductEvent.insertMany(eventRows.slice(i, i + BATCH_SIZE), {
      ordered: false,
    });
  }

  // 7. Snapshot summary + history cap (decision D3).
  const addedKeys = eventSeeds
    .filter((e) => e.type === 'added')
    .map((e) => e.identityKey);
  const priceChangedCount = eventSeeds.filter((e) => e.type === 'price_changed').length;
  const stockChangedCount = eventSeeds.filter((e) => e.type === 'stock_changed').length;

  // `full` is the removal anchor for future runs: it must stay false unless
  // this run was a GENUINE full catalogue (see `isFull` above). Marking a
  // capped or 0-product run `full: true` would let the next crawl anchor on
  // it — products untouched since then would become permanently ineligible
  // for removal detection (the stale-catalogue trap).
  const snapshot = await Snapshot.create({
    origin,
    key,
    startedAt: durationMs ? new Date(now.getTime() - durationMs) : undefined,
    finishedAt: now,
    full: isFull,
    durationMs,
    stats: {
      discovered: s.discovered ?? 0,
      fetched: s.fetched ?? 0,
      skippedUnchanged: s.skippedUnchanged ?? 0,
      failed: s.failed ?? 0,
      durationMs,
    },
    productCount: products.length,
    addedCount: addedKeys.length,
    removedCount: removedKeys.length,
    priceChangedCount,
    stockChangedCount,
    addedKeys: addedKeys.slice(0, Snapshot.KEYS_SUMMARY_LIMIT),
    removedKeys: removedKeys.slice(0, Snapshot.KEYS_SUMMARY_LIMIT),
    discovery: discovery ?? null,
    failures: (failures || []).slice(0, Snapshot.FAILURES_LIMIT),
  });

  // 8. Link this run's events to the snapshot (events were inserted before it
  //    existed) and cap history per origin (decision D3). Every event row of
  //    this run shares the exact `at` timestamp, so the match is precise even
  //    under concurrent crawls of other origins.
  await ProductEvent.updateMany(
    { origin, at: now },
    { $set: { snapshotId: snapshot._id } }
  );
  const keep = await Snapshot.find({ origin })
    .sort({ finishedAt: -1 })
    .limit(Snapshot.SNAPSHOT_LIMIT)
    .select('_id');
  const keepIds = keep.map((d) => d._id);
  // A shallow-heavy store must never lose its last full snapshot — the
  // removal anchor depends on it — so it survives the cap.
  const newestFull = await Snapshot.findOne({ origin, full: true })
    .sort({ finishedAt: -1 })
    .select('_id')
    .lean();
  if (newestFull && !keepIds.some((id) => id.equals(newestFull._id))) {
    keepIds.push(newestFull._id);
  }
  await Snapshot.deleteMany({
    origin,
    _id: { $nin: keepIds },
  });

  return {
    ok: true,
    productCount: products.length,
    addedCount: addedKeys.length,
    removedCount: removedKeys.length,
    priceChangedCount,
    stockChangedCount,
    renamedCount,
    snapshotId: snapshot._id,
  };
}

module.exports = { syncNewModel };
