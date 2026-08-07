/**
 * matchService — Phase 3 indexed matching (architecture §4).
 *
 * Replaces "load both catalogues, match in memory" with index lookups:
 *
 *   - **Exact tiers** (GTIN > SKU > slug) hit the sparse Product indexes via
 *     `$in` queries — only the competitor docs sharing an identity key with
 *     your catalogue are ever loaded.
 *   - **Fuzzy** uses the token inverted index (`Product.tokens`, multikey
 *     index): candidates are fetched with `tokens: { $in: myTokens }` and only
 *     those are similarity-scored — the full cross product is never
 *     enumerated (retires the FUZZY_PAIR_LIMIT concern at catalogue scale).
 *   - **Matches are persisted** (`ProductMatch`, unique per mine product +
 *     competitor) by a full-pair reconcile run in the post-crawl pipeline
 *     (best-effort, off the request path) — an untouched competitor's pair is
 *     never recomputed. The UI reads paginated persisted matches + latest
 *     prices via `GET /api/match` — zero recomputation on page load.
 *
 * `matchCatalogues` (utils/matcher.js) does the pairing itself — the reuse
 * keeps the tier semantics identical to the legacy on-demand matcher.
 */
const Product = require('../models/Product');
const ProductMatch = require('../models/ProductMatch');
const Snapshot = require('../models/Snapshot');
const MyStore = require('../models/MyStore');
const Competitor = require('../models/Competitor');
const { matchCatalogues, FUZZY_THRESHOLD } = require('../utils/matcher');
const { normalizeHost } = require('../utils/identity');

/** Trigram recall tier bounds (matchByTrigrams). */
const TRIGRAM_RARE_CAP = 200; // max competitor docs sharing a "rare" gram
const TRIGRAM_MAX_GRAMS = 8000; // global gram budget for the $in set
const TRIGRAM_MIN_SHARED = 2; // min shared grams to be scored
const TRIGRAM_JACCARD_MIN = 0.3; // min trigram Jaccard to be scored
const TRIGRAM_MAX_CANDIDATES = 50_000; // abort tier if candidates explode

/** The user's own store doc, or null when unset. */
async function getMyStore() {
  return MyStore.findById(MyStore.MY_STORE_ID);
}

/**
 * The active-set boundary for an origin: products with
 * `lastSeenAt >= boundary` are currently sold (soft-deleted products have
 * older lastSeenAt and are excluded). Anchored on the last FULL snapshot —
 * the same anchor the ingest removal diff uses — so shallow-heavy stores
 * keep their real active set.
 */
async function activeBoundary(origin) {
  const last = await Snapshot.findOne({ origin, full: true })
    .sort({ finishedAt: -1 })
    .select('finishedAt')
    .lean();
  return last ? last.finishedAt : new Date(0);
}

/** Active (currently sold) products of an origin. */
async function loadActiveProducts(origin, projection) {
  const boundary = await activeBoundary(origin);
  return Product.find({ origin, lastSeenAt: { $gte: boundary } })
    .select(projection)
    .lean();
}

/** Active product count for an origin (cheap existence check). */
async function countActiveProducts(origin) {
  const boundary = await activeBoundary(origin);
  return Product.countDocuments({ origin, lastSeenAt: { $gte: boundary } });
}

/**
 * Lazy fuzzy-vocabulary backfill: legacy Product docs (written before the
 * fuzzy tiers shipped) have no tokens/trigrams, so they'd be invisible to the
 * candidate queries. Compute both from the name and persist — idempotent, one
 * pass per origin, cheap.
 */
