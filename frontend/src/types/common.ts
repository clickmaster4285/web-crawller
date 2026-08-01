/** Monetary amount, stored in the workspace currency (GBP for the demo workspace). */
export type Money = number;

export type CrawlFrequency = "Hourly" | "Every 6 hours" | "Daily" | "Weekly";

export type StockStatus = "In stock" | "Low stock" | "Out of stock";

export type Severity = "high" | "medium" | "low";

export interface Workspace {
  name: string;
  owner: string;
  email: string;
  site: string;
  platform: string;
  currency: string;
  language: string;
  verified: boolean;
  verificationMethod: string;
  products: number;
  categories: number;
  lastScan: string;
}

/** Aggregate dashboard stats served by the backend `/api/data/*` endpoints. */
export interface DashboardStats {
  productsMonitored: number;
  competitorsTracked: number;
  productsMatched: number;
  matchRate: number;
  priceChangesToday: number;
  newProductsToday: number;
  outOfStock: number;
  avgPriceGap: number;
  yourAvgPrice: number;
  marketAvgPrice: number;
  cheapestCompetitor: string;
  mostExpensiveCompetitor: string;
  onlyYouSell: number;
  onlyTheySell: number;
  missingCategories: number;
  missingBrands: number;
}
