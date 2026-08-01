/**
 * Data controller — serves the Parity demo dataset over HTTP.
 *
 * The dataset lives in `data/demo-data.json` (the backend's single source of
 * truth for the demo). Each handler returns the exact shape the frontend's
 * hooks (`useWorkspace`, `useAnalytics`, `useData`) expect, so the frontend
 * can swap from server functions to this API without page changes.
 */

const demo = require("../data/demo-data.json");

/** Bundled analytics payload consumed by the Overview page. */
function analyticsBundle() {
  return {
    hasData: true,
    stats: {
      competitors: demo.competitors.length,
      productsTracked: demo.dashboardStats.productsMonitored,
      yourProducts: demo.workspace.products,
      matchedProducts: demo.dashboardStats.productsMatched,
      missingProducts: demo.dashboardStats.onlyTheySell,
      outOfStock: demo.dashboardStats.outOfStock,
      yourAvgPrice: demo.dashboardStats.yourAvgPrice,
      marketAvgPrice: demo.dashboardStats.marketAvgPrice,
      cheapestCompetitor: demo.dashboardStats.cheapestCompetitor,
      mostExpensiveCompetitor: demo.dashboardStats.mostExpensiveCompetitor,
    },
    competitors: demo.competitors.map((c) => ({
      id: c.id,
      name: c.name,
      website: c.website,
      lastCrawl: c.lastCrawl,
      products: c.products,
      avgPriceIndex: c.avgPriceIndex,
    })),
    matchedProducts: demo.matchedProducts.map((p) => ({
      id: p.id,
      name: p.name,
      competitor: p.competitor,
      competitorPrice: p.competitorPrice,
      yourPrice: p.yourPrice,
      gap: p.yourPrice === null ? null : p.competitorPrice - p.yourPrice,
    })),
    priceHistory: demo.priceHistory,
    categoryGaps: demo.categoryGaps.map((c) => ({
      category: c.category,
      yours: c.you,
      theirs: c.competitors,
    })),
    brandGaps: demo.brandGaps,
  };
}

const ok = (res, body) => res.json(body);

module.exports = {
  workspace: (req, res) => ok(res, demo.workspace),
  analytics: (req, res) => ok(res, analyticsBundle()),
  competitors: (req, res) => ok(res, demo.competitors),
  matchedProducts: (req, res) => ok(res, demo.matchedProducts),
  pricing: (req, res) =>
    ok(res, {
      competitors: demo.competitors,
      matchedProducts: demo.matchedProducts,
      priceHistory: demo.priceHistory,
      stats: demo.dashboardStats,
    }),
  catalogue: (req, res) =>
    ok(res, {
      categoryGaps: demo.categoryGaps,
      brandGaps: demo.brandGaps,
      stats: demo.dashboardStats,
    }),
  insights: (req, res) => ok(res, demo.insights),
  alerts: (req, res) => ok(res, demo.alerts),
  reports: (req, res) => ok(res, demo.reports),
};
