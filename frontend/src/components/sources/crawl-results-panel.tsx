import { ArrowUpRight, CircleCheck, Link2, Radar, Zap } from "lucide-react";

import {
  CrawlDiffSummary,
  NewProductsList,
  type DiffProduct,
} from "@/components/cards/crawl-diff-summary";
import { CrawlStatsGrid } from "@/components/cards/crawl-stats-grid";
import { DiscoveryLog } from "@/components/crawls/discovery-log";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CrawlJob, CrawlRunResult } from "@/lib/crawl";
import {
  type CrawlDiff,
  formatCrawlDate,
  normalizeOrigin,
} from "@/utils/crawls";
import { formatPrice } from "@/utils/format";
import { cn } from "@/lib/utils";

/** Finished-crawl results panel — diff vs the previous snapshot, stats,
 * discovery findings/log, failures and the first products. */
export function CrawlResultsPanel({
  result,
  job,
  shallowRun,
  diff,
  crawlOrigin,
  onActionUrl,
}: {
  result: CrawlRunResult;
  job: CrawlJob | undefined;
  shallowRun: boolean;
  diff: CrawlDiff<DiffProduct> | null;
  crawlOrigin: string;
  /** Fills the crawler inputs from a suggestion/finding action link. */
  onActionUrl: (url: string) => void;
}) {
  return (
    <section className="space-y-5 border border-border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-display text-xl">Crawl complete</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {normalizeOrigin(crawlOrigin)} · finished{" "}
            {job?.finishedAt
              ? formatCrawlDate(new Date(job.finishedAt).toISOString())
              : "just now"}
          </p>
        </div>
        {job?.persisted ? (
          <Badge variant="secondary" className="gap-1 font-normal">
            <CircleCheck className="size-3 text-success" /> Saved to database
          </Badge>
        ) : null}
        <Badge
          variant={shallowRun ? "secondary" : "outline"}
          className="gap-1 font-normal"
        >
          {shallowRun ? (
            <Zap className="size-3" />
          ) : (
            <Radar className="size-3" />
          )}
          {shallowRun ? "Shallow check" : "Deep crawl"}
        </Badge>
      </div>{" "}
      {/* Shallow runs return a PARTIAL catalogue (only new products), so the
          deep-crawl diff tiles would report every not-re-fetched product as
          "no longer listed" — bogus. Instead: zero new → a positive "nothing
          changed" panel; some new → just the new products list. Removals/price
          changes are deep-crawl news. */}
      {shallowRun ? (
        result.products.length === 0 ? (
          <div className="rounded-md border border-success/30 bg-success/5 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <CircleCheck className="size-4" />
              No new products since the last crawl
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The shallow check fetches only new product pages (≈1 request) —
              none were found, so the catalogue is unchanged since the last deep
              crawl.
            </p>
          </div>
        ) : (
          <div>
            <p className="label-caps mb-2">
              New products found — {result.products.length.toLocaleString()}
            </p>
            <NewProductsList
              products={result.products}
              footer="Shallow checks only detect new products — removals and price changes are caught by deep crawls."
            />
          </div>
        )
      ) : diff ? (
        <div>
          <p className="label-caps mb-2">What's new since the last crawl</p>
          <CrawlDiffSummary
            newCount={diff.newProducts.length}
            removedCount={diff.removedProducts.length}
            priceChangedCount={diff.priceChangedCount}
            products={diff.newProducts}
            productsFooter={`…and ${diff.newProducts.length - 6} more — see the full list under Saved crawls.`}
          />
        </div>
      ) : null}
      <CrawlStatsGrid stats={result.stats} />
      {/* Detection summary captured from this run. */}
      {result.discovery ? (
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="font-normal">
            {result.discovery.platform?.platform ?? "Unknown platform"}
            {result.discovery.platform?.kind === "store"
              ? " · store"
              : result.discovery.platform?.kind === "corporate"
                ? " · corporate site"
                : ""}
          </Badge>
          {result.discovery.sitemap?.error ? (
            <Badge variant="secondary" className="font-normal">
              No sitemap
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-normal">
              {(result.discovery.sitemap?.urls ?? 0).toLocaleString()} sitemap
              URLs
            </Badge>
          )}
          {result.discovery.robots?.status === "found" ? (
            <Badge variant="secondary" className="font-normal">
              robots.txt respected
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-normal">
              robots: {result.discovery.robots?.status ?? "skipped"}
            </Badge>
          )}
          {result.stats.fetched > 0 ? (
            <Badge variant="secondary" className="font-normal">
              {Math.round(
                (result.products.length / result.stats.fetched) * 100,
              )}
              % parsed
            </Badge>
          ) : null}
        </div>
      ) : null}
      {/* Verbose findings + full discovery log from this run. */}
      {result.discovery?.findings?.length ? (
        <div>
          <p className="label-caps mb-2">What the crawler found</p>
          <ul className="space-y-1.5">
            {result.discovery.findings.map((f, i) => (
              <li
                key={`${f.message}-${i}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
              >
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 font-medium",
                    f.level === "success" && "bg-success/10 text-success",
                    f.level === "warning" && "bg-warning/10 text-warning",
                    f.level === "info" && "bg-accent/10 text-accent",
                  )}
                >
                  {f.level === "success"
                    ? "Found"
                    : f.level === "warning"
                      ? "Heads up"
                      : "Suggestion"}
                </span>
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {f.message}
                </span>
                {f.action ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 text-xs"
                    onClick={() => onActionUrl(f.action!.url)}
                  >
                    <Link2 className="size-3" />
                    {f.action.label}
                    <ArrowUpRight className="size-3" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <DiscoveryLog lines={result.discovery?.log ?? []} />
      {result.failures.length > 0 ? (
        <div>
          <p className="label-caps mb-2">Failures</p>
          <ul className="max-h-40 space-y-1 overflow-auto text-xs">
            {result.failures.slice(0, 12).map((f) => (
              <li key={f.url} className="flex justify-between gap-3">
                <span className="truncate font-mono text-muted-foreground">
                  {f.url}
                </span>
                <span className="shrink-0 text-destructive">{f.error}</span>
              </li>
            ))}
            {result.failures.length > 12 ? (
              <li className="text-muted-foreground">
                …and {result.failures.length - 12} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {result.products.length > 0 ? (
        <div>
          <p className="label-caps mb-2">
            Products ({result.products.length}) — first{" "}
            {Math.min(result.products.length, 8)}
          </p>
          <ul className="divide-y divide-border border border-border">
            {result.products.slice(0, 8).map((p) => (
              <li
                key={p.url}
                className="flex items-center justify-between gap-3 p-3 text-sm"
              >
                <ProductCell name={p.name} brand={p.brand} url={p.url} />
                <span className="flex shrink-0 items-center gap-3">
                  <StockBadge available={p.available} />
                  <span className="text-right">
                    <span className="numeric block">
                      {formatPrice(p.price)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      store price
                    </span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : shallowRun ? null : (
        <p className="text-sm text-muted-foreground">
          No products were parsed — the store may have rate-limited this machine
          (HTTP 429) or no structured data was found. Check the failures above.
        </p>
      )}
    </section>
  );
}
