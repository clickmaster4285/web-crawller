import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { chartAxis, chartTooltipStyle } from "./chart-styles";

/** One point of the market price trend (from saved crawl snapshots). */
export interface TrendPoint {
  date: string;
  you?: number | null;
  market?: number | null;
  cheapest?: number | null;
}

/**
 * The market-vs-you price trend chart, shared by the Overview and /pricing
 * pages (which previously each kept their own copy). Renders the
 * fixed-height card and an empty state when there are fewer than two points.
 */
export function MarketTrendChart({
  data,
  showCheapest = false,
  padY = false,
  emptyMessage,
}: {
  data: TrendPoint[];
  /** Render the dashed "Cheapest store" series (pricing page only). */
  showCheapest?: boolean;
  /** Add Y-axis headroom via a padded domain (pricing page only). */
  padY?: boolean;
  /** Message shown inside the card when `data` has fewer than 2 points. */
  emptyMessage: string;
}) {
  const hasYou = data.some((p) => p.you != null);
  return (
    <div className="h-72 border border-border bg-card p-4">
      {data.length >= 2 ? (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ left: -18, right: 8, top: 8 }}>
            <CartesianGrid stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="date" {...chartAxis} />
            <YAxis
              {...chartAxis}
              {...(padY ? { domain: ["dataMin - 20", "dataMax + 20"] } : {})}
            />
            <Tooltip contentStyle={chartTooltipStyle} />
            {hasYou ? (
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
            {showCheapest ? (
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
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <p className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      )}
    </div>
  );
}
