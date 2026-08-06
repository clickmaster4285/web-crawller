import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PageHeader } from "@/components/layout/app-shell";
import { SectionTitle, StatCard } from "@/components/cards/stat-card";
import { Badge } from "@/components/ui/badge";
import {
  LoadingState,
  ErrorState,
  NoRealDataState,
} from "@/components/common/states";
import { usePricing, useSavedCrawls } from "@/hooks/useData";
import type { SavedCrawl } from "@/api";
import { gbp } from "@/utils/formatCurrency";
import { normalizeOrigin } from "@/utils/crawls";
import { formatPrice } from "@/utils/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/pricing/")({
  head: () => ({
    meta: [
      { title: "Price intelligence — Parity" },
      {
        name: "description",
        content:
          "Real price history built from every saved crawl snapshot — market average, cheapest store and the products with the biggest price movements.",
      },
      { property: "og:title", content: "Price intelligence — Parity" },
      {
        property: "og:description",
        content:
          "Snapshot-based price history, competitor positioning and the widest pricing gaps in your matched catalogue.",
      },
    ],
  }),
  component: PricingPage,
});

/** A product whose price moved between the first and latest snapshot of a store. */
interface PriceMover {
  origin: string;
  name: string;
  url: string;
  first: number;
  latest: number;
  change: number;
}