async function ensureVocabForOrigin(origin) {
  const missing = await Product.find({
    origin,
    $or: [
      { tokens: { $exists: false } },
      { tokens: { $size: 0 } },
      { trigrams: { $exists: false } },
      { trigrams: { $size: 0 } }
    ]
  })
    .select('_id name')
    .lean();
  if (!missing.length) return 0;
  const { nameTokens, nameTrigrams } = require('../utils/matcher');
  const ops = missing.map((p) => ({
    updateOne: {
      filter: { _id: p._id },
      update: {
        $set: {
          tokens: nameTokens(p.name),
          trigrams: nameTrigrams(p.name)
        }
      }
    }
  }));
  await Product.bulkWrite(ops, { ordered: false });
  return missing.length;
}

/**
 * Trigram recall tier — recovers near-duplicate names that share NO tokens
 * ("Nike Air" vs "NikeAri"), which the token inverted index structurally
 * misses (architecture §4.2 follow-up). Bounded by:
 *
 *   - a rare-gram frequency cap (a gram shared by half the store is
 *     worthless signal) with a global gram budget for the $in set;
 *   - a hard candidate ceiling — the tier is skipped entirely if the
 *     candidate fetch explodes;
 *   - a shared-gram count + trigram-Jaccard pre-filter so the similarity
 *     scoring stays cheap (only plausible near-duplicates are scored).
 *
 * `mine` is the round-1 unmatched mine products (with `trigrams` loaded);
 * `roundOneMatchedTheirsIds` are the competitor docs already paired in round
 * 1 — the candidate query searches the ENTIRE active competitor catalogue
 * (minus those), which is the whole point: recall-gap products share no
 * token with mine, so they were never in the round-1 candidate set. Pairs
 * come out as `fuzzy` rows with the same nameSimilarity confidence as the
 * token tier.
 */
async function matchByTrigrams(
  mine,
  roundOneMatchedTheirsIds,
  theirsOrigin,
  boundary,
  threshold
) {
  if (!mine.length) return [];
  const { nameTrigrams, nameSimilarity, fuzzyName } = require('../utils/matcher');
  const alreadyMatched =
    roundOneMatchedTheirsIds.length > 0
      ? { _id: { $nin: roundOneMatchedTheirsIds } }
      : {};

  // 1. Rare-gram frequency map for the competitor's ACTIVE catalogue.
  const freqRows = await Product.aggregate([
    {
      $match: {
        origin: theirsOrigin,
        lastSeenAt: { $gte: boundary },
        trigrams: { $exists: true, $ne: [] }
      }
    },
    { $unwind: '$trigrams' },
    { $group: { _id: '$trigrams', n: { $sum: 1 } } },
    { $match: { n: { $lte: TRIGRAM_RARE_CAP } } },
    { $sort: { n: 1 } },
    { $limit: TRIGRAM_MAX_GRAMS }
  ]);
  const rareGrams = new Set(freqRows.map((r) => r._id));
  if (!rareGrams.size) return [];

  // 2. My still-unmatched products, reduced to their rare grams.
  const mineEntries = [];
  const mineGramSet = new Set();
  for (const m of mine) {
    const grams = nameTrigrams(m.name).filter((g) => rareGrams.has(g));
    if (!grams.length) continue;
    mineEntries.push({ mine: m, grams });
    for (const g of grams) mineGramSet.add(g);
  }
  if (!mineGramSet.size) return [];
  const gramList = [...mineGramSet];

  // 3. Candidates: ACTIVE competitor products (the full catalogue minus the
  //    round-1 matches) sharing any of my rare grams. Chunked $in; deduped
  //    by _id. This is where the recall gap is bridged — a product that
  //    shares no token with mine was invisible to round 1, but a shared
  //    trigram surfaces it here.
  const cands = new Map();
  for (let i = 0; i < gramList.length; i += 2000) {
    const chunk = gramList.slice(i, i + 2000);
    const docs = await Product.find({
      origin: theirsOrigin,
      lastSeenAt: { $gte: boundary },
      ...alreadyMatched,
      trigrams: { $in: chunk }
    })
      .select('_id name url price available trigrams')
      .lean();
    for (const d of docs) {
      if (cands.has(String(d._id))) continue;
      // Bail EARLY — per chunk, not after the whole fetch — so a noisy
      // catalogue can't make us pull hundreds of thousands of docs.
      if (cands.size + 1 > TRIGRAM_MAX_CANDIDATES) return [];
      cands.set(String(d._id), d);
    }
  }
  if (!cands.size) return [];

  // 4. Gram → docs index for scoring.
  const byGram = new Map();
  for (const d of cands.values()) {
    for (const g of d.trigrams ?? []) {
      if (!mineGramSet.has(g)) continue;
      const list = byGram.get(g) ?? [];
      list.push(d);
      byGram.set(g, list);
    }
  }

  // 5. Greedy best-match per mine product: shared-gram count + trigram
  //    Jaccard floor first, then the highest-Jaccard free candidate.
  const usedTheirs = new Set();
  const pairs = [];
  for (const { mine: m, grams } of mineEntries) {
    const na = fuzzyName(m.name);
    if (!na) continue;
    const mineGramCount = grams.length;
    const candSet = new Map();
    for (const g of grams) {
      for (const d of byGram.get(g) ?? []) {
        const id = String(d._id);
        if (usedTheirs.has(id)) continue;
        const entry = candSet.get(id);
        if (entry) entry.shared++;
        else candSet.set(id, { doc: d, shared: 1 });
      }
    }
    let best = null;
    let bestJ = 0;
    for (const { doc, shared } of candSet.values()) {
      if (shared < TRIGRAM_MIN_SHARED) continue;
      const theirGrams = new Set(doc.trigrams ?? []);
      // Note: mineGramCount is the rare-only subset while theirGrams is the
      // full set, so this pre-filter Jaccard is mildly inflated on the mine
      // side — acceptable, since the real gate is nameSimilarity below.
      const j = shared / (mineGramCount + theirGrams.size - shared);
      if (j < TRIGRAM_JACCARD_MIN) continue;
      if (j > bestJ) {
        bestJ = j;
        best = doc;
      }
    }
    if (best) {
      const sim = nameSimilarity(na, fuzzyName(best.name));
      // Same acceptance gate as the token fuzzy tier: the trigram Jaccard
      // only bounded the candidates — the real similarity threshold decides.
      if (sim < threshold) continue;
      usedTheirs.add(String(best._id));
      pairs.push({
        mine: m,
        theirs: best,
        method: 'fuzzy',
        confidence: Math.round(sim * 100)
      });
    }
  }
  return pairs;
}

