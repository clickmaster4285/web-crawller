import { http } from "@/lib/http";
import type { BrandGap, PricePoint } from "@/types";

export interface AnalyticsData {
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
  priceHistory: PricePoint[];
  categoryGaps: Array<{ category: string; yours: number; theirs: number }>;
  brandGaps: BrandGap[];
}

/** Fetches the dashboard analytics bundle from the server API. */
export const getAnalyticsData = () =>
  http.get<AnalyticsData>("/data/analytics");
