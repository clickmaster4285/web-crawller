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
 * Lazy token backfill: legacy Product docs (written before Phase 3) have no
 * tokens, so they'd be invisible to the fuzzy candidate query. Compute them
 * from the name and persist — idempotent, one pass per origin, cheap.
 */
async function ensureTokensForOrigin(origin) {
  const missing = await Product.find({
    origin,
    $or: [{ tokens: { $exists: false } }, { tokens: { $size: 0 } }]
  })
    .select('_id name')
    .lean();
  if (!missing.length) return 0;
  const { nameTokens } = require('../utils/matcher');
  const ops = missing.map((p) => ({
    updateOne: {
      filter: { _id: p._id },
      update: { $set: { tokens: nameTokens(p.name) } }
    }
  }));
  await Product.bulkWrite(ops, { ordered: false });
  return missing.length;
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
  if (gtins.length) {
    queries.push(Product.find({ origin: theirsOrigin, ...active, gtin: { $in: gtins } })
      .select('_id name sku gtin url price available').lean());
  }
  if (skus.length) {
    queries.push(Product.find({ origin: theirsOrigin, ...active, sku: { $in: skus } })
      .select('_id name sku gtin url price available').lean());
  }
  if (slugs.length) {
    queries.push(Product.find({ origin: theirsOrigin, ...active, slug: { $in: slugs } })
      .select('_id name sku gtin url price available').lean());
  }
  if (tokens.length) {
    // Fuzzy inverted index: candidates must share a token with a mine product.
    queries.push(Product.find({ origin: theirsOrigin, ...active, tokens: { $in: tokens } })
      .select('_id name sku gtin url price available tokens').lean());
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
  // Tokens MUST be backfilled BEFORE loadTheirsCandidates: the candidate
  // query relies on the token multikey index, so legacy docs without tokens
  // would be invisible to the fuzzy tier (and my own docs need theirs for
  // the candidate token set). Idempotent — one pass per origin, then a no-op.
  await ensureTokensForOrigin(mineOrigin);
  await ensureTokensForOrigin(theirsOrigin);
  const mine = await loadActiveProducts(
    mineOrigin,
    '_id name sku gtin url price available tokens'
  );
  if (mine.length === 0) {
    await ProductMatch.deleteMany({ mineOrigin, competitorKey });
    return { matched: 0, methods: {}, cleared: true };
  }

  const boundary = await activeBoundary(theirsOrigin);
  const theirs = await loadTheirsCandidates(theirsOrigin, mine, boundary);

  // Reuse the legacy pairing semantics over the candidate set (identity
  // keys are already normalized at ingest; re-normalization is idempotent).
  const { matched } = matchCatalogues(mine, theirs, {
    fuzzyThreshold: threshold
  });

  const rows = matched.map((pair) => ({
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
      .select('_id name price available url')
      .lean(),
    Product.find({ _id: { $in: theirsIds } })
      .select('_id name price available url')
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
        available: mine.available,
        url: mine.url
      },
      theirs: {
        productId: String(theirs._id),
        name: theirs.name,
        price: theirs.price ?? null,
        available: theirs.available,
        url: theirs.url
      }
    });
  }

  // Competitor products you don't carry (active, no persisted match).
  const matchedTheirsIds = await ProductMatch.distinct('competitorProductId', scope);
  const boundary = await activeBoundary(theirsOrigin);
  const onlyTheirs = await Product.countDocuments({
    origin: theirsOrigin,
    lastSeenAt: { $gte: boundary },
    ...(matchedTheirsIds.length ? { _id: { $nin: matchedTheirsIds } } : {})
  });

  return {
    competitorKey,
    mineOrigin,
    total,
    page,
    limit: cap,
    rows: out,
    onlyTheirs
  };
}

module.exports = {
  getMyStore,
  activeBoundary,
  loadActiveProducts,
  countActiveProducts,
  ensureTokensForOrigin,
  competitorOrigins,
  loadTheirsCandidates,
  reconcilePair,
  reconcileForOrigin,
  matchesForCompetitor
};