/**
 * Every competitor origin: crawled origins with products + manually-added
 * competitors, excluding the user's own store.
 */
async function competitorOrigins(myOrigin) {
  const [crawled, manual] = await Promise.all([
    Product.distinct('origin'),
    Competitor.find({}).select('origin').lean()
  ]);
  const set = new Set();
  for (const o of crawled) {
    if (normalizeHost(o) !== normalizeHost(myOrigin)) set.add(o);
  }
  for (const m of manual) {
    if (normalizeHost(m.origin) !== normalizeHost(myOrigin)) set.add(m.origin);
  }
  return [...set];
}

/**
 * Loads the competitor's candidate set via the identity + token indexes:
 * only docs sharing a gtin/sku/slug/token with YOUR catalogue. Deduped by
 * _id; this is a superset of every possible match (an exact match needs a
 * shared identity key, a fuzzy one needs a shared token).
 */
async function loadTheirsCandidates(theirsOrigin, mineDocs, boundary) {
  const byId = new Map();
  const grab = (docs) => {
    for (const d of docs) if (!byId.has(d._id)) byId.set(d._id, d);
  };
  const active = { lastSeenAt: { $gte: boundary } };

  const gtins = [...new Set(mineDocs.map((m) => m.gtin).filter(Boolean))];
  const skus = [...new Set(mineDocs.map((m) => m.sku).filter(Boolean))];
  const slugs = [...new Set(mineDocs.map((m) => m.slug).filter(Boolean))];
  const tokens = [...new Set(mineDocs.flatMap((m) => m.tokens ?? []))];

  const queries = [];
  const CANDIDATE_SELECT = '_id name sku gtin url price currency priceUsd available';
  if (gtins.length) {
    queries.push(Product.find({ origin: theirsOrigin, ...active, gtin: { $in: gtins } })
      .select(CANDIDATE_SELECT).lean());
  }
  if (skus.length) {
    queries.push(Product.find({ origin: theirsOrigin, ...active, sku: { $in: skus } })
      .select(CANDIDATE_SELECT).lean());
  }
  if (slugs.length) {
    queries.push(Product.find({ origin: theirsOrigin, ...active, slug: { $in: slugs } })
      .select(CANDIDATE_SELECT).lean());
  }
  if (tokens.length) {
    // Fuzzy inverted index: candidates must share a token with a mine product.
    queries.push(Product.find({ origin: theirsOrigin, ...active, tokens: { $in: tokens } })
      .select(`${CANDIDATE_SELECT} tokens`).lean());
  }
  const results = await Promise.all(queries);
  for (const docs of results) grab(docs);
  return [...byId.values()];
}

