import { http } from "@/lib/http";
import type {
  Competitor,
  DashboardStats,
  MatchedProduct,
  PricePoint,
} from "@/types";

/** A product whose price moved between two crawls (from the change log). */
export interface PriceMovement {
  origin: string;
  name: string;
  url: string;
  first: number;
  latest: number;
  change: number;
}

export interface PricingData {
  competitors: Competitor[];
  matchedProducts: MatchedProduct[];
  priceHistory: PricePoint[];
  /** Biggest price movements — derived server-side from ProductEvent rows
   *  (D1: snapshots no longer carry product arrays to diff in the browser). */
  priceMovements: PriceMovement[];
  stats: DashboardStats;
}

/** Fetches the pricing intelligence bundle from the server API. */
export const getPricingData = () => http.get<PricingData>("/data/pricing");
