import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type WorkspaceRow = {
  id: string;
  name: string;
  site_url: string | null;
  platform: string | null;
  currency: string;
  language: string;
  verified: boolean;
  verification_method: string | null;
  last_scan_at: string | null;
};

export const getWorkspace = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, name, site_url, platform, currency, language, verified, verification_method, last_scan_at")
      .eq("owner_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (data) return data as WorkspaceRow;

    const { data: created, error: createError } = await supabase
      .from("workspaces")
      .insert({ owner_id: userId, name: "My workspace" })
      .select("id, name, site_url, platform, currency, language, verified, verification_method, last_scan_at")
      .single();
    if (createError) throw new Error(createError.message);
    return created as WorkspaceRow;
  });

export const updateWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; name?: string; site_url?: string; platform?: string; currency?: string; language?: string }) => input)
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    const { error } = await context.supabase.from("workspaces").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
