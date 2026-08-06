import { http } from "@/lib/http";

/** The user's own store (single document) — used to compare against competitors. */
export interface MyStore {
  origin: string;
  name: string;
}

/** Reads the user's own store selection (null when unset). */
export const getMyStoreData = () =>
  http.get<{ success: boolean; data: MyStore | null }>("/data/my-store");

/** Sets (upserts) the user's own store selection. */
export const setMyStoreData = (input: { origin: string; name?: string }) =>
  http.put<{ success: boolean; data: MyStore }>("/data/my-store", input);
