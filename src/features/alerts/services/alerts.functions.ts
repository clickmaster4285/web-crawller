import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listAlerts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("alerts")
      .select("id, type, title, detail, severity, read_at, created_at, competitor_id, product_id")
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const listAlertRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("alert_rules")
      .select("id, type, enabled, threshold_pct, categories")
      .eq("workspace_id", data.workspaceId)
      .order("type", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const updateAlertRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        type: z.enum(["price_drop", "price_rise", "stock", "new_product", "removed"]),
        enabled: z.boolean().optional(),
        thresholdPct: z.number().min(0).max(100).optional(),
        categories: z.array(z.string().max(120)).max(50).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: { enabled?: boolean; threshold_pct?: number; categories?: string[] } = {};
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.thresholdPct !== undefined) patch.threshold_pct = data.thresholdPct;
    if (data.categories !== undefined) patch.categories = data.categories;

    const { error } = await context.supabase
      .from("alert_rules")
      .upsert(
        { workspace_id: data.workspaceId, type: data.type, ...patch },
        { onConflict: "workspace_id,type" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markAlertsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("alerts")
      .update({ read_at: new Date().toISOString() })
      .eq("workspace_id", data.workspaceId)
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