/**
 * Reconciles one (mine, competitor) pair: indexed match → full replace of the
 * pair's ProductMatch rows. Authoritative for the pair — rows for matches
 * that no longer exist (removed products, renamed, identity changed) are
 * wiped by the replace. Returns a summary.
 */
async function reconcilePair(mineOrigin, theirsOrigin, { threshold = FUZZY_THRESHOLD } = {}) {
  const [theirsCount] = await Promise.all([
    countActiveProducts(theirsOrigin)
  ]);
  const competitorKey = normalizeHost(theirsOrigin);
  if (theirsCount === 0) {
    // Empty side → the pair has no matches; clear any stale rows.
    await ProductMatch.deleteMany({ mineOrigin, competitorKey });
    return { matched: 0, methods: {}, cleared: true };
  }
  // Fuzzy vocab MUST be backfilled BEFORE loadTheirsCandidates: the candidate
  // queries rely on the token + trigram multikey indexes, so legacy docs
  // without them would be invisible to the fuzzy tiers (and my own docs need
  // theirs for the candidate token/gram sets). Idempotent — one pass per
  // origin, then a no-op.
  await ensureVocabForOrigin(mineOrigin);
  await ensureVocabForOrigin(theirsOrigin);
  const mine = await loadActiveProducts(
    mineOrigin,
    '_id name sku gtin url price available tokens trigrams'
  );
  if (mine.length === 0) {
    await ProductMatch.deleteMany({ mineOrigin, competitorKey });
    return { matched: 0, methods: {}, cleared: true };
  }

  const boundary = await activeBoundary(theirsOrigin);
  const theirs = await loadTheirsCandidates(theirsOrigin, mine, boundary);

  // Reuse the legacy pairing semantics over the candidate set (identity
  // keys are already normalized at ingest; re-normalization is idempotent).
  const { matched, onlyMine, onlyTheirs } = matchCatalogues(mine, theirs, {
    fuzzyThreshold: threshold
  });

  // Trigram recall tier — near-duplicates with disjoint tokens never surface
  // in the token candidate query; recover them via rare-gram candidates over
  // the FULL competitor catalogue (minus round-1 matches). Persisted as
  // 'fuzzy' rows like the token tier.
  const trigramPairs = await matchByTrigrams(
    onlyMine,
    matched.map((pair) => pair.theirs._id),
    theirsOrigin,
    boundary,
    threshold
  );

  const rows = [...matched, ...trigramPairs].map((pair) => ({
    mineProductId: pair.mine._id,
    mineOrigin,
    competitorKey,
    competitorProductId: pair.theirs._id,
    method: pair.method,
    confidence: pair.confidence
  }));

  // Full replace — idempotent, and cleans rows whose products disappeared.
  await ProductMatch.deleteMany({ mineOrigin, competitorKey });
  if (rows.length) {
    await ProductMatch.insertMany(rows, { ordered: false });
  }

  const methods = {};
  for (const r of rows) methods[r.method] = (methods[r.method] ?? 0) + 1;
  return { matched: rows.length, methods, cleared: false };
}

