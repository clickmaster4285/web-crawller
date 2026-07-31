import type { Severity } from "./common";

export type AlertType =
  "price_drop" | "price_rise" | "new_product" | "removed" | "stock" | "discount";

export interface AlertItem {
  id: string;
  type: AlertType;
  title: string;
  detail: string;
  competitor: string;
  time: string;
  severity: Severity;
}

export interface Insight {
  id: string;
  headline: string;
  body: string;
  impact: string;
  category: "pricing" | "catalogue" | "stock" | "brand";
}

export interface ReportSummary {
  id: string;
  name: string;
  period: string;
  pages: number;
  status: string;
}
