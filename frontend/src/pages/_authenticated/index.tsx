import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowUpRight } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { SectionTitle, StatCard } from "@/components/cards/stat-card";
import { MarketTrendChart } from "@/components/common/market-trend-chart";
import { chartAxis, chartTooltipStyle } from "@/components/common/chart-styles";
import {
  ErrorState,
  LoadingState,
  NoRealDataState,
} from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { useAnalytics } from "@/hooks/useWorkspace";
import { gbp } from "@/utils";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Overview — Parity Competitive Intelligence" },
      {
        name: "description",
        content:
          "Live overview of monitored products, competitor price movements, catalogue gaps and stock changes across your market.",
      },
      {
        property: "og:title",
        content: "Overview — Parity Competitive Intelligence",
      },
      {
        property: "og:description",
        content:
          "Live overview of monitored products, competitor price movements, catalogue gaps and stock changes across your market.",
      },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { data, isLoading, isError } = useAnalytics();

  const header = (
    <PageHeader
      eyebrow="Workspace overview"
      title="Where you stand today"
      description="Live figures compiled from your most recent competitor crawls. Every price, stock state and new listing below comes from real captured data."
      actions={
        <>
          <Button variant="outline" asChild>
            <Link to="/reports">Reports</Link>
          </Button>
          <Button asChild>
            <Link to="/insights">
              AI insights <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </>
      }
    />
  );

  if (isError)
    return (
      <div>
        {header}
        <ErrorState />
      </div>
    );

  if (isLoading)
    return (
      <div>
        {header}
        <LoadingState />
      </div>
    );

  if (!data?.hasData) {
    return (
      <div>
        {header}
        <NoRealDataState
          title="No crawl data yet"
          description="Run your first crawl on the Sources page — prices, availability and catalogue gaps will appear here as soon as real competitor products are captured."
        />
      </div>
    );
  }

  const s = data.stats;

  return (
    <div>
      {header}

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border lg:grid-cols-4">
        <StatCard
          label="Competitor products"
          value={s.productsTracked.toLocaleString()}
          hint={`${s.competitors} sources`}
        />
        <StatCard
          label="Products matched"
          value={s.matchedProducts.toLocaleString()}
          hint="against your catalogue"
        />
        <StatCard
          label="Your products"
          value={s.yourProducts.toLocaleString()}
          hint="from your own store crawl"
        />
        <StatCard
          label="Only they sell"
          value={s.missingProducts.toLocaleString()}
          tone="accent"
          hint="catalogue gaps"
        />
        <StatCard
          label="Your average price"
          value={gbp(s.yourAvgPrice)}
          hint={`market ${gbp(s.marketAvgPrice)}`}
        />
        <StatCard
          label="Market average"
          value={gbp(s.marketAvgPrice)}
          hint="all matched competitors"
        />
        <StatCard
          label="Competitor out of stock"
          value={s.outOfStock.toLocaleString()}
          hint="demand you can capture"
        />
        <StatCard
          label="Cheapest competitor"
          value={s.cheapestCompetitor}
          hint={`priciest ${s.mostExpensiveCompetitor}`}
        />
      </div>

      <div className="grid gap-8 px-6 py-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionTitle
            aside={
              <span className="text-xs text-muted-foreground">
                From price snapshots
              </span>
            }
          >
            Matched basket trend
          </SectionTitle>
          <MarketTrendChart
            data={data.priceHistory}
            emptyMessage="Trend appears after two or more crawls."
          />
        </div>

        <div>
          <SectionTitle
            aside={
              <Link
                to="/pricing"
                className="text-xs text-accent underline underline-offset-4"
              >
                Price intelligence
              </Link>
            }
          >
            Widest price gaps
          </SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {data.matchedProducts
              .filter((p) => p.gap !== null)
              .slice(0, 6)
              .map((p) => (
                <li key={p.id} className="p-4">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.competitor} · {gbp(p.competitorPrice ?? 0)} vs your{" "}
                    {gbp(p.yourPrice ?? 0)}
                  </p>
                  <p className="numeric mt-1 text-xs text-accent">
                    {(p.gap ?? 0) > 0 ? "+" : ""}
                    {gbp(p.gap ?? 0)}
                  </p>
                </li>
              ))}
            {data.matchedProducts.every((p) => p.gap === null) && (
              <li className="p-4 text-sm text-muted-foreground">
                Crawl your own store to compare prices side by side.
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="border-t border-border px-6 py-8">
        <SectionTitle
          aside={
            <Link
              to="/catalogue"
              className="text-xs text-accent underline underline-offset-4"
            >
              Catalogue analysis
            </Link>
          }
        >
          Category coverage
        </SectionTitle>
        <div className="h-72 border border-border bg-card p-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data.categoryGaps.slice(0, 10)}
              margin={{ left: -18, right: 8, top: 8 }}
            >
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="category"
                {...chartAxis}
                interval={0}
                angle={-18}
                textAnchor="end"
                height={60}
              />
              <YAxis {...chartAxis} />
              <Tooltip
                cursor={{ fill: "var(--color-muted)" }}
                contentStyle={chartTooltipStyle}
              />
              <Bar
                isAnimationActive={false}
                dataKey="yours"
                fill="var(--color-chart-1)"
              />
              <Bar
                isAnimationActive={false}
                dataKey="theirs"
                fill="var(--color-chart-5)"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="border-t border-border px-6 py-8">
        <SectionTitle
          aside={
            <Link
              to="/competitors"
              className="text-xs text-accent underline underline-offset-4"
            >
              Manage sources
            </Link>
          }
        >
          Competitor snapshot
        </SectionTitle>
        <ul className="divide-y divide-border border border-border bg-card">
          {data.competitors.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.website} · {c.products.toLocaleString()} products ·{" "}
                  {c.lastCrawl}
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
    </div>
  );
}