/**
 * Reconciles everything affected by a finished crawl of `origin`:
 *   - the my-store crawled → re-match against EVERY competitor;
 *   - a competitor crawled → re-match the my-store vs it.
 * No-op when the user hasn't set their store. Best-effort — callers catch.
 */
async function reconcileForOrigin(origin) {
  const myStore = await getMyStore();
  if (!myStore?.origin) return { ok: false, reason: 'no-my-store', pairs: 0 };
  const mineOrigin = myStore.origin;
  let pairs = [];
  if (normalizeHost(origin) === normalizeHost(mineOrigin)) {
    const origins = await competitorOrigins(mineOrigin);
    for (const c of origins) {
      pairs.push(await reconcilePair(mineOrigin, c));
    }
  } else {
    pairs.push(await reconcilePair(mineOrigin, origin));
  }
  const matched = pairs.reduce((sum, p) => sum + p.matched, 0);
  return { ok: true, pairs: pairs.length, matched };
}

/**
 * Read path — paginated persisted matches for one competitor, joined with the
 * latest prices from Product. Returns null when no my-store is set.
 */
async function matchesForCompetitor(
  theirsOrigin,
  { page = 1, limit = 25 } = {}
) {
  const myStore = await getMyStore();
  if (!myStore?.origin) return null;
  const mineOrigin = myStore.origin;
  const competitorKey = normalizeHost(theirsOrigin);
  const skip = Math.max(0, (page - 1) * limit);
  const cap = Math.min(100, Math.max(1, Math.round(limit)));

  // All queries are scoped to (mineOrigin, competitorKey) — never just the
  // key — so a my-store origin switch can't leak the previous store's rows
  // into total / the exclusion set (matches the row-level `continue` guard).
  const scope = { mineOrigin, competitorKey };
  const [total, rows] = await Promise.all([
    ProductMatch.countDocuments(scope),
    ProductMatch.find(scope)
      .sort({ confidence: -1, updatedAt: -1 })
      .skip(skip)
      .limit(cap)
      .lean()
  ]);

  const mineIds = [...new Set(rows.map((r) => String(r.mineProductId)))];
  const theirsIds = [...new Set(rows.map((r) => String(r.competitorProductId)))];
  const [mineDocs, theirsDocs] = await Promise.all([
    Product.find({ _id: { $in: mineIds } })
      .select('_id name price currency priceUsd available url')
      .lean(),
    Product.find({ _id: { $in: theirsIds } })
      .select('_id name price currency priceUsd available url')
      .lean()
  ]);
  const mineMap = new Map(mineDocs.map((d) => [String(d._id), d]));
  const theirsMap = new Map(theirsDocs.map((d) => [String(d._id), d]));

  const out = [];
  for (const r of rows) {
    const mine = mineMap.get(String(r.mineProductId));
    const theirs = theirsMap.get(String(r.competitorProductId));
    if (!mine || !theirs) continue; // product hard-deleted — skip the row
    out.push({
      id: String(r._id),
      method: r.method,
      confidence: r.confidence,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : null,
      mine: {
        productId: String(mine._id),
        name: mine.name,
        price: mine.price ?? null,
        currency: mine.currency ?? null,
        // USD-normalized price (fxService at ingest) — the value price
        // comparisons should use across stores with different currencies.
        priceUsd: mine.priceUsd ?? null,
        available: mine.available,
        url: mine.url
      },
      theirs: {
        productId: String(theirs._id),
        name: theirs.name,
        price: theirs.price ?? null,
        currency: theirs.currency ?? null,
        priceUsd: theirs.priceUsd ?? null,
        available: theirs.available,
        url: theirs.url
      }
    });
  }

  // Only-A / only-B lists (active, no persisted match, paginated) + the
  // count of matches whose prices are both known and differ. These feed the
  // /competitors ComparePanel tabs and the "price differs" tile — all
  // computed server-side, so the browser never downloads full catalogues.
  const matchedMineIds = await ProductMatch.distinct('mineProductId', scope);
  const matchedTheirsIds = await ProductMatch.distinct('competitorProductId', scope);
  const mineBoundary = await activeBoundary(mineOrigin);
  const theirsBoundary = await activeBoundary(theirsOrigin);
  const mineExclude =
    matchedMineIds.length > 0 ? { _id: { $nin: matchedMineIds } } : {};
  const theirsExclude =
    matchedTheirsIds.length > 0 ? { _id: { $nin: matchedTheirsIds } } : {};
  const toSideRow = (d) => ({
    productId: String(d._id),
    name: d.name,
    price: d.price ?? null,
    currency: d.currency ?? null,
    priceUsd: d.priceUsd ?? null,
    available: d.available,
    url: d.url
  });

  const [onlyMineTotal, onlyMineDocs, onlyTheirsTotal, onlyTheirsDocs, priceDiff] =
    await Promise.all([
      Product.countDocuments({
        origin: mineOrigin,
        lastSeenAt: { $gte: mineBoundary },
        ...mineExclude
      }),
      Product.find({
        origin: mineOrigin,
        lastSeenAt: { $gte: mineBoundary },
        ...mineExclude
      })
        .sort({ lastSeenAt: -1 })
        .skip(skip)
        .limit(cap)
        .select('_id name price currency priceUsd available url')
        .lean(),
      Product.countDocuments({
        origin: theirsOrigin,
        lastSeenAt: { $gte: theirsBoundary },
        ...theirsExclude
      }),
      Product.find({
        origin: theirsOrigin,
        lastSeenAt: { $gte: theirsBoundary },
        ...theirsExclude
      })
        .sort({ lastSeenAt: -1 })
        .skip(skip)
        .limit(cap)
        .select('_id name price currency priceUsd available url')
        .lean(),
      ProductMatch.aggregate([
        { $match: scope },
        {
          $lookup: {
            from: 'products',
            localField: 'mineProductId',
            foreignField: '_id',
            as: 'm'
          }
        },
        {
          $lookup: {
            from: 'products',
            localField: 'competitorProductId',
            foreignField: '_id',
            as: 't'
          }
        },
        { $unwind: '$m' },
        { $unwind: '$t' },
        {
          $match: {
            $expr: {
              $and: [
                // Price-difference is judged in USD (priceUsd when the rates
                // normalized it; native otherwise) — never raw numbers across
                // currencies (AED 100 vs PKR 100 must not read as "same").
                { $gt: [{ $ifNull: ['$m.priceUsd', '$m.price'] }, 0] },
                { $gt: [{ $ifNull: ['$t.priceUsd', '$t.price'] }, 0] },
                {
                  $ne: [
                    { $ifNull: ['$m.priceUsd', '$m.price'] },
                    { $ifNull: ['$t.priceUsd', '$t.price'] }
                  ]
                }
              ]
            }
          }
        },
        { $count: 'n' }
      ])
    ]);

  return {
    competitorKey,
    mineOrigin,
    total,
    page,
    limit: cap,
    rows: out,
    onlyMine: { total: onlyMineTotal, rows: onlyMineDocs.map(toSideRow) },
    onlyTheirs: { total: onlyTheirsTotal, rows: onlyTheirsDocs.map(toSideRow) },
    priceDifferCount: priceDiff[0]?.n ?? 0
  };
}

module.exports = {
  getMyStore,
  activeBoundary,
  loadActiveProducts,
  countActiveProducts,
  ensureVocabForOrigin,
  competitorOrigins,
  loadTheirsCandidates,
  matchByTrigrams,
  reconcilePair,
  reconcileForOrigin,
  matchesForCompetitor
};
