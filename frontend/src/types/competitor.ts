import type { CrawlFrequency } from "./common";

export interface Competitor {
  id: string;
  name: string;
  website: string;
  /** Full origin URL — used to start a crawl for this competitor. */
  origin: string;
  /** True when the competitor was added manually (vs derived from a crawl). */
  manual: boolean;
  /** True for the user's own store (the special "my store" row). */
  isMine?: boolean;
  country: string;
  currency: string;
  language: string;
  industry: string;
  platform: string;
  status: "active" | "paused" | "error" | "pending";
  lastCrawl: string;
  products: number;
  newToday: number;
  priceChanges: number;
  outOfStock: number;
  /** 100 = parity with your own pricing. */
  avgPriceIndex: number;
  frequency: CrawlFrequency;
}
