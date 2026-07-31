import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("reports")
      .select("id, name, cadence, period, status, categories, content, generated_at")
      .eq("workspace_id", data.workspaceId)
      .order("generated_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const generateReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        cadence: z.enum(["daily", "weekly", "monthly", "quarterly", "annual"]),
        categories: z.array(z.string().max(120)).max(50).default([]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: workspace, error } = await context.supabase
      .from("workspaces")
      .select("id")
      .eq("id", data.workspaceId)
      .single();
    if (error || !workspace) throw new Error("Workspace not found");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { generateAndSaveReport } = await import("@/services/reports/reports.server");
    return generateAndSaveReport(supabaseAdmin as any, data.workspaceId, data.cadence, data.categories);
  });

export const deleteReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("reports").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
