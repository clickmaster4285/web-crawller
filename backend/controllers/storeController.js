/**
 * storeController — the Phase-5 store read path (architecture §6). These
 * endpoints read the NORMALIZED collections (Store / Product / Snapshot /
 * ProductEvent) so the UI can leave the legacy `CrawlResult` dumps (decision
 * D1 "freeze, then drop").
 *
 *   GET /api/stores                     → store list (meta only)
 *   GET /api/stores/:key                → store profile + latest snapshot
 *   GET /api/stores/:key/products       → cursor-paginated product catalogue
 *   GET /api/stores/:key/snapshots      → snapshot metadata (newest first)
 *   GET /api/stores/:key/events         → change-log events (?since=&type=)
 *
 * `:key` is the normalized host (`normalizeHost`/frontend `normalizeOrigin`),
 * which both Store and Product/Snapshot/Event rows carry as `key`.
 *
 * Deliberate scope notes:
 * - `MarketProduct` aggregates are not yet written at ingest, so the §6
 *   market endpoints are intentionally NOT exposed here — they would return
 *   empty data. Build the aggregate first, then add the read.
 * - Proxy credentials live in `Store.scheduledCrawl.params.proxyUrl` (worker-
 *   only). Every response below is built from an explicit field list — the
 *   raw doc is never spread, so the URL can never leak to a client.
 */
const Store = require('../models/Store');
const Product = require('../models/Product');
const Snapshot = require('../models/Snapshot');
const ProductEvent = require('../models/ProductEvent');
const CrawlResult = require('../models/CrawlResult');
const { normalizeHost } = require('../utils/identity');
const {
  encodeCursor,
  cursorFilter,
  escapeRegex,
  clampInt,
  parseIsoDate,
  parseStoreKey
} = require('../utils/readPath');

const EVENT_TYPES = new Set(['added', 'removed', 'price_changed', 'stock_changed']);

/** Projection for the products list — never full docs (no tokens/httpState). */
const PRODUCT_PROJECTION = {
  _id: 1,
  identityKey: 1,
  name: 1,
  brand: 1,
  category: 1,
  price: 1,
  compareAtPrice: 1,
  currency: 1,
  available: 1,
  url: 1,
  image: 1,
  sku: 1,
  gtin: 1,
  slug: 1,
  firstSeenAt: 1,
  lastSeenAt: 1,
  priceUpdatedAt: 1,
  // Last 30 price points — enough for a sparkline without dragging the full
  // capped series over the wire.
  priceHistory: { $slice: -30 }
};

/**
 * Explicit Store summary — fields only, and NEVER `scheduledCrawl.params`
 * (worker-only proxyUrl lives there).
 */
function storeSummary(store) {
  return {
    _id: store._id,
    key: store.key,
    origin: store.origin,
    name: store.name ?? '',
    platform: store.platform ?? null,
    productCount: store.productCount ?? 0,
    lastCrawl: store.lastCrawl ?? null,
    lastShallowAt: store.lastShallowAt ?? null,
    lastDeepAt: store.lastDeepAt ?? null,
    cadence: {
      enabled: store.cadence?.enabled ?? false,
      shallowHours: store.cadence?.shallowHours ?? 24,
      deepHours: store.cadence?.deepHours ?? 168
    },
    scheduledFrequency: store.scheduledCrawl?.frequency ?? null,
    createdAt: store.createdAt ?? null,
    updatedAt: store.updatedAt ?? null
  };
}

