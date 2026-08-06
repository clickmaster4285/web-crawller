import { http } from "@/lib/http";
import type { Competitor } from "@/types";

/** Lists all competitors (crawled origins + manually added). */
export const getCompetitorsData = () =>
  http.get<Competitor[]>("/data/competitors");

export interface CreateCompetitorInput {
  /** Display name; falls back to a readable name derived from the domain. */
  name: string;
  /** Full origin URL, e.g. https://store.example.com */
  origin: string;
  notes?: string;
}

/** Adds a competitor to the monitored list (persisted on the backend). */
export const createCompetitor = (input: CreateCompetitorInput) =>
  http.post<{ success: boolean; data: unknown }>("/data/competitors", input);

/** Removes a manually-added competitor (crawled origins are auto-derived). */
export const deleteCompetitor = (id: string) =>
  http.del<{
    success: boolean;
    data: { deleted: boolean; id: string; name: string };
  }>(`/data/competitors/${id}`);