function PricingPage() {
  const { data, isLoading, isError } = usePricing();
  const saved = useSavedCrawls();

  // Biggest price movements — computed from real snapshots: for each store
  // with 2+ crawls, products whose price differs between the first and latest
  // snapshot, sorted by absolute change.
  const movers = useMemo<PriceMover[]>(() => {
    const byOrigin = new Map<string, SavedCrawl[]>();
    for (const c of saved.data?.data ?? []) {
      const key = normalizeOrigin(c.origin);
      const arr = byOrigin.get(key) ?? [];
      arr.push(c);
      byOrigin.set(key, arr);
    }
    const out: PriceMover[] = [];
    for (const [origin, snaps] of byOrigin) {
      if (snaps.length < 2) continue;
      const sorted = [...snaps].sort(
        (a, b) =>
          new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      );
      const first = sorted[0];
      const latest = sorted[sorted.length - 1];
      const firstByUrl = new Map(first.products.map((p) => [p.url, p.price]));
      const latestByUrl = new Map(latest.products.map((p) => [p.url, p.price]));
      for (const [url, price] of latestByUrl) {
        const firstPrice = firstByUrl.get(url);
        if (firstPrice == null || price == null) continue;
        const change = price - firstPrice;
        if (Math.abs(change) < 0.01) continue;
        const name = latest.products.find((p) => p.url === url)?.name ?? url;
        out.push({
          origin,
          name,
          url,
          first: firstPrice,
          latest: price,
          change,
        });
      }
    }
    return out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  }, [saved.data]);

  if (isError) return <ErrorState />;
  if (isLoading || !data) return <LoadingState />;
  if (data.competitors.length === 0) {
    return (
      <NoRealDataState
        title="No pricing data yet"
        description="Prices come from real crawls. Run a crawl on the Sources page to see competitor pricing here — crawl the same store twice and its price history starts building automatically."
      />
    );
  }

  const { competitors, matchedProducts, priceHistory } = data;
  const s = data.stats;
  const crawledCount = competitors.filter((c) => c.products > 0).length;

  const gaps = matchedProducts
    .filter((p) => p.yourPrice !== null)
    .map((p) => ({ ...p, gap: p.competitorPrice - (p.yourPrice as number) }))
    .sort((a, b) => a.gap - b.gap);

  return (
    <div>
      <PageHeader
        eyebrow="Price intelligence"
        title="Who is selling cheaper than you"
        description="Every crawl writes a new price snapshot, so movement is tracked over time. Below: the market trend from your snapshots, competitor positioning and the products where prices moved most."
      />

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border lg:grid-cols-4">
        <StatCard
          label="Your average price"
          value={gbp(s.yourAvgPrice)}
          hint={s.yourAvgPrice > 0 ? "your store crawl" : "crawl your store"}
        />
        <StatCard
          label="Market average"
          value={gbp(s.marketAvgPrice)}
          tone="accent"
          hint={`${crawledCount} store${crawledCount === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Cheapest competitor"
          value={s.cheapestCompetitor}
          hint="by average product price"
        />
        <StatCard
          label="Most expensive"
          value={s.mostExpensiveCompetitor}
          hint="by average product price"
        />
      </div>

      <div className="px-6 py-8">
        <SectionTitle
          aside={
            <span className="text-xs text-muted-foreground">
              {priceHistory.length} snapshot event
              {priceHistory.length === 1 ? "" : "s"}
            </span>
          }
        >
          Market price trend
        </SectionTitle>
        <div className="h-72 border border-border bg-card p-4">
          {priceHistory.length >= 2 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={priceHistory}
                margin={{ left: -18, right: 8, top: 8 }}
              >
                <CartesianGrid stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="var(--color-muted-foreground)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="var(--color-muted-foreground)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  domain={["dataMin - 20", "dataMax + 20"]}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-popover)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                />
                {s.yourAvgPrice > 0 ? (
                  <Area
                    isAnimationActive={false}
                    type="monotone"
                    dataKey="you"
                    name="You"
                    stroke="var(--color-chart-1)"
                    fill="var(--color-chart-1)"
                    fillOpacity={0.12}
                    strokeWidth={2}
                  />
                ) : null}
                <Area
                  isAnimationActive={false}
                  type="monotone"
                  dataKey="market"
                  name="Market average"
                  stroke="var(--color-chart-3)"
                  fill="var(--color-chart-3)"
                  fillOpacity={0.08}
                  strokeWidth={1.5}
                />
                <Area
                  isAnimationActive={false}
                  type="monotone"
                  dataKey="cheapest"
                  name="Cheapest store"
                  stroke="var(--color-chart-2)"
                  fill="transparent"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
              {priceHistory.length === 1
                ? "One price snapshot so far — crawl this store again and its history appears here."
                : "Crawl a store twice to build a price history. Every snapshot adds a point to the market trend."}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-8 border-t border-border px-6 py-8 lg:grid-cols-2">
        <div>
          <SectionTitle>Biggest pricing gaps against you</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {gaps.slice(0, 5).map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.competitor} · {gbp(p.competitorPrice)} vs your{" "}
                    {gbp(p.yourPrice as number)}
                  </p>
                </div>
                <span
                  className={cn(
                    "numeric text-sm",
                    p.gap < 0 ? "text-destructive" : "text-success",
                  )}
                >
                  {p.gap > 0 ? "+" : ""}
                  {gbp(p.gap)}
                </span>
              </li>
            ))}
            {gaps.length === 0 ? (
              <li className="p-4 text-sm text-muted-foreground">
                Crawl your own store to measure the gaps between your prices and
                each competitor's.
              </li>
            ) : null}
          </ul>
        </div>

        <div>
          <SectionTitle>Competitor positioning</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {competitors.map((c) => (
              <li key={c.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <Badge
                    variant={
                      c.avgPriceIndex !== 100 && c.avgPriceIndex < 100
                        ? "destructive"
                        : "secondary"
                    }
                    className="font-normal"
                  >
                    index {c.avgPriceIndex}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.products.toLocaleString()} products · {c.lastCrawl}
                </p>
                <div className="mt-3 h-1.5 w-full bg-muted">
                  <div
                    className={cn(
                      "h-full",
                      c.avgPriceIndex !== 100 && c.avgPriceIndex < 100
                        ? "bg-destructive"
                        : "bg-success",
                    )}
                    style={{
                      width: `${Math.min(100, Math.abs(c.avgPriceIndex - 100) * 8 + 12)}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Index 100 = at the market average of crawled stores; below 100 means
            cheaper than market.
          </p>
        </div>
      </div>

      <div className="border-t border-border px-6 py-8">
        <SectionTitle
          aside={
            <span className="text-xs text-muted-foreground">
              Between first and latest snapshot
            </span>
          }
        >
          Biggest price movements
        </SectionTitle>
        {movers.length === 0 ? (
          <p className="border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
            No movements yet — crawl a store at least twice and products whose
            price changed between the runs will appear here.
          </p>
        ) : (
          <ul className="divide-y divide-border border border-border bg-card">
            {movers.slice(0, 8).map((m) => (
              <li
                key={`${m.origin}-${m.url}`}
                className="flex items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-sm font-medium transition-colors hover:text-primary hover:underline"
                  >
                    {m.name}
                  </a>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.origin}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="numeric text-xs text-muted-foreground">
                    {formatPrice(m.first)} →{" "}
                    <span className="font-medium text-foreground">
                      {formatPrice(m.latest)}
                    </span>
                  </p>
                  <p
                    className={cn(
                      "numeric mt-0.5 text-xs font-semibold",
                      m.change < 0 ? "text-success" : "text-destructive",
                    )}
                  >
                    {m.change > 0 ? "+" : ""}
                    {formatPrice(m.change)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
