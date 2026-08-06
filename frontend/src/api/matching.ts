import { http } from "@/lib/http";
import type { MatchedProduct } from "@/types";

/** Fetches every product matched across your catalogue and competitors. */
export const getMatchedProductsData = () =>
  http.get<MatchedProduct[]>("/data/matched-products");

/**
 * A persisted match row from the Phase 3 indexed matcher (`GET /api/match`),
 * joined with the latest prices — no recomputation on page load.
 */
export interface MatchRow {
  id: string;
  /** "GTIN" | "SKU" | "URL slug" | "fuzzy" */
  method: string;
  confidence: number;
  updatedAt: number | null;
  mine: {
    productId: string;
    name: string;
    price: number | null;
    available: boolean;
    url: string;
  };
  theirs: {
    productId: string;
    name: string;
    price: number | null;
    available: boolean;
    url: string;
  };
}

/** One side's unmatched products (`onlyMine` / `onlyTheirs` list). */
export interface MatchSideList {
  total: number;
  rows: Array<{
    productId: string;
    name: string;
    price: number | null;
    available: boolean;
    url: string;
  }>;
}

/** Response of `GET /api/match?origin=…` for one competitor. */
export interface CompetitorMatches {
  competitorKey: string;
  mineOrigin: string;
  total: number;
  page: number;
  limit: number;
  rows: MatchRow[];
  /** Active your-store products the competitor doesn't carry (paginated). */
  onlyMine: MatchSideList;
  /** Active competitor products you don't carry (paginated). */
  onlyTheirs: MatchSideList;
  /** Matched pairs whose prices are both known and differ. */
  priceDifferCount: number;
}

/**
 * Paginated persisted matches for one competitor (Phase 3 read path). The
 * origin is a query param because URLs contain slashes. Null when no
 * my-store is set.
 */
export const getMatchesForCompetitor = (
  origin: string,
  params: { page?: number; limit?: number } = {},
) => {
  const qs = new URLSearchParams({ origin });
  if (params.page != null) qs.set("page", String(params.page));
  if (params.limit != null) qs.set("limit", String(params.limit));
  return http.get<{ success: boolean; data: CompetitorMatches | null }>(
    `/match?${qs.toString()}`,
  );
};
