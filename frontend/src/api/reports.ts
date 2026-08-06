import { http } from "@/lib/http";
import type { ReportSummary } from "@/types";

/** Fetches report summaries (empty until the reporting engine lands). */
export const getReportsData = () => http.get<ReportSummary[]>("/data/reports");
