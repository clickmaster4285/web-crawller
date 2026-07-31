import { createFileRoute } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { PageHeader } from "@/components/layout/app-shell";
import { SectionTitle, StatCard } from "@/components/cards/stat-card";
import { Progress } from "@/components/ui/progress";
import { brandGaps, categoryGaps, dashboardStats as s } from "@/data/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/catalogue/")({
  head: () => ({
    meta: [
      { title: "Catalogue gaps — Parity" },
      {
        name: "description",
        content:
          "See which categories and brands competitors cover and you don't, ranked by gap size and competitor growth rate.",
      },
      { property: "og:title", content: "Catalogue gaps — Parity" },
      {
        property: "og:description",
        content: "Category and brand coverage gaps between your catalogue and the market.",
      },
    ],
  }),
  component: CataloguePage,
});

function CataloguePage() {
  const sortedCategories = [...categoryGaps].sort(
    (a, b) => b.competitors - b.you - (a.competitors - a.you),
  );
  const sortedBrands = [...brandGaps].sort(
    (a, b) => b.competitors - b.you - (a.competitors - a.you),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Catalogue intelligence"
        title="What you're missing"
        description="Normalised product titles let categories and brands be compared like for like across stores, so a gap here is a real assortment gap — not a naming difference."
      />

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border lg:grid-cols-4">
        <StatCard
          label="Products only you sell"
          value={s.onlyYouSell.toString()}
          tone="positive"
          hint="unique assortment"
        />
        <StatCard
          label="Products only they sell"
          value={s.onlyTheySell.toLocaleString()}
          tone="accent"
          hint="addressable gap"
        />
        <StatCard
          label="Missing categories"
          value={s.missingCategories.toString()}
          hint="zero coverage"
        />
        <StatCard
          label="Missing brands"
          value={s.missingBrands.toString()}
          hint="stocked by rivals"
        />
      </div>

      <div className="px-6 py-8">
        <SectionTitle>Category coverage</SectionTitle>
        <div className="h-80 border border-border bg-card p-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={sortedCategories}
              layout="vertical"
              margin={{ left: 60, right: 16, top: 8 }}
            >
              <CartesianGrid stroke="var(--color-border)" horizontal={false} />
              <XAxis
                type="number"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="category"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={110}
              />
              <Tooltip
                cursor={{ fill: "var(--color-muted)" }}
                contentStyle={{
                  background: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  fontSize: 12,
                }}
              />
              <Bar isAnimationActive={false} dataKey="you" fill="var(--color-chart-1)" />
              <Bar isAnimationActive={false} dataKey="competitors" fill="var(--color-chart-5)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-8 border-t border-border px-6 py-8 lg:grid-cols-2">
        <div>
          <SectionTitle>Where to invest first</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {sortedCategories.map((c) => {
              const gap = c.competitors - c.you;
              return (
                <li key={c.category} className="p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{c.category}</p>
                    <span className="numeric text-sm text-accent">+{gap} products</span>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <Progress value={(c.you / c.competitors) * 100} className="h-1.5" />
                    <span className="numeric shrink-0 text-xs text-muted-foreground">
                      {c.you} / {c.competitors}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <SectionTitle>Brand intelligence</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {sortedBrands.map((b) => (
              <li key={b.brand} className="flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="text-sm font-medium">{b.brand}</p>
                  <p className="text-xs text-muted-foreground">
                    {b.you === 0 ? "You stock none" : `You stock ${b.you}`} · market {b.competitors}
                  </p>
                </div>
                <div className="text-right">
                  <p className="numeric text-sm">{b.competitors - b.you}</p>
                  <p className={cn("text-xs", b.trend >= 0 ? "text-success" : "text-destructive")}>
                    {b.trend > 0 ? "+" : ""}
                    {b.trend}% 90d
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
