import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient<any, "public", any>;

export type Cadence = "hourly" | "daily" | "weekly";

const CADENCE_MS: Record<Cadence, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function nextRunFrom(cadence: string, from: Date = new Date()): string {
  const step = CADENCE_MS[(cadence as Cadence) in CADENCE_MS ? (cadence as Cadence) : "daily"];
  return new Date(from.getTime() + step).toISOString();
}

export type DueSchedule = {
  id: string;
  workspace_id: string;
  competitor_id: string;
  cadence: string;
  max_pages: number;
  competitors: { name: string; website: string; currency: string; status: string } | null;
};

/** Schedules whose next run time has passed. */
export async function dueSchedules(admin: Admin, limit = 5): Promise<DueSchedule[]> {
  const { data, error } = await admin
    .from("crawl_schedules")
    .select(
      "id, workspace_id, competitor_id, cadence, max_pages, competitors(name, website, currency, status)",
    )
    .eq("enabled", true)
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as DueSchedule[];
}

export async function markScheduleRun(admin: Admin, scheduleId: string, cadence: string) {
  await admin
    .from("crawl_schedules")
    .update({ last_run_at: new Date().toISOString(), next_run_at: nextRunFrom(cadence) })
    .eq("id", scheduleId);
}
