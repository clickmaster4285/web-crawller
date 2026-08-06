import type { Severity } from "./common";

/**
 * Alert types emitted by the Phase 4 alerts engine. Derived directly from
 * ProductEvent rows at ingest: added → new_product, removed → removed,
 * price_changed → price_drop/price_rise, stock_changed → stock.
 */
export type AlertType =
  "price_drop" | "price_rise" | "new_product" | "removed" | "stock";

/** One alert in the feed (a mapped ProductEvent + the user's read state). */
export interface AlertItem {
  /** ProductEvent id — the read/dismiss key. */
  id: string;
  type: AlertType;
  title: string;
  detail: string;
  /** Store key (normalized host), e.g. `store.example.com`. */
  competitor: string;
  /** ISO timestamp of the event. */
  time: string;
  severity: Severity;
  /** True once the user read or dismissed this alert. */
  read: boolean;
  /** True when the user dismissed it (hidden from the list). */
  dismissed: boolean;
  /** Store origin URL (for the external-link affordance). */
  storeUrl: string;
  /** Product URL on the competitor store. */
  productUrl: string;
  /** Signed % price change (drop negative, rise positive); null when N/A. */
  priceChangePct: number | null;
  /** Signed price change (new − old); null when N/A. */
  priceChangeAmount: number | null;
}

/** `GET /api/data/alerts` payload. */
export interface AlertsData {
  alerts: AlertItem[];
  /** Total alerts matching the current filter (dismissed excluded). */
  total: number;
  /** Total unread across the whole feed (not just the current page). */
  unreadCount: number;
  /** Whether ANY ProductEvent exists — distinguishes "no crawls yet" from
   *  "everything dismissed/filtered" for the empty state. */
  hasAnyEvents: boolean;
  page: number;
  limit: number;
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
