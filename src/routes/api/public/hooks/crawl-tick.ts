import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled crawl tick. Called by the database scheduler on a fixed cadence;
 * it picks up any competitor whose next run time has passed and crawls it.
 */
export const Route = createFileRoute("/api/public/hooks/crawl-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
        if (!apiKey || !expected || apiKey !== expected) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { dueSchedules, markScheduleRun } = await import("@/services/scheduler/scheduler.server");
        const { runCrawl } = await import("@/services/crawler/crawl.server");

        const admin = supabaseAdmin as any;
        const schedules = await dueSchedules(admin, 3);
        const results = [];

        for (const schedule of schedules) {
          const competitor = schedule.competitors;
          if (!competitor || competitor.status !== "active") {
            await markScheduleRun(admin, schedule.id, schedule.cadence);
            continue;
          }
          const result = await runCrawl(admin, {
            workspaceId: schedule.workspace_id,
            competitorId: schedule.competitor_id,
            competitorName: competitor.name,
            website: competitor.website,
            maxPages: schedule.max_pages,
            currency: competitor.currency ?? "GBP",
            trigger: "scheduled",
          });
          await markScheduleRun(admin, schedule.id, schedule.cadence);
          results.push({ competitor: competitor.name, ...result });
        }

        return new Response(JSON.stringify({ ran: results.length, results }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