/** GET /api/stores — every crawled store, meta only (productCount kept at ingest). */
const listStores = async (req, res) => {
  try {
    const docs = await Store.find()
      .sort({ updatedAt: -1 })
      .lean();
    const data = docs.map(storeSummary);
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error('List stores error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** GET /api/stores/:key — store profile + its latest snapshot (discovery, stats). */
const getStore = async (req, res) => {
  try {
    const key = parseStoreKey(req.params.key);
    if (!key) {
      return res.status(400).json({ success: false, message: 'Invalid store key' });
    }
    const [store, latestSnapshot] = await Promise.all([
      Store.findOne({ key }).lean(),
      Snapshot.findOne({ key }).sort({ finishedAt: -1 }).lean()
    ]);
    res.json({
      success: true,
      data: { store: store ? storeSummary(store) : null, latestSnapshot }
    });
  } catch (error) {
    console.error('Get store error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * GET /api/stores/:key/products?q=&limit=&cursor=
 *
 * Keyset pagination on `{ lastSeenAt: -1, _id: -1 }` — the cursor is opaque
 * (base64 `ts|id`), so page jumps stay stable even while new products land.
 * `q=` filters the name (case-insensitive, regex-escaped). The name filter +
 * lastSeenAt sort scans in memory per store (≤ ~10k docs — fine by design).
 */
const listProducts = async (req, res) => {
  try {
    const key = parseStoreKey(req.params.key);
    if (!key) {
      return res.status(400).json({ success: false, message: 'Invalid store key' });
    }
    const limit = clampInt(req.query.limit, 50, 1, 200);
    // Cap the search string — a huge `q` would build a giant regex over the
    // (documented) in-memory name scan per store.
    const q = (typeof req.query.q === 'string' ? req.query.q.trim() : '').slice(0, 200);
    const filter = cursorFilter(req.query.cursor, 'lastSeenAt', { key });
    if (q) {
      filter.name = { $regex: escapeRegex(q), $options: 'i' };
    }

    // Fetch one extra row to know whether there is a next page.
    const docs = await Product.find(filter)
      .sort({ lastSeenAt: -1, _id: -1 })
      .select(PRODUCT_PROJECTION)
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const rows = hasMore ? docs.slice(0, limit) : docs;
    const last = rows[rows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(new Date(last.lastSeenAt).getTime(), last._id) : null;

    res.json({
      success: true,
      count: rows.length,
      data: rows,
      nextCursor,
      hasMore
    });
  } catch (error) {
    console.error('List products error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** GET /api/stores/:key/snapshots — metadata only, newest first (capped at 10/origin). */
const listSnapshots = async (req, res) => {
  try {
    const key = parseStoreKey(req.params.key);
    if (!key) {
      return res.status(400).json({ success: false, message: 'Invalid store key' });
    }
    const limit = clampInt(req.query.limit, 50, 1, 100);
    const docs = await Snapshot.find({ key })
      .sort({ finishedAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, count: docs.length, data: docs });
  } catch (error) {
    console.error('List snapshots error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * DELETE /api/stores/:key — removes a store everywhere: the normalized
 * collections (Store / Product / Snapshot / ProductEvent) plus the legacy
 * `CrawlResult` docs whose origin normalizes to the key, so the store
 * disappears from BOTH read paths (D1 freeze keeps the legacy UI working
 * until every page flips).
 */
const deleteStore = async (req, res) => {
  try {
    const key = parseStoreKey(req.params.key);
    if (!key) {
      return res.status(400).json({ success: false, message: 'Invalid store key' });
    }

    const store = await Store.findOne({ key }).lean();
    // Legacy CrawlResult docs store full origins (which may vary http/https
    // across runs) — collect the ones that normalize to this key. `distinct`
    // is fine here: origins are bounded and CrawlResult is frozen (D1).
    const origins = new Set(store?.origin ? [store.origin] : []);
    const distinct = await CrawlResult.distinct('origin');
    for (const origin of distinct) {
      if (normalizeHost(origin) === key) origins.add(origin);
    }

    const [products, snapshots, events, legacy] = await Promise.all([
      Product.deleteMany({ key }),
      Snapshot.deleteMany({ key }),
      ProductEvent.deleteMany({ key }),
      origins.size > 0
        ? CrawlResult.deleteMany({ origin: { $in: [...origins] } })
        : Promise.resolve({ deletedCount: 0 })
    ]);
    if (store) await Store.deleteOne({ key });

    res.json({
      success: true,
      data: {
        key,
        deleted: {
          products: products.deletedCount,
          snapshots: snapshots.deletedCount,
          events: events.deletedCount,
          legacy: legacy.deletedCount
        }
      }
    });
  } catch (error) {
    console.error('Delete store error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/** GET /api/stores/:key/events?since=&type=&limit= — the "what's new" change log. */
const listEvents = async (req, res) => {
  try {
    const key = parseStoreKey(req.params.key);
    if (!key) {
      return res.status(400).json({ success: false, message: 'Invalid store key' });
    }
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const filter = { key };
    const since = parseIsoDate(req.query.since);
    if (since) filter.at = { $gte: since };
    if (typeof req.query.type === 'string' && EVENT_TYPES.has(req.query.type)) {
      filter.type = req.query.type;
    }

    // Keyset pagination on `{ at: -1, _id: -1 }` (events can be many).
    const docs = await ProductEvent.find(cursorFilter(req.query.cursor, 'at', filter))
      .sort({ at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const rows = hasMore ? docs.slice(0, limit) : docs;
    const last = rows[rows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(new Date(last.at).getTime(), last._id) : null;

    res.json({ success: true, count: rows.length, data: rows, nextCursor, hasMore });
  } catch (error) {
    console.error('List events error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { listStores, getStore, listProducts, listSnapshots, listEvents, deleteStore };
