/**
 * Data controller — serves ONLY real data derived from the persisted
 * normalized collections (Store / Product / Snapshot / ProductEvent — the
 * D1 endgame: the legacy crawlresults collection is no longer read or
 * written, only its frozen data remains).
 *
 * Every handler below is either:
 *
 *   - **real** — computed from actual saved crawls (competitors, products,
 *     aggregate stats), or
 *   - **honestly empty** — features that don't have a data source yet return
 *     empty arrays / zeroed stats so pages render a "No real data yet" state
 *     instead of fake numbers.
 *
 * Connected:
 *   - matched products → real matching layer (GTIN > SKU > URL slug > fuzzy
 *     name, `utils/matcher.js`) against your own catalogue, once your store
 *     is set and crawled
 *
 * Still to connect (empty today):
 *   - workspace        → no "your store" input exists yet
 *   - category/brand gaps → needs your catalogue + matching
 *   - insights/alerts/reports → need analysis/alert/report engines
 */

const Store = require('../models/Store');
const Product = require('../models/Product');
const Snapshot = require('../models/Snapshot');
const ProductEvent = require('../models/ProductEvent');
const Competitor = require('../models/Competitor');
const MyStore = require('../models/MyStore');
const { matchCatalogues } = require('../utils/matcher');

/** "8 min ago"-style relative time from a timestamp. */
function relativeTime(ts) {
  const diff = Math.max(0, Date.now() - new Date(ts).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

/** The host of an origin, e.g. https://shop.com/products -> shop.com */
function originHost(origin) {
  try {
    return new URL(origin).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(origin).toLowerCase();
  }
}

/** A readable competitor name from an origin host. */
function originName(origin) {
  return originHost(origin)
    .split('.')[0]
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Average of a product list's prices (skips zero/unknown), or null. */
function avgPrice(products) {
  const prices = (products || [])
    .map((p) => Number(p.price))
    .filter((p) => Number.isFinite(p) && p > 0);
  return prices.length
    ? prices.reduce((a, b) => a + b, 0) / prices.length
    : null;
}

/**
 * Loads the normalized data plane in three reads:
 *   - `Store` docs (one per crawled origin — the competitor list source)
 *   - `Snapshot` docs (metadata-only crawl history, newest first)
 *   - active `Product` docs (projection — current catalogue, per store)
 *
 * The epoch-lastSeenAt filter excludes the soft-deleted junk pages from the
 * Aug 2026 purge (NOT out-of-stock rows, which are still catalogue). The
 * legacy loader pulled every snapshot's full product arrays; this pulls the
 * current state once — orders of magnitude lighter at 100+ stores.
 */
const ACTIVE_PRODUCT_FILTER = { lastSeenAt: { $gt: new Date(0) } };
const PRODUCT_PROJECTION =
  'key origin name brand price sku gtin available url currency priceUsd lastSeenAt priceHistory';

async function loadNormalizedData() {
  const [stores, snapshots, products] = await Promise.all([
    Store.find().sort({ updatedAt: -1 }).lean(),
    Snapshot.find().sort({ finishedAt: -1 }).lean(),
    Product.find(ACTIVE_PRODUCT_FILTER).select(PRODUCT_PROJECTION).lean()
  ]);
  const byKey = new Map();
  for (const p of products) {
    const arr = byKey.get(p.key) ?? [];
    arr.push(p);
    byKey.set(p.key, arr);
  }
  // The newest snapshot per store (for status + stats where the live Store
  // record isn't authoritative) — snapshots are already newest-first.
  const latestSnapshotByKey = new Map();
  for (const s of snapshots) {
    if (!latestSnapshotByKey.has(s.key)) latestSnapshotByKey.set(s.key, s);
  }
  return { stores, snapshots, byKey, latestSnapshotByKey };
}

/**
 * Builds the market price time-series from the normalized history. Each
 * `Snapshot` is one store's crawl at one point in time; a store's average at
 * that time is computed from its CURRENT products' `priceHistory` (the latest
 * point at or before the snapshot's finish time — the capped series on each
 * product). Events are walked oldest → newest and at each event the latest
 * known average for every store contributes to the market average / cheapest
 * lines — the series reflects what was known at that moment. `you` is the
 * user's own store average (when their store has been crawled), otherwise
 * null. Same-date events coalesce into a single point.
 *
 * Note: products soft-removed from the current catalogue no longer carry
 * their history here, so a store's earliest averages may be slightly higher
 * than the legacy (frozen-snapshot) series — an accepted approximation; the
 * shape and semantics are identical.
 */
function computePriceHistory(snapshots, byKey, myStoreHost) {
  const events = [];
  for (const snap of snapshots) {
    const host = originHost(snap.origin);
    const products = byKey.get(snap.key) ?? [];
    const t = new Date(snap.finishedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const prices = [];
    for (const p of products) {
      const pts = p.priceHistory ?? [];
      let price = null;
      // priceHistory is appended in time order — walk backwards for the
      // latest point known at snapshot time.
      for (let i = pts.length - 1; i >= 0; i--) {
        const ptT = new Date(pts[i].t).getTime();
        if (ptT <= t) {
          price = pts[i].price;
          break;
        }
      }
      if (price != null && Number.isFinite(price) && price > 0) prices.push(price);
    }
    if (prices.length === 0) continue;
    events.push({
      t,
      host,
      avg: prices.reduce((a, b) => a + b, 0) / prices.length
    });
  }
  events.sort((a, b) => a.t - b.t);
  const latestAvg = new Map();
  const points = [];
  for (const ev of events) {
    latestAvg.set(ev.host, ev.avg);
    const values = [...latestAvg.values()];
    const round2 = (n) => Math.round(n * 100) / 100;
    const point = {
      date: new Date(ev.t).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
      }),
      you:
        myStoreHost && latestAvg.has(myStoreHost)
          ? round2(latestAvg.get(myStoreHost))
          : null,
      market: round2(values.reduce((a, b) => a + b, 0) / values.length),
      cheapest: round2(Math.min(...values)),
    };
    const prev = points[points.length - 1];
    if (prev && prev.date === point.date) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}

/**
 * Computes competitor rows: one per crawled `Store`, merged with the
 * manually-added `Competitor` docs (which may not have been crawled yet) and
 * the user's own store (a special "my store" row, `isMine: true`).
 */
function computeCompetitors(stores, byKey, latestSnapshotByKey, manual, myStore) {
  const manualByHost = new Map();
  for (const m of manual) {
    manualByHost.set(originHost(m.origin), m);
  }
  const myStoreHost = myStore && myStore.origin ? originHost(myStore.origin) : null;
  const competitors = [];
  const crawledHosts = new Set();
  // Market-relative price index: each crawled store's average product price
  // vs the average of every crawled store (index 100 = at market level).
  const storeAvg = new Map();
  for (const store of stores) {
    const a = avgPrice(byKey.get(store.key) ?? []);
    if (a != null) storeAvg.set(originHost(store.origin), a);
  }
  const marketAvg =
    storeAvg.size > 0
      ? [...storeAvg.values()].reduce((a, b) => a + b, 0) / storeAvg.size
      : 0;
  for (const store of stores) {
    const host = originHost(store.origin);
    crawledHosts.add(host);
    const products = byKey.get(store.key) ?? [];
    const latest = latestSnapshotByKey.get(store.key);
    const manualDoc = manualByHost.get(host);
    const isMine = !!myStoreHost && host === myStoreHost;
    const avgPriceIndex =
      marketAvg > 0 && storeAvg.has(host)
        ? Math.round((storeAvg.get(host) / marketAvg) * 100)
        : 100;
    competitors.push({
      id: isMine ? 'my-store' : manualDoc ? String(manualDoc._id) : `crawl-${host}`,
      name: isMine
        ? myStore.name || 'My store'
        : manualDoc
          ? manualDoc.name
          : originName(store.origin),
      origin: store.origin,
      manual: isMine ? false : !!manualDoc,
      isMine,
      website: host,
      country: '—',
      currency: '—',
      language: '—',
      industry: 'E-commerce',
      platform:
        (store.platform && store.platform.platform) || 'Unknown',
      // A store whose last run fetched nothing (WAF-blocked) reads 'error'.
      status:
        latest && (latest.stats?.fetched ?? 0) > 0 ? 'active' : 'error',
      lastCrawl: relativeTime(store.lastCrawl?.at ?? store.updatedAt),
      products: products.length,
      newToday: 0,
      priceChanges: 0,
      outOfStock: products.filter((p) => p.available === false).length,
      avgPriceIndex,
      frequency: 'Daily',
    });
  }
  // Manually-added competitors that haven't been crawled yet.
  for (const [host, m] of manualByHost) {
    if (crawledHosts.has(host)) continue;
    competitors.push({
      id: String(m._id),
      name: m.name,
      origin: m.origin,
      manual: true,
      isMine: false,
      website: host,
      country: '—',
      currency: '—',
      language: '—',
      industry: 'E-commerce',
      platform: '—',
      status: 'pending',
      lastCrawl: 'Not crawled yet',
      products: 0,
      newToday: 0,
      priceChanges: 0,
      outOfStock: 0,
      avgPriceIndex: 100,
      frequency: 'Daily',
    });
  }
  // The user's own store, set but not crawled yet.
  if (myStoreHost && !crawledHosts.has(myStoreHost)) {
    competitors.push({
      id: 'my-store',
      name: myStore.name || 'My store',
      origin: myStore.origin,
      manual: false,
      isMine: true,
      website: myStoreHost,
      country: '—',
      currency: '—',
      language: '—',
      industry: 'E-commerce',
      platform: '—',
      status: 'pending',
      lastCrawl: 'Not crawled yet',
      products: 0,
      newToday: 0,
      priceChanges: 0,
      outOfStock: 0,
      avgPriceIndex: 100,
      frequency: 'Daily',
    });
  }
  return competitors.sort((a, b) => b.products - a.products);
}

/**
 * The real product-matching layer (GTIN > SKU > URL slug > fuzzy name).
 *
 * Compares the user's own catalogue (their store's current products) against
 * every competitor's via `utils/matcher.js`, and returns the flat
 * MatchedProduct row list plus aggregate counts. Honestly empty (rows: [])
 * when no my-store is set or their store hasn't been crawled yet — the page
 * renders its "no real data" state instead of fabricated matches.
 */
function computeMatching(stores, byKey, manual, myStore) {
  const result = {
    rows: [],
    yourProducts: 0,
    matchedCount: 0,
    onlyYouSell: 0,
    onlyTheySell: 0,
    matchRate: 0,
    avgPriceGap: null,
  };
  const myStoreHost =
    myStore && myStore.origin ? originHost(myStore.origin) : null;
  const productsByHost = new Map();
  for (const store of stores) {
    productsByHost.set(originHost(store.origin), byKey.get(store.key) ?? []);
  }
  const mine = myStoreHost ? productsByHost.get(myStoreHost) ?? [] : [];
  result.yourProducts = mine.length;
  const matchedMine = new Set();
  const gaps = [];
  const manualByHost = new Map(
    manual.map((m) => [originHost(m.origin), m])
  );
  const rowBase = (t) => ({
    brand: t.brand || 'Unknown',
    category: 'Uncategorised',
    sku: t.sku || '',
    gtin: t.gtin || '',
    competitorPrice: t.price || 0,
    stock: t.available === false ? 'Out of stock' : 'In stock',
    delivery: '—',
    priceChange24h: 0,
    rating: 0,
    reviews: 0,
  });

  for (const [host, theirs] of productsByHost) {
    if (host === myStoreHost) continue;
    if (theirs.length === 0) continue;
    const competitorName = manualByHost.has(host)
      ? manualByHost.get(host).name
      : originName(host);

    const { matched, onlyTheirs } = matchCatalogues(mine, theirs);
    for (const pair of matched) {
      matchedMine.add(pair.mine);
      const yourPrice = pair.mine.price > 0 ? pair.mine.price : null;
      result.rows.push({
        id: `match-${host}-${result.rows.length}`,
        name: pair.theirs.name,
        yourPrice,
        competitor: competitorName,
        matchMethod: pair.method,
        confidence: pair.confidence,
        ...rowBase(pair.theirs),
      });
      if (yourPrice != null && (pair.theirs.price || 0) > 0) {
        gaps.push((pair.theirs.price || 0) - yourPrice);
      }
    }
    // Competitor products you don't carry — shown as "you don't sell".
    for (const t of onlyTheirs) {
      result.rows.push({
        id: `unmatched-${host}-${result.rows.length}`,
        name: t.name,
        yourPrice: null,
        competitor: competitorName,
        matchMethod: 'Unmatched',
        confidence: 0,
        ...rowBase(t),
      });
    }
    result.onlyTheySell += onlyTheirs.length;
  }

  result.matchedCount = matchedMine.size;
  result.onlyYouSell = mine.length - matchedMine.size;
  result.matchRate =
    result.yourProducts > 0
      ? Math.round((matchedMine.size / result.yourProducts) * 100)
      : 0;
  result.avgPriceGap = gaps.length
    ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 100) / 100
    : null;
  return result;
}

/** Zeroed matching aggregate for pages without your-catalogue data. */
function emptyMatching() {
  return {
    rows: [],
    yourProducts: 0,
    matchedCount: 0,
    onlyYouSell: 0,
    onlyTheySell: 0,
    matchRate: 0,
    avgPriceGap: null,
  };
}

/**
 * Flattens every competitor's (non-my-store) products for market stats —
 * market averages are independent of whether the user's store is set yet.
 */
function computeMarketProducts(stores, byKey, manual, myStoreHost) {
  const manualByHost = new Map(
    manual.map((m) => [originHost(m.origin), m])
  );
  const out = [];
  for (const store of stores) {
    const host = originHost(store.origin);
    if (myStoreHost && host === myStoreHost) continue;
    const name = manualByHost.has(host)
      ? manualByHost.get(host).name
      : originName(host);
    for (const p of byKey.get(store.key) ?? []) {
      out.push({ name: p.name, competitor: name, competitorPrice: p.price || 0 });
    }
  }
  return out;
}

/** Aggregate stats derived purely from saved crawls + the matching layer. */
function computeDashboardStats(competitors, matching, marketProducts) {
  const avg = (prices) =>
    prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  // Market figures (cheapest/most-expensive/avg) come from every crawled
  // competitor product — they don't depend on your own catalogue existing.
  const perCompetitorAvg = competitors.map((c) => ({
    name: c.name,
    avg: avg(
      (marketProducts || [])
        .filter((p) => p.competitor === c.name)
        .map((p) => p.competitorPrice),
    ),
  }));
  const withAvg = perCompetitorAvg.filter((c) => c.avg > 0);
  const cheapest = withAvg.length
    ? withAvg.reduce((a, b) => (a.avg < b.avg ? a : b)).name
    : '—';
  const mostExpensive = withAvg.length
    ? withAvg.reduce((a, b) => (a.avg > b.avg ? a : b)).name
    : '—';
  const prices = (marketProducts || []).map((p) => p.competitorPrice);

  return {
    productsMonitored: matching.rows.length,
    competitorsTracked: competitors.length,
    productsMatched: matching.matchedCount,
    matchRate: matching.matchRate,
    priceChangesToday: 0,
    newProductsToday: 0,
    outOfStock: competitors.reduce((sum, c) => sum + c.outOfStock, 0),
    avgPriceGap: matching.avgPriceGap ?? 0,
    yourAvgPrice: 0,
    marketAvgPrice: Math.round(avg(prices) * 100) / 100,
    cheapestCompetitor: cheapest,
    mostExpensiveCompetitor: mostExpensive,
    onlyYouSell: matching.onlyYouSell,
    onlyTheySell: matching.onlyTheySell,
    missingCategories: 0,
    missingBrands: 0,
  };
}

/**
 * "Biggest price movements" for the Pricing page — the price_changed change
 * log (ProductEvent), newest first, mapped to {origin, name, url, first,
 * latest, change} and sorted by absolute change. This replaces the old
 * client-side computation over full snapshot product arrays (D1: snapshots
 * no longer carry products).
 */
async function loadPriceMovements() {
  const events = await ProductEvent.find({ type: 'price_changed' })
    .sort({ at: -1 })
    .limit(500)
    .select('origin name url old new')
    .lean();
  const out = [];
  for (const e of events) {
    const first = e.old?.price;
    const latest = e.new?.price;
    if (typeof first !== 'number' || typeof latest !== 'number') continue;
    out.push({
      origin: e.origin,
      name: e.name,
      url: e.url,
      first,
      latest,
      change: latest - first,
    });
  }
  return out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

/** Manually-added competitor docs, newest first. */
async function loadManualCompetitors() {
  return Competitor.find({}).sort({ createdAt: -1 });
}

/** The user's own store doc (single document), or null when unset. */
async function loadMyStore() {
  return MyStore.findById(MyStore.MY_STORE_ID);
}

/** The user's own store's average price (null when unset / not crawled). */
function yourAvgPrice(stores, byKey, myStoreHost) {
  if (!myStoreHost) return null;
  const mine = stores.find((s) => originHost(s.origin) === myStoreHost);
  return mine ? avgPrice(byKey.get(mine.key) ?? []) : null;
}

/** Every route handler below. */
const dataController = {
  async workspace(req, res) {
    // No "your store" source exists yet — return an empty-but-well-shaped
    // workspace so the app shell shows "—" and the Sources page shows zeros.
    res.json({
      name: '',
      owner: '',
      email: '',
      site: '',
      platform: '—',
      currency: '—',
      language: '—',
      verified: false,
      verificationMethod: '',
      products: 0,
      categories: 0,
      lastScan: '—',
    });
  },

  async analytics(req, res) {
    const { stores, snapshots, byKey, latestSnapshotByKey } =
      await loadNormalizedData();
    const myStore = await loadMyStore();
    const manual = await loadManualCompetitors();
    const myStoreHost =
      myStore && myStore.origin ? originHost(myStore.origin) : null;
    const matching = computeMatching(stores, byKey, manual, myStore);
    const competitors = computeCompetitors(
      stores,
      byKey,
      latestSnapshotByKey,
      manual,
      myStore
    );
    const marketProducts = computeMarketProducts(stores, byKey, manual, myStoreHost);
    const stats = computeDashboardStats(competitors, matching, marketProducts);
    // Real "your price" — the user's own store's average product price.
    const mineAvg = yourAvgPrice(stores, byKey, myStoreHost);
    if (mineAvg != null) stats.yourAvgPrice = Math.round(mineAvg * 100) / 100;
    res.json({
      hasData: competitors.length > 0,
      stats: {
        competitors: stats.competitorsTracked,
        productsTracked: stats.productsMonitored,
        yourProducts: matching.yourProducts,
        matchedProducts: stats.productsMatched,
        missingProducts: stats.onlyTheySell,
        outOfStock: stats.outOfStock,
        yourAvgPrice: stats.yourAvgPrice,
        marketAvgPrice: stats.marketAvgPrice,
        cheapestCompetitor: stats.cheapestCompetitor,
        mostExpensiveCompetitor: stats.mostExpensiveCompetitor,
      },
      competitors: competitors.map((c) => ({
        id: c.id,
        name: c.name,
        website: c.website,
        lastCrawl: c.lastCrawl,
        products: c.products,
        avgPriceIndex: c.avgPriceIndex,
      })),
      matchedProducts: matching.rows.map((p) => ({
        id: p.id,
        name: p.name,
        competitor: p.competitor,
        competitorPrice: p.competitorPrice,
        yourPrice: p.yourPrice,
        gap: p.yourPrice === null ? null : p.competitorPrice - p.yourPrice,
      })),
      priceHistory: computePriceHistory(snapshots, byKey, myStoreHost),
      categoryGaps: [], // needs your catalogue + matching
      brandGaps: [], // needs your catalogue + matching
    });
  },

  async competitors(req, res) {
    const { stores, byKey, latestSnapshotByKey } = await loadNormalizedData();
    res.json(
      computeCompetitors(
        stores,
        byKey,
        latestSnapshotByKey,
        await loadManualCompetitors(),
        await loadMyStore()
      )
    );
  },

  async matchedProducts(req, res) {
    const { stores, byKey } = await loadNormalizedData();
    res.json(
      computeMatching(
        stores,
        byKey,
        await loadManualCompetitors(),
        await loadMyStore()
      ).rows
    );
  },

  async pricing(req, res) {
    const { stores, snapshots, byKey, latestSnapshotByKey } =
      await loadNormalizedData();
    const myStore = await loadMyStore();
    const manual = await loadManualCompetitors();
    const myStoreHost =
      myStore && myStore.origin ? originHost(myStore.origin) : null;
    const matching = computeMatching(stores, byKey, manual, myStore);
    const competitors = computeCompetitors(
      stores,
      byKey,
      latestSnapshotByKey,
      manual,
      myStore
    );
    const marketProducts = computeMarketProducts(stores, byKey, manual, myStoreHost);
    const stats = computeDashboardStats(competitors, matching, marketProducts);
    // Real "your price" — the user's own store's average product price.
    const mineAvg = yourAvgPrice(stores, byKey, myStoreHost);
    if (mineAvg != null) stats.yourAvgPrice = Math.round(mineAvg * 100) / 100;
    res.json({
      competitors,
      matchedProducts: matching.rows,
      priceHistory: computePriceHistory(snapshots, byKey, myStoreHost),
      // D1: the page's "biggest price movements" now comes from the change
      // log instead of diffing full snapshot product arrays client-side.
      priceMovements: await loadPriceMovements(),
      stats,
    });
  },

  async catalogue(req, res) {
    const { stores, byKey, latestSnapshotByKey } = await loadNormalizedData();
    const myStore = await loadMyStore();
    const manual = await loadManualCompetitors();
    const myStoreHost =
      myStore && myStore.origin ? originHost(myStore.origin) : null;
    const competitors = computeCompetitors(
      stores,
      byKey,
      latestSnapshotByKey,
      manual,
      myStore
    );
    const marketProducts = computeMarketProducts(stores, byKey, manual, myStoreHost);
    res.json({
      categoryGaps: [], // needs your catalogue + matching
      brandGaps: [], // needs your catalogue + matching
      stats: computeDashboardStats(competitors, emptyMatching(), marketProducts),
    });
  },

  // No analysis engine yet — honest empty arrays.
  async insights(req, res) {
    res.json([]);
  },

  // Alerts moved to controllers/alertsController.js (Phase 4) — the feed is
  // derived from ProductEvent rows with per-user read/dismiss state.

  async reports(req, res) {
    res.json([]);
  },
};

module.exports = dataController;
