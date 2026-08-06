import { http } from "@/lib/http";
import type { AlertsData, AlertType } from "@/types";

/** Query params for the paginated alerts feed. */
export interface AlertsQuery {
  /** UI alert-type filter — `all` (default) or an AlertType. */
  type?: AlertType | "all";
  page?: number;
  limit?: number;
}

const emptyData: AlertsData = {
  alerts: [],
  total: 0,
  unreadCount: 0,
  hasAnyEvents: false,
  page: 1,
  limit: 25,
};

/** Fetches the paginated alert feed (Phase 4 — derived from ProductEvent). */
export const getAlertsData = async (query: AlertsQuery = {}) => {
  const params = new URLSearchParams();
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.page) params.set("page", String(query.page));
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  const res = await http.get<{ success: boolean; data: AlertsData }>(
    `/data/alerts${qs ? `?${qs}` : ""}`,
  );
  return res.data ?? emptyData;
};

/** Marks a single alert read (clicking it). */
export const markAlertRead = (eventId: string) =>
  http.post<{ success: boolean; data: { eventId: string; read: boolean } }>(
    "/data/alerts/read",
    { eventId },
  );

/** Marks every alert read. */
export const markAllAlertsRead = () =>
  http.post<{ success: boolean; data: { read: number } }>(
    "/data/alerts/read-all",
  );

/** Dismisses an alert (removes it from the feed). */
export const dismissAlert = (eventId: string) =>
  http.post<{
    success: boolean;
    data: { eventId: string; dismissed: boolean };
  }>("/data/alerts/dismiss", { eventId });
