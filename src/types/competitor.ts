import type { CrawlFrequency } from "./common";

export interface Competitor {
  id: string;
  name: string;
  website: string;
  country: string;
  currency: string;
  language: string;
  industry: string;
  platform: string;
  status: "active" | "paused" | "error";
  lastCrawl: string;
  products: number;
  newToday: number;
  priceChanges: number;
  outOfStock: number;
  /** 100 = parity with your own pricing. */
  avgPriceIndex: number;
  frequency: CrawlFrequency;
}
