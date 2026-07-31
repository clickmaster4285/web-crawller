import {
  brandGaps,
  categoryGaps,
  competitors,
  dashboardStats,
  matchedProducts,
  priceHistory,
  workspace,
} from "@/data/mock";

export type WorkspaceAnalytics = {
  hasData: boolean;
  stats: {
    competitors: number;
    productsTracked: number;
    yourProducts: number;
    matchedProducts: number;
    missingProducts: number;
    outOfStock: number;
    yourAvgPrice: number;
    marketAvgPrice: number;
    cheapestCompetitor: string;
    mostExpensiveCompetitor: string;
  };
  competitors: Array<{
    id: string;
    name: string;
    website: string;
    lastCrawl: string;
    products: number;
    avgPriceIndex: number;
  }>;
  matchedProducts: Array<{
    id: string;
    name: string;
    competitor: string;
    competitorPrice: number;
    yourPrice: number | null;
    gap: number | null;
  }>;
  priceHistory: typeof priceHistory;
  categoryGaps: Array<{ category: string; yours: number; theirs: number }>;
  brandGaps: typeof brandGaps;
};

export function useWorkspace() {
  return { data: workspace, isLoading: false };
}

/** Demo analytics derived from the mock dataset — mirrors the shape the real
 *  crawl pipeline returns once a backend is connected. */
export function useAnalytics() {
  const analytics: WorkspaceAnalytics = {
    hasData: true,
    stats: {
      competitors: competitors.length,
      productsTracked: dashboardStats.productsMonitored,
      yourProducts: workspace.products,
      matchedProducts: dashboardStats.productsMatched,
      missingProducts: dashboardStats.onlyTheySell,
      outOfStock: dashboardStats.outOfStock,
      yourAvgPrice: dashboardStats.yourAvgPrice,
      marketAvgPrice: dashboardStats.marketAvgPrice,
      cheapestCompetitor: dashboardStats.cheapestCompetitor,
      mostExpensiveCompetitor: dashboardStats.mostExpensiveCompetitor,
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
    priceHistory,
    categoryGaps: categoryGaps.map((c) => ({
      category: c.category,
      yours: c.you,
      theirs: c.competitors,
    })),
    brandGaps,
  };

  return { data: analytics, isLoading: false };
}
