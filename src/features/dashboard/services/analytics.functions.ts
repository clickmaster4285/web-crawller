import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ProductRow = {
  id: string;
  competitor_id: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  sku: string | null;
  url: string | null;
  image_url: string | null;
  price: number | null;
  currency: string;
  stock: string;
  is_active: boolean;
  first_seen_at: string;
  last_seen_at: string;
};

type Snapshot = { product_id: string; price: number | null; captured_at: string };

async function loadWorkspaceData(supabase: any, workspaceId: string) {
  const [{ data: products }, { data: competitors }, { data: snapshots }] = await Promise.all([
    supabase
      .from("products")
      .select(
        "id, competitor_id, name, brand, category, sku, url, image_url, price, currency, stock, is_active, first_seen_at, last_seen_at",
      )
      .eq("workspace_id", workspaceId),
    supabase.from("competitors").select("id, name, website, currency, frequency, last_crawl_at").eq("workspace_id", workspaceId),
    supabase
      .from("price_snapshots")
      .select("product_id, price, captured_at")
      .eq("workspace_id", workspaceId)
      .gte("captured_at", new Date(Date.now() - 30 * 864e5).toISOString())
      .order("captured_at", { ascending: true })
      .limit(5000),
  ]);

  return {
    products: ((products ?? []) as any[]).map((p) => ({
      ...p,
      price: p.price === null ? null : Number(p.price),
    })) as ProductRow[],
    competitors: (competitors ?? []) as any[],
    snapshots: ((snapshots ?? []) as any[]).map((s) => ({
      ...s,
      price: s.price === null ? null : Number(s.price),
    })) as Snapshot[],
  };
}

function matchKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Everything the dashboard, product, pricing and catalogue views need. */
export const getWorkspaceAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { workspaceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { products, competitors, snapshots } = await loadWorkspaceData(
      context.supabase,
      data.workspaceId,
    );

    const competitorName = new Map(competitors.map((c) => [c.id as string, c.name as string]));
    const mine = products.filter((p) => !p.competitor_id);
    const theirs = products.filter((p) => p.competitor_id && p.is_active);
    const myByKey = new Map(mine.map((p) => [matchKey(p.name), p]));

    const matched = theirs
      .map((p) => {
        const mineMatch = myByKey.get(matchKey(p.name));
        return {
          id: p.id,
          name: p.name,
          brand: p.brand,
          category: p.category,
          competitor: competitorName.get(p.competitor_id as string) ?? "Competitor",
          competitorPrice: p.price,
          yourPrice: mineMatch?.price ?? null,
          stock: p.stock,
          url: p.url,
          image: p.image_url,
          matched: Boolean(mineMatch),
          gap: mineMatch?.price != null && p.price != null ? p.price - mineMatch.price : null,
        };
      })
      .sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0));

    const priced = theirs.filter((p) => p.price !== null).map((p) => p.price as number);
    const myPriced = mine.filter((p) => p.price !== null).map((p) => p.price as number);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    // Competitor price index vs your average
    const yourAvg = avg(myPriced);
    const competitorStats = competitors.map((c) => {
      const rows = theirs.filter((p) => p.competitor_id === c.id && p.price !== null);
      const competitorAvg = avg(rows.map((p) => p.price as number));
      return {
        id: c.id as string,
        name: c.name as string,
        website: c.website as string,
        frequency: c.frequency as string,
        lastCrawlAt: c.last_crawl_at as string | null,
        products: rows.length,
        avgPrice: Number(competitorAvg.toFixed(2)),
        avgPriceIndex: yourAvg > 0 ? Math.round((competitorAvg / yourAvg) * 100) : 100,
      };
    });

    // Daily basket trend from snapshots
    const byDay = new Map<string, { competitor: number[]; mine: number[] }>();
    const productOwner = new Map(products.map((p) => [p.id, p.competitor_id]));
    for (const s of snapshots) {
      if (s.price === null) continue;
      const day = s.captured_at.slice(0, 10);
      const entry = byDay.get(day) ?? { competitor: [], mine: [] };
      if (productOwner.get(s.product_id)) entry.competitor.push(s.price);
      else entry.mine.push(s.price);
      byDay.set(day, entry);
    }
    const priceHistory = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        you: Number(avg(v.mine).toFixed(2)),
        market: Number(avg(v.competitor).toFixed(2)),
        cheapest: v.competitor.length ? Math.min(...v.competitor) : 0,
      }));

    // Category gaps
    const categoryMap = new Map<string, { yours: number; theirs: number }>();
    for (const p of [...mine, ...theirs]) {
      const key = p.category ?? "Uncategorised";
      const entry = categoryMap.get(key) ?? { yours: 0, theirs: 0 };
      if (p.competitor_id) entry.theirs += 1;
      else entry.yours += 1;
      categoryMap.set(key, entry);
    }
    const categoryGaps = Array.from(categoryMap.entries())
      .map(([category, v]) => ({ category, ...v, gap: v.theirs - v.yours }))
      .sort((a, b) => b.gap - a.gap);

    // Brand momentum
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const brandMap = new Map<string, { total: number; added: number; youStock: boolean }>();
    const myBrands = new Set(mine.map((p) => (p.brand ?? "").toLowerCase()));
    for (const p of theirs) {
      const brand = p.brand ?? "Unbranded";
      const entry = brandMap.get(brand) ?? { total: 0, added: 0, youStock: myBrands.has(brand.toLowerCase()) };
      entry.total += 1;
      if (p.first_seen_at >= since) entry.added += 1;
      brandMap.set(brand, entry);
    }
    const brandGaps = Array.from(brandMap.entries())
      .map(([brand, v]) => ({ brand, ...v }))
      .sort((a, b) => b.added - a.added || b.total - a.total)
      .slice(0, 12);

    const missingProducts = matched.filter((m) => !m.matched);
    const outOfStock = theirs.filter((p) => p.stock === "out_of_stock").length;

    return {
      hasData: products.length > 0,
      stats: {
        competitors: competitors.length,
        productsTracked: theirs.length,
        yourProducts: mine.length,
        matchedProducts: matched.filter((m) => m.matched).length,
        missingProducts: missingProducts.length,
        outOfStock,
        yourAvgPrice: Number(yourAvg.toFixed(2)),
        marketAvgPrice: Number(avg(priced).toFixed(2)),
        cheapestCompetitor:
          competitorStats.slice().sort((a, b) => a.avgPriceIndex - b.avgPriceIndex)[0]?.name ?? "—",
        mostExpensiveCompetitor:
          competitorStats.slice().sort((a, b) => b.avgPriceIndex - a.avgPriceIndex)[0]?.name ?? "—",
      },
      competitors: competitorStats,
      matchedProducts: matched,
      missingProducts,
      priceHistory,
      categoryGaps,
      brandGaps,
    };
  });

export type WorkspaceAnalytics = Awaited<ReturnType<typeof getWorkspaceAnalytics>>;
