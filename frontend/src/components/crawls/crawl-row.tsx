import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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

import {
  CrawlDiffSummary,
  type DiffProduct,
} from "@/components/cards/crawl-diff-summary";
import { CrawlStatsGrid } from "@/components/cards/crawl-stats-grid";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getStoreEvents,
  getStoreProducts,
  type StoreProduct,
  type StoreSnapshot,
} from "@/api";
import {
  formatCrawlDate,
  normalizeOrigin,
  productUrlPattern,
  robotsText,
  snapshotType,
} from "@/utils/crawls";
import { formatPrice } from "@/utils/format";

/**
 * One expandable snapshot row in a store's history on /crawls — reads the
 * D1 read path: the Snapshot doc carries stats/discovery/failures and the
 * ingest-time change counts; the new-products list comes from the store's
 * ProductEvent change log (filtered to this snapshot); the preview shows the
 * CURRENT catalogue (snapshots no longer embed product arrays).
 */
export function CrawlRow({
  snapshot,
  origin,
  storeKey,
  storeCount,
  hasPrevious,
  expanded,
  onToggle,
  onRecrawl,
  onDelete,
}: {
  snapshot: StoreSnapshot;
  /** Store origin URL (for recrawl prefill + links). */
  origin: string;
  /** Normalized host (for the read-path API calls). */
  storeKey: string;
  /** Current catalogue size — the "View all N" link target. */
  storeCount: number;
  /** True when an older snapshot exists (badge reads "no change" vs "first"). */
  hasPrevious: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRecrawl: () => void;
  onDelete: () => void;
}) {
  const d = snapshot.discovery;
  // Shallow runs are sitemap-only checks — they fetch just new products, so
  // their results are partial (never a full catalogue). Snapshot.full is the
  // normalized equivalent of the legacy `type` field.
  const shallow = snapshotType(snapshot) === "shallow";
  const parseRate =
    snapshot.stats.fetched > 0
      ? Math.round((snapshot.productCount / snapshot.stats.fetched) * 100)
      : null;

  // The new-products list — the ingest-time change log for THIS snapshot
  // (added events carry name/url/price, which the snapshot's key lists lack).
  // Fetched only when the row is expanded.
  const eventsQuery = useQuery({
    queryKey: ["crawl-row-events", storeKey, snapshot._id],
    queryFn: () => getStoreEvents(storeKey, { limit: 100 }),
    enabled: expanded,
  });
  const addedProducts = (eventsQuery.data?.data ?? [])
    .filter((e) => e.snapshotId === snapshot._id && e.type === "added")
    .map((e): DiffProduct => ({
      name: e.name,
      url: e.url,
      price: e.new?.price ?? 0,
      available: e.new?.available ?? true,
    }));

  // Product preview — the CURRENT catalogue (snapshots carry no products on
  // the normalized model). Fetched only when the row is expanded.
  const previewQuery = useQuery({
    queryKey: ["store-products-preview", storeKey],
    queryFn: () => getStoreProducts(storeKey, { limit: 8 }),
    enabled: expanded,
  });
  const previewProducts: StoreProduct[] = previewQuery.data?.data ?? [];
  const firstUrl = previewProducts[0]?.url;

  const badge = hasPrevious
    ? snapshot.addedCount > 0
      ? { tone: "success" as const, text: `+${snapshot.addedCount} new` }
      : snapshot.removedCount > 0 || snapshot.priceChangedCount > 0
        ? {
            tone: "default" as const,
            text: `${snapshot.removedCount} removed · ${snapshot.priceChangedCount} price changed`,
          }
        : { tone: "default" as const, text: "no change" }
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
                {formatCrawlDate(snapshot.finishedAt)}
              </span>
              <span className="text-muted-foreground">·</span>
              <span>{snapshot.productCount} products</span>
              {snapshot.failures.length > 0 ? (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-destructive">
                    {snapshot.failures.length} failed
                  </span>
                </>
              ) : null}
            </span>
          </span>
        </button>

        {badge ? (
          <Badge
            variant="secondary"
            className={`gap-1 font-normal ${
              badge.tone === "success" ? "border-success/40 text-success" : ""
            }`}
          >
            {badge.tone === "success" ? (
              <ArrowUpRight className="size-3" />
            ) : null}
            {badge.text}
          </Badge>
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
          <CrawlStatsGrid stats={snapshot.stats} />

          {hasPrevious ? (
            <div>
              <p className="label-caps mb-2">Changes since previous crawl</p>
              <CrawlDiffSummary
                newCount={snapshot.addedCount}
                removedCount={snapshot.removedCount}
                priceChangedCount={snapshot.priceChangedCount}
                products={addedProducts}
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
                    {firstUrl ? productUrlPattern(firstUrl) : "—"}
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

          {previewProducts.length > 0 ? (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="label-caps">
                  Products ({snapshot.productCount.toLocaleString()}) — current
                  catalogue, first {Math.min(previewProducts.length, 8)}
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link
                    to="/stores/$origin"
                    params={{ origin: normalizeOrigin(origin) }}
                  >
                    <Eye className="size-3.5" /> View all{" "}
                    {storeCount.toLocaleString()}
                  </Link>
                </Button>
              </div>
              <ul className="divide-y divide-border border border-border bg-card">
                {previewProducts.map((p) => (
                  <li
                    key={p.url}
                    className="flex items-center justify-between gap-3 p-3 text-sm"
                  >
                    <ProductCell name={p.name} brand={p.brand} />
                    <span className="flex shrink-0 items-center gap-3">
                      <StockBadge available={p.available} />
                      <span className="numeric text-right">
                        {formatPrice(p.price ?? 0)}
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

          {snapshot.failures.length > 0 ? (
            <div>
              <p className="label-caps mb-2">
                Failures ({snapshot.failures.length})
              </p>
              <ul className="max-h-40 space-y-1 overflow-auto text-xs">
                {snapshot.failures.slice(0, 12).map((f) => (
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
