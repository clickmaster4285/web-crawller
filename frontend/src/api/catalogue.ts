import { http } from "@/lib/http";
import type { BrandGap, CategoryGap, DashboardStats } from "@/types";

export interface CatalogueData {
  categoryGaps: CategoryGap[];
  brandGaps: BrandGap[];
  stats: DashboardStats;
}

/** Fetches the catalogue analysis bundle from the server API. */
export const getCatalogueData = () =>
  http.get<CatalogueData>("/data/catalogue");
