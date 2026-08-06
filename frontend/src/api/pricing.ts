import { http } from "@/lib/http";
import type {
  Competitor,
  DashboardStats,
  MatchedProduct,
  PricePoint,
} from "@/types";

export interface PricingData {
  competitors: Competitor[];
  matchedProducts: MatchedProduct[];
  priceHistory: PricePoint[];
  stats: DashboardStats;
}

/** Fetches the pricing intelligence bundle from the server API. */
export const getPricingData = () => http.get<PricingData>("/data/pricing");
