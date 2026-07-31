import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient<any, "public", any>;

export type ReportCadence = "daily" | "weekly" | "monthly" | "quarterly" | "annual";

const WINDOW_DAYS: Record<ReportCadence, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  annual: 365,
};

export type ReportContent = {
  windowDays: number;
  categories: string[];
  totals: {
    productsTracked: number;
    priceChanges: number;
    newProducts: number;
    removedProducts: number;
    outOfStock: number;
  };
  pricingGaps: Array<{ name: string; competitor: string; competitorPrice: number; yourPrice: number; gap: number }>;
  fastestGrowingBrands: Array<{ brand: string; added: number; total: number }>;
  missingProducts: Array<{ name: string; competitor: string; category: string | null; price: number | null }>;
  categoryBreakdown: Array<{ category: string; competitorProducts: number; yourProducts: number }>;
};

function periodLabel(cadence: ReportCadence, now: Date) {
  const days = WINDOW_DAYS[cadence];
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return cadence === "daily" ? fmt(now) : `${fmt(start)} → ${fmt(now)}`;
}

/** Build a report summarising pricing gaps, brand momentum and catalogue holes. */
export async function buildReport(
  admin: Admin,
  workspaceId: string,
  cadence: ReportCadence,
  categories: string[],
): Promise<{ name: string; period: string; content: ReportContent }> {
  const now = new Date();
  const windowDays = WINDOW_DAYS[cadence];
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: productRows }, { data: competitorRows }, { data: alertRows }] = await Promise.all([
    admin
      .from("products")
      .select("id, competitor_id, name, brand, category, price, stock, is_active, first_seen_at")
      .eq("workspace_id", workspaceId),
    admin.from("competitors").select("id, name").eq("workspace_id", workspaceId),
    admin
      .from("alerts")
      .select("type, created_at")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since),
  ]);

  const products = productRows ?? [];
  const competitorName = new Map((competitorRows ?? []).map((c: any) => [c.id, c.name as string]));
  const inScope = (category: string | null) =>
    categories.length === 0 || (category ? categories.some((c) => c.toLowerCase() === category.toLowerCase()) : false);

  const mine = products.filter((p: any) => !p.competitor_id && inScope(p.category));
  const theirs = products.filter((p: any) => p.competitor_id && p.is_active && inScope(p.category));

  const myNames = new Set(mine.map((p: any) => String(p.name).toLowerCase()));

  const pricingGaps = theirs
    .map((p: any) => {
      const match = mine.find((m: any) => String(m.name).toLowerCase() === String(p.name).toLowerCase());
      if (!match || p.price === null || match.price === null) return null;
      return {
        name: p.name as string,
        competitor: competitorName.get(p.competitor_id) ?? "Competitor",
        competitorPrice: Number(p.price),
        yourPrice: Number(match.price),
        gap: Number(p.price) - Number(match.price),
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.gap - b.gap)
    .slice(0, 10) as ReportContent["pricingGaps"];

  const brandStats = new Map<string, { added: number; total: number }>();
  for (const p of theirs) {
    const brand = (p.brand as string | null) ?? "Unbranded";
    const entry = brandStats.get(brand) ?? { added: 0, total: 0 };
    entry.total += 1;
    if (p.first_seen_at && p.first_seen_at >= since) entry.added += 1;
    brandStats.set(brand, entry);
  }
  const fastestGrowingBrands = Array.from(brandStats.entries())
    .map(([brand, s]) => ({ brand, ...s }))
    .sort((a, b) => b.added - a.added || b.total - a.total)
    .slice(0, 8);

  const missingProducts = theirs
    .filter((p: any) => !myNames.has(String(p.name).toLowerCase()))
    .slice(0, 20)
    .map((p: any) => ({
      name: p.name as string,
      competitor: competitorName.get(p.competitor_id) ?? "Competitor",
      category: (p.category as string | null) ?? null,
      price: p.price === null ? null : Number(p.price),
    }));

  const categoryMap = new Map<string, { competitorProducts: number; yourProducts: number }>();
  for (const p of [...mine, ...theirs]) {
    const key = (p.category as string | null) ?? "Uncategorised";
    const entry = categoryMap.get(key) ?? { competitorProducts: 0, yourProducts: 0 };
    if (p.competitor_id) entry.competitorProducts += 1;
    else entry.yourProducts += 1;
    categoryMap.set(key, entry);
  }

  const alerts = alertRows ?? [];
  const count = (type: string) => alerts.filter((a: any) => a.type === type).length;

  const content: ReportContent = {
    windowDays,
    categories,
    totals: {
      productsTracked: theirs.length,
      priceChanges: count("price_drop") + count("price_rise"),
      newProducts: count("new_product"),
      removedProducts: count("removed"),
      outOfStock: theirs.filter((p: any) => p.stock === "out_of_stock").length,
    },
    pricingGaps,
    fastestGrowingBrands,
    missingProducts,
    categoryBreakdown: Array.from(categoryMap.entries())
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.competitorProducts - a.competitorProducts)
      .slice(0, 12),
  };

  const label = cadence.charAt(0).toUpperCase() + cadence.slice(1);
  return {
    name: `${label} competitive summary`,
    period: periodLabel(cadence, now),
    content,
  };
}

export async function generateAndSaveReport(
  admin: Admin,
  workspaceId: string,
  cadence: ReportCadence,
  categories: string[],
) {
  const report = await buildReport(admin, workspaceId, cadence, categories);
  const { data, error } = await admin
    .from("reports")
    .insert({
      workspace_id: workspaceId,
      name: report.name,
      cadence,
      period: report.period,
      status: "ready",
      categories,
      content: report.content,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, ...report };
}
