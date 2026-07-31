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
import { competitors, dashboardStats as s, gbp, matchedProducts, priceHistory } from "@/data/mock";
import { cn } from "@/lib/utils";


export function PricingPage() {
  const gaps = matchedProducts
    .filter((p) => p.yourPrice !== null)
    .map((p) => ({ ...p, gap: p.competitorPrice - (p.yourPrice as number) }))
    .sort((a, b) => a.gap - b.gap);

  return (
    <div>
      <PageHeader
        eyebrow="Price intelligence"
        title="Who is selling cheaper than you"
        description="Every crawl writes a new price snapshot, so movement is tracked to the hour. Below: the matched basket trend, competitor positioning and the products where the gap costs you most."
      />

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border lg:grid-cols-4">
        <StatCard label="Your average price" value={gbp(s.yourAvgPrice)} hint="matched basket" />
        <StatCard label="Market average" value={gbp(s.marketAvgPrice)} tone="accent" hint="4 competitors" />
        <StatCard label="Cheapest competitor" value={s.cheapestCompetitor} hint="index 91" />
        <StatCard label="Most expensive" value={s.mostExpensiveCompetitor} hint="index 108" />
      </div>

      <div className="px-6 py-8">
        <SectionTitle aside={<span className="text-xs text-muted-foreground">Last 30 days</span>}>
          Matched basket trend
        </SectionTitle>
        <div className="h-72 border border-border bg-card p-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={priceHistory} margin={{ left: -18, right: 8, top: 8 }}>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} domain={["dataMin - 20", "dataMax + 20"]} />
              <Tooltip
                contentStyle={{
                  background: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  fontSize: 12,
                }}
              />
              <Area isAnimationActive={false} type="monotone" dataKey="you" stroke="var(--color-chart-1)" fill="var(--color-chart-1)" fillOpacity={0.12} strokeWidth={2} />
              <Area isAnimationActive={false} type="monotone" dataKey="market" stroke="var(--color-chart-3)" fill="var(--color-chart-3)" fillOpacity={0.08} strokeWidth={1.5} />
              <Area isAnimationActive={false} type="monotone" dataKey="cheapest" stroke="var(--color-chart-2)" fill="transparent" strokeDasharray="4 3" strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-8 border-t border-border px-6 py-8 lg:grid-cols-2">
        <div>
          <SectionTitle>Biggest pricing gaps against you</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {gaps.slice(0, 5).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.competitor} · {gbp(p.competitorPrice)} vs your {gbp(p.yourPrice as number)}
                  </p>
                </div>
                <span className={cn("numeric text-sm", p.gap < 0 ? "text-destructive" : "text-success")}>
                  {p.gap > 0 ? "+" : ""}
                  {gbp(p.gap)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <SectionTitle>Competitor positioning</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {competitors.map((c) => (
              <li key={c.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{c.name}</p>
                  <Badge variant={c.avgPriceIndex < 100 ? "destructive" : "secondary"} className="font-normal">
                    index {c.avgPriceIndex}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.priceChanges} price changes in the last 24 hours · {c.frequency.toLowerCase()} crawl
                </p>
                <div className="mt-3 h-1.5 w-full bg-muted">
                  <div
                    className={cn("h-full", c.avgPriceIndex < 100 ? "bg-destructive" : "bg-success")}
                    style={{ width: `${Math.min(100, Math.abs(c.avgPriceIndex - 100) * 8 + 12)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
