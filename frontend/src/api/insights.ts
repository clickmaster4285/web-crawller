import { http } from "@/lib/http";
import type { Insight } from "@/types";

/** Fetches AI-generated insights (empty until the analysis engine lands). */
export const getInsightsData = () => http.get<Insight[]>("/data/insights");
