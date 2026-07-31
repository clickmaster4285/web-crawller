import { createFileRoute } from "@tanstack/react-router";

/** Scheduled report generation for every workspace with an active cadence. */
export const Route = createFileRoute("/api/public/hooks/report-tick")({
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

        const body = (await request.json().catch(() => ({}))) as { cadence?: string };
        const cadence = (
          ["daily", "weekly", "monthly", "quarterly", "annual"].includes(body.cadence ?? "")
            ? body.cadence
            : "weekly"
        ) as "daily" | "weekly" | "monthly" | "quarterly" | "annual";

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { generateAndSaveReport } = await import("@/services/reports/reports.server");
        const admin = supabaseAdmin as any;

        const { data: workspaces } = await admin.from("workspaces").select("id").limit(200);
        let generated = 0;
        for (const workspace of workspaces ?? []) {
          try {
            await generateAndSaveReport(admin, workspace.id, cadence, []);
            generated += 1;
          } catch (error) {
            console.error(`Report failed for workspace ${workspace.id}:`, error);
          }
        }

        return new Response(JSON.stringify({ cadence, generated }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
