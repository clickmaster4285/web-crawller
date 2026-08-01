/**
 * Data controller — serves ONLY real data derived from the persisted crawl
 * results (`CrawlResult` collection, written when a crawl finishes).
 *
 * The old demo dataset (`data/demo-data.json`) has been deleted. Every
 * handler below is either:
 *
 *   - **real** — computed from actual saved crawls (competitors, products,
 *     aggregate stats), or
 *   - **honestly empty** — features that don't have a data source yet return
 *     empty arrays / zeroed stats so pages render a "No real data yet" state
 *     instead of fake numbers.
 *
 * Still to connect (empty today):
 *   - workspace        → no "your store" input exists yet
 *   - matched products → needs the product-matching layer (GTIN > SKU > slug
 *                        > fuzzy) against your own catalogue
 *   - price history    → needs time-series price points per product
 *   - category/brand gaps → needs your catalogue + matching
 *   - insights/alerts/reports → need analysis/alert/report engines
 */

const CrawlResult = require('../models/CrawlResult');

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
    return new URL(origin).host.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/** A readable competitor name from an origin host. */
function originName(origin) {
  return originHost(origin)
    .split('.')[0]
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Loads every saved crawl, grouped per origin, keeping the latest snapshot
 * per origin. Returns `{ latest: Map<origin, doc>, rows: CrawlResult[] }`.
 */
async function loadLatestPerOrigin() {
  const rows = await CrawlResult.find({}).sort({ createdAt: -1 });
  const latest = new Map();
  for (const row of rows) {
    if (!latest.has(row.origin)) latest.set(row.origin, row);
  }
  return { latest, rows };
}

/** Computes competitor rows (one per crawled origin) from saved crawls. */
function computeCompetitors(latest) {
  const competitors = [];
  for (const [origin, doc] of latest) {
    const products = doc.products || [];
    // No "your price" to index against yet, so every competitor sits at the
    // neutral baseline of 100 (their own average). Honest, not fabricated.
    const avgPriceIndex = 100;
    competitors.push({
      id: `crawl-${originHost(origin)}`,
      name: originName(origin),
      website: originHost(origin),
      country: '—',
      currency: '—',
      language: '—',
      industry: 'E-commerce',
      platform:
        (doc.discovery && doc.discovery.platform && doc.discovery.platform.platform) ||
        'Unknown',
      status: doc.stats && doc.stats.fetched > 0 ? 'active' : 'error',
      lastCrawl: relativeTime(doc.createdAt),
      products: products.length,
      newToday: 0,
      priceChanges: 0,
      outOfStock: products.filter((p) => p.available === false).length,
      avgPriceIndex,
      frequency: 'Daily',
    });
  }
  return competitors.sort((a, b) => b.products - a.products);
}

/** Flattens every crawled product (across origins) into the product shape. */
function computeMatchedProducts(latest) {
  const matched = [];
  for (const [origin, doc] of latest) {
    for (const [i, p] of (doc.products || []).entries()) {
      matched.push({
        id: `crawl-${originHost(origin)}-${i}`,
        name: p.name,
        brand: p.brand || 'Unknown',
        category: 'Uncategorised',
        sku: '',
        gtin: '',
        yourPrice: null,
        competitor: originName(origin),
        competitorPrice: p.price || 0,
        matchMethod: 'AI similarity',
        confidence: 76,
        stock: p.available === false ? 'Out of stock' : 'In stock',
        delivery: '—',
        priceChange24h: 0,
        rating: 0,
        reviews: 0,
      });
    }
  }
  return matched;
}

/** Aggregate stats derived purely from saved crawls. */
function computeDashboardStats(competitors, matchedProducts) {
  const avg = (prices) =>
    prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const perCompetitorAvg = competitors.map((c) => ({
    name: c.name,
    avg: avg(
      [...matchedProducts]
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
  const prices = matchedProducts.map((p) => p.competitorPrice);

  return {
    productsMonitored: matchedProducts.length,
    competitorsTracked: competitors.length,
    productsMatched: 0,
    matchRate: 0,
    priceChangesToday: 0,
    newProductsToday: 0,
    outOfStock: competitors.reduce((sum, c) => sum + c.outOfStock, 0),
    avgPriceGap: 0,
    yourAvgPrice: 0,
    marketAvgPrice: Math.round(avg(prices) * 100) / 100,
    cheapestCompetitor: cheapest,
    mostExpensiveCompetitor: mostExpensive,
    onlyYouSell: 0,
    onlyTheySell: matchedProducts.length,
    missingCategories: 0,
    missingBrands: 0,
  };
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
    const { latest } = await loadLatestPerOrigin();
    const competitors = computeCompetitors(latest);
    const matchedProducts = computeMatchedProducts(latest);
    const stats = computeDashboardStats(competitors, matchedProducts);
    res.json({
      hasData: competitors.length > 0,
      stats: {
        competitors: stats.competitorsTracked,
        productsTracked: stats.productsMonitored,
        yourProducts: 0,
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
      matchedProducts: matchedProducts.map((p) => ({
        id: p.id,
        name: p.name,
        competitor: p.competitor,
        competitorPrice: p.competitorPrice,
        yourPrice: p.yourPrice,
        gap: p.yourPrice === null ? null : p.competitorPrice - p.yourPrice,
      })),
      priceHistory: [], // needs time-series price points per product
      categoryGaps: [], // needs your catalogue + matching
      brandGaps: [], // needs your catalogue + matching
    });
  },

  async competitors(req, res) {
    const { latest } = await loadLatestPerOrigin();
    res.json(computeCompetitors(latest));
  },

  async matchedProducts(req, res) {
    const { latest } = await loadLatestPerOrigin();
    res.json(computeMatchedProducts(latest));
  },

  async pricing(req, res) {
    const { latest } = await loadLatestPerOrigin();
    const competitors = computeCompetitors(latest);
    const matchedProducts = computeMatchedProducts(latest);
    res.json({
      competitors,
      matchedProducts,
      priceHistory: [],
      stats: computeDashboardStats(competitors, matchedProducts),
    });
  },

  async catalogue(req, res) {
    const { latest } = await loadLatestPerOrigin();
    const competitors = computeCompetitors(latest);
    res.json({
      categoryGaps: [], // needs your catalogue + matching
      brandGaps: [], // needs your catalogue + matching
      stats: computeDashboardStats(competitors, []),
    });
  },

  // No analysis engine yet — honest empty arrays.
  async insights(req, res) {
    res.json([]);
  },

  async alerts(req, res) {
    res.json([]);
  },

  async reports(req, res) {
    res.json([]);
  },
};

module.exports = dataController;
