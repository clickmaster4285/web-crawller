import type { Money, StockStatus } from "./common";

export interface MatchedProduct {
  id: string;
  name: string;
  brand: string;
  category: string;
  sku: string;
  gtin: string;
  yourPrice: Money | null;
  competitor: string;
  competitorPrice: Money;
  matchMethod:
    | "GTIN"
    | "SKU"
    | "URL slug"
    | "Brand + Model"
    | "AI similarity"
    | "Unmatched";
  confidence: number;
  stock: StockStatus;
  delivery: string;
  priceChange24h: number;
  rating: number;
  reviews: number;
}

export interface PricePoint {
  date: string;
  you: number;
  market: number;
  cheapest: number;
}

export interface CategoryGap {
  category: string;
  you: number;
  competitors: number;
}

export interface BrandGap {
  brand: string;
  you: number;
  competitors: number;
  trend: number;
}
