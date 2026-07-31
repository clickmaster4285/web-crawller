import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const addSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  website: z.string().url().max(400),
  industry: z.string().max(120).optional(),
  country: z.string().max(80).optional(),
  currency: z.string().max(8).default("GBP"),
  cadence: z.enum(["hourly", "daily", "weekly"]).default("daily"),
  maxPages: z.number().int().min(1).max(40).default(20),
});

export const listCompetitors = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("competitors")
      .select(
        "id, name, website, country, currency, language, industry, platform, status, frequency, last_crawl_at, created_at, crawl_schedules(id, cadence, max_pages, enabled, next_run_at, last_run_at)",
      )
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const ids = (rows ?? []).map((r: any) => r.id);
    const counts = new Map<string, number>();
    if (ids.length > 0) {
      const { data: products } = await context.supabase
        .from("products")
        .select("competitor_id")
        .eq("workspace_id", data.workspaceId)
        .eq("is_active", true)
        .in("competitor_id", ids);
      for (const p of products ?? []) {
        counts.set(p.competitor_id as string, (counts.get(p.competitor_id as string) ?? 0) + 1);
      }
    }

    return (rows ?? []).map((r: any) => ({ ...r, productCount: counts.get(r.id) ?? 0 }));
  });

export const addCompetitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => addSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: competitor, error } = await context.supabase
      .from("competitors")
      .insert({
        workspace_id: data.workspaceId,
        name: data.name,
        website: data.website,
        industry: data.industry ?? null,
        country: data.country ?? null,
        currency: data.currency,
        frequency: data.cadence,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const { error: scheduleError } = await context.supabase.from("crawl_schedules").insert({
      workspace_id: data.workspaceId,
      competitor_id: competitor.id,
      cadence: data.cadence,
      max_pages: data.maxPages,
      next_run_at: new Date().toISOString(),
    });
    if (scheduleError) throw new Error(scheduleError.message);

    return { id: competitor.id as string };
  });

export const updateSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        competitorId: z.string().uuid(),
        cadence: z.enum(["hourly", "daily", "weekly"]).optional(),
        maxPages: z.number().int().min(1).max(40).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.cadence) patch.cadence = data.cadence;
    if (data.maxPages !== undefined) patch.max_pages = data.maxPages;
    if (data.enabled !== undefined) patch.enabled = data.enabled;

    const { error } = await context.supabase
      .from("crawl_schedules")
      .update(patch)
      .eq("competitor_id", data.competitorId);
    if (error) throw new Error(error.message);

    if (data.cadence) {
      await context.supabase
        .from("competitors")
        .update({ frequency: data.cadence })
        .eq("id", data.competitorId);
    }
    return { ok: true };
  });

export const deleteCompetitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { competitorId: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("competitors").delete().eq("id", data.competitorId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Crawl one competitor (or your own store) right now. */
export const runCrawlNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string; competitorId: string | null }) => input)
  .handler(async ({ data, context }) => {
    const { data: workspace, error: wsError } = await context.supabase
      .from("workspaces")
      .select("id, site_url, currency, name")
      .eq("id", data.workspaceId)
      .single();
    if (wsError || !workspace) throw new Error("Workspace not found");

    let website = workspace.site_url as string | null;
    let competitorName = workspace.name as string;
    let maxPages = 20;
    let currency = workspace.currency as string;

    if (data.competitorId) {
      const { data: competitor, error } = await context.supabase
        .from("competitors")
        .select("id, name, website, currency, crawl_schedules(max_pages)")
        .eq("id", data.competitorId)
        .single();
      if (error || !competitor) throw new Error("Competitor not found");
      website = competitor.website as string;
      competitorName = competitor.name as string;
      currency = (competitor.currency as string) ?? currency;
      const schedule = (competitor as any).crawl_schedules?.[0];
      if (schedule?.max_pages) maxPages = schedule.max_pages;
    }

    if (!website) throw new Error("Add a website URL before crawling.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runCrawl } = await import("@/services/crawler/crawl.server");

    return runCrawl(supabaseAdmin as any, {
      workspaceId: data.workspaceId,
      competitorId: data.competitorId,
      competitorName,
      website,
      maxPages,
      currency,
      trigger: "manual",
    });
  });

export const listCrawlRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("crawl_runs")
      .select("id, competitor_id, status, trigger, pages_crawled, products_found, products_changed, error, started_at, finished_at")
      .eq("workspace_id", data.workspaceId)
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
