import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowUpRight } from "lucide-react";

import { PageHeader } from "@/components/app-shell";
import { SectionTitle, StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  alerts,
  brandGaps,
  catalogueGrowth,
  categoryGaps,
  competitors,
  dashboardStats as s,
  gbp,
  insights,
  priceHistory,
} from "@/lib/demo-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — Parity Competitive Intelligence" },
      {
        name: "description",
        content:
          "Live overview of monitored products, competitor price movements, catalogue gaps and stock changes across your market.",
      },
      { property: "og:title", content: "Overview — Parity Competitive Intelligence" },
      {
        property: "og:description",
        content: "Live overview of monitored products, competitor price movements, catalogue gaps and stock changes across your market.",
      },
    ],
  }),
  component: Overview,
});

const axis = {
  stroke: "var(--color-muted-foreground)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
};

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border bg-card p-5">
      <div className="mb-4">
        <h3 className="text-lg">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Overview() {
  return (
    <div>
      <PageHeader
        eyebrow="Workspace overview"
        title="Where you stand today"
        description="8,194 products monitored across four competitors. 407 price changes and 85 new competitor products detected in the last 24 hours."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/reports">Export report</Link>
            </Button>
            <Button asChild>
              <Link to="/insights">
                AI insights <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border lg:grid-cols-4">
        <StatCard label="Products monitored" value={s.productsMonitored.toLocaleString()} hint="across 4 sources" />
        <StatCard
          label="Products matched"
          value={s.productsMatched.toLocaleString()}
          hint={`${Math.round(s.matchRate * 100)}% match rate`}
        />
        <StatCard label="Price changes today" value={s.priceChangesToday.toString()} delta="+62" hint="vs yesterday" />
        <StatCard label="New competitor products" value={s.newProductsToday.toString()} delta="+31" hint="today" />
        <StatCard label="Average price gap" value={`${s.avgPriceGap}%`} tone="negative" hint="you are above market" />
        <StatCard label="Your average price" value={gbp(s.yourAvgPrice)} hint={`market ${gbp(s.marketAvgPrice)}`} />
        <StatCard label="Competitor out of stock" value={s.outOfStock.toString()} hint="demand you can capture" />
        <StatCard label="Products only they sell" value={s.onlyTheySell.toLocaleString()} tone="accent" hint={`${s.onlyYouSell} only you`} />
      </div>

      <div className="grid gap-px bg-border lg:grid-cols-2">
        <ChartCard title="Matched price index" subtitle="Average matched basket, last 30 days">
          <AreaChart data={priceHistory} margin={{ left: -18, right: 8, top: 8 }}>
            <CartesianGrid stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="date" {...axis} />
            <YAxis {...axis} domain={["dataMin - 20", "dataMax + 20"]} />
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
        </ChartCard>

        <ChartCard title="Catalogue growth" subtitle="Your SKUs vs competitor average, 6 months">
          <LineChart data={catalogueGrowth} margin={{ left: -18, right: 8, top: 8 }}>
            <CartesianGrid stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="date" {...axis} />
            <YAxis {...axis} />
            <Tooltip
              contentStyle={{
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                fontSize: 12,
              }}
            />
            <Line isAnimationActive={false} type="monotone" dataKey="you" stroke="var(--color-chart-1)" strokeWidth={2} dot={false} />
            <Line isAnimationActive={false} type="monotone" dataKey="market" stroke="var(--color-chart-4)" strokeWidth={2} dot={false} />
          </LineChart>
        </ChartCard>
      </div>

      <div className="grid gap-8 px-6 py-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionTitle
            aside={
              <Link to="/catalogue" className="text-xs text-accent underline underline-offset-4">
                Full catalogue analysis
              </Link>
            }
          >
            Category gaps
          </SectionTitle>
          <div className="h-72 border border-border bg-card p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryGaps} margin={{ left: -18, right: 8, top: 8 }}>
                <CartesianGrid stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="category" {...axis} interval={0} angle={-18} textAnchor="end" height={60} />
                <YAxis {...axis} />
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

        <div>
          <SectionTitle
            aside={
              <Link to="/alerts" className="text-xs text-accent underline underline-offset-4">
                All alerts
              </Link>
            }
          >
            Latest movement
          </SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {alerts.slice(0, 5).map((a) => (
              <li key={a.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium leading-snug">{a.title}</p>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{a.time}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{a.detail}</p>
                <p className="label-caps mt-2">{a.competitor}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid gap-8 border-t border-border px-6 py-8 lg:grid-cols-2">
        <div>
          <SectionTitle>Competitor snapshot</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {competitors.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.website} · {c.products.toLocaleString()} products · {c.lastCrawl}
                  </p>
                </div>
                <div className="text-right">
                  <p className="numeric text-sm">{c.avgPriceIndex}</p>
                  <p className="label-caps">price index</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <SectionTitle
            aside={
              <Link to="/insights" className="text-xs text-accent underline underline-offset-4">
                All insights
              </Link>
            }
          >
            What the AI is flagging
          </SectionTitle>
          <div className="space-y-px bg-border">
            {insights.slice(0, 3).map((i) => (
              <article key={i.id} className="bg-card p-5">
                <Badge variant="secondary" className="mb-2 font-normal capitalize">
                  {i.category}
                </Badge>
                <h3 className="text-lg leading-snug">{i.headline}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{i.body}</p>
                <p className="numeric mt-3 text-xs text-accent">{i.impact}</p>
              </article>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-border px-6 py-8">
        <SectionTitle>Brand exposure</SectionTitle>
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
          {brandGaps.map((b) => (
            <div key={b.brand} className="bg-card p-4">
              <p className="text-sm font-medium">{b.brand}</p>
              <p className="numeric mt-2 text-2xl">
                {b.you}
                <span className="text-sm text-muted-foreground"> / {b.competitors}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                gap {b.competitors - b.you} · trend {b.trend > 0 ? "+" : ""}
                {b.trend}%
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
