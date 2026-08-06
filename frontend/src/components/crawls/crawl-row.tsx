import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Eye,
  Play,
  Radar,
  Trash2,
  Zap,
} from "lucide-react";

import { CrawlDiffSummary } from "@/components/cards/crawl-diff-summary";
import { CrawlStatsGrid } from "@/components/cards/crawl-stats-grid";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SavedCrawl } from "@/api";
import {
  computeCrawlDiff,
  crawlType,
  formatCrawlDate,
  normalizeOrigin,
  productUrlPattern,
  robotsText,
} from "@/utils/crawls";
import { formatPrice } from "@/utils/format";

/** One expandable snapshot row in a store's history on /crawls. */
export function CrawlRow({
  crawl,
  previous,
  expanded,
  onToggle,
  onRecrawl,
  onDelete,
}: {
  crawl: SavedCrawl;
  previous: SavedCrawl | undefined;
  expanded: boolean;
  onToggle: () => void;
  onRecrawl: () => void;
  onDelete: () => void;
}) {
  const diff = computeCrawlDiff(crawl.products, previous?.products);
  const d = crawl.discovery;
  // Shallow runs are sitemap-only checks — they fetch just new products, so
  // their results are partial (never a full catalogue). Missing type on old
  // snapshots = deep (they were all full crawls before the field landed).
  const shallow = crawlType(crawl) === "shallow";
  const parseRate =
    crawl.stats.fetched > 0
      ? Math.round((crawl.products.length / crawl.stats.fetched) * 100)
      : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:text-foreground"
        >
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
              <span className="numeric text-xs">
                {formatCrawlDate(crawl.updatedAt)}
              </span>
              <span className="text-muted-foreground">·</span>
              <span>{crawl.products.length} products</span>
              {crawl.failures.length > 0 ? (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-destructive">
                    {crawl.failures.length} failed
                  </span>
                </>
              ) : null}
            </span>
          </span>
        </button>

        {diff ? (
          diff.newProducts.length > 0 ? (
            <Badge
              variant="secondary"
              className="gap-1 border-success/40 font-normal text-success"
            >
              <ArrowUpRight className="size-3" /> +{diff.newProducts.length} new
            </Badge>
          ) : diff.removedProducts.length > 0 || diff.priceChangedCount > 0 ? (
            <Badge variant="secondary" className="font-normal">
              {diff.removedProducts.length} removed · {diff.priceChangedCount}{" "}
              price changed
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-normal">
              no change
            </Badge>
          )
        ) : (
          <Badge variant="secondary" className="font-normal">
            first snapshot
          </Badge>
        )}

        <Badge
          variant={shallow ? "secondary" : "outline"}
          className="gap-1 font-normal"
          title={
            shallow
              ? "Sitemap-only check — fetched only new product pages"
              : "Full catalogue crawl"
          }
        >
          {shallow ? <Zap className="size-3" /> : <Radar className="size-3" />}
          {shallow ? "shallow check" : "deep crawl"}
        </Badge>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={onRecrawl}>
            <Play className="size-3.5" /> Re-crawl
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete snapshot"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="space-y-5 border-t border-border bg-muted/30 px-4 py-4 sm:px-5">
          <CrawlStatsGrid stats={crawl.stats} />

          {diff ? (
            <div>
              <p className="label-caps mb-2">Changes since previous crawl</p>
              <CrawlDiffSummary
                newCount={diff.newProducts.length}
                removedCount={diff.removedProducts.length}
                priceChangedCount={diff.priceChangedCount}
                products={diff.newProducts}
                listTitle="New products found this run"
              />
            </div>
          ) : null}

          {d ? (
            <div>
              <p className="label-caps mb-2">Discovery</p>
              <ul className="divide-y divide-border border border-border bg-card text-sm">
                <li className="flex items-center justify-between gap-4 p-3">
                  <span>Platform</span>
                  <span className="text-xs text-muted-foreground">
                    {d.platform?.platform ?? "Unknown"}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-4 p-3">
                  <span>Sitemap</span>
                  <span className="text-xs text-muted-foreground">
                    {d.sitemap?.error
                      ? "Failed"
                      : `${(d.sitemap?.urls ?? 0).toLocaleString()} product URLs`}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-4 p-3">
                  <span>HTML crawl</span>
                  <span className="text-xs text-muted-foreground">
                    {d.htmlCrawl?.error
                      ? "Failed"
                      : `${(d.htmlCrawl?.pagesVisited ?? 0).toLocaleString()} pages visited`}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-4 p-3">
                  <span>Product URL pattern</span>
                  <span className="numeric text-xs text-muted-foreground">
                    {crawl.products[0]
                      ? productUrlPattern(crawl.products[0].url)
                      : "—"}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-4 p-3">
                  <span>robots.txt</span>
                  <span className="text-xs text-muted-foreground">
                    {robotsText(d.robots)}
                  </span>
                </li>
                {parseRate != null ? (
                  <li className="flex items-center justify-between gap-4 p-3">
                    <span>Structured data</span>
                    <span className="text-xs text-muted-foreground">
                      {parseRate}% of pages parsed
                    </span>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {crawl.products.length > 0 ? (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="label-caps">
                  Products ({crawl.products.length}) — first{" "}
                  {Math.min(crawl.products.length, 8)}
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link
                    to="/stores/$origin"
                    params={{ origin: normalizeOrigin(crawl.origin) }}
                  >
                    <Eye className="size-3.5" /> View all{" "}
                    {crawl.products.length.toLocaleString()}
                  </Link>
                </Button>
              </div>
              <ul className="divide-y divide-border border border-border bg-card">
                {crawl.products.slice(0, 8).map((p) => (
                  <li
                    key={p.url}
                    className="flex items-center justify-between gap-3 p-3 text-sm"
                  >
                    <ProductCell name={p.name} brand={p.brand} />
                    <span className="flex shrink-0 items-center gap-3">
                      <StockBadge available={p.available} />
                      <span className="numeric text-right">
                        {formatPrice(p.price)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : shallow ? (
            <p className="text-sm text-muted-foreground">
              The shallow check found no new products — nothing to add to the
              stored catalogue.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No products were parsed — the store may have rate-limited the
              crawl or no structured data was found.
            </p>
          )}

          {crawl.failures.length > 0 ? (
            <div>
              <p className="label-caps mb-2">
                Failures ({crawl.failures.length})
              </p>
              <ul className="max-h-40 space-y-1 overflow-auto text-xs">
                {crawl.failures.slice(0, 12).map((f) => (
                  <li key={f.url} className="flex justify-between gap-3">
                    <span className="truncate font-mono text-muted-foreground">
                      {f.url}
                    </span>
                    <span className="shrink-0 text-destructive">{f.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
