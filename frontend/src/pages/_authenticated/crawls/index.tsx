import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Eye,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { StatCard } from "@/components/cards/stat-card";
import { CrawlDiffSummary } from "@/components/cards/crawl-diff-summary";
import { CrawlStatsGrid } from "@/components/cards/crawl-stats-grid";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ErrorState,
  LoadingState,
  StateCard,
} from "@/components/common/states";
import { useSavedCrawls } from "@/hooks/useData";
import { useLocalStorageState } from "@/hooks/useLocalStorage";
import {
  deleteCrawlResult,
  deleteCrawlResultsByOrigin,
  type SavedCrawl,
} from "@/lib/api";
import {
  computeCrawlDiff,
  formatCrawlDate,
  normalizeOrigin,
  productUrlPattern,
  robotsText,
} from "@/utils/crawls";
import { formatPrice } from "@/utils/format";

export const Route = createFileRoute("/_authenticated/crawls/")({
  head: () => ({
    meta: [
      { title: "Saved crawls — Parity" },
      {
        name: "description",
        content:
          "Every finished crawl is saved to the database, so you never re-crawl a store from scratch — review its history, see what's new, and re-run it in one click.",
      },
      { property: "og:title", content: "Saved crawls — Parity" },
    ],
  }),
  component: CrawlsPage,
});

/** Delete-confirmation target: a single snapshot or a store's whole history. */
type ConfirmTarget =
  | { kind: "id"; id: string; origin: string }
  | { kind: "origin"; origin: string; count: number };

function CrawlsPage() {
  const saved = useSavedCrawls();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useLocalStorageState<string | null>(
    "parity.crawls.expandedCrawlId",
    null,
  );
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  // Which stores have their snapshot history revealed — hidden by default.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const isGroupOpen = (key: string) => openGroups[key] ?? false;
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  const crawls = useMemo(() => saved.data?.data ?? [], [saved.data]);

  const closeConfirm = () => setConfirm(null);
  const deleteOne = useMutation({
    mutationFn: (id: string) => deleteCrawlResult(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["saved-crawls"] });
      setConfirm(null);
    },
    onError: closeConfirm,
  });
  const clearOrigin = useMutation({
    mutationFn: (origin: string) => deleteCrawlResultsByOrigin(origin),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["saved-crawls"] });
      setConfirm(null);
    },
    onError: closeConfirm,
  });
  const deleting =
    confirm?.kind === "id" ? deleteOne.isPending : clearOrigin.isPending;

  // Snapshots grouped per store (normalized origin), newest first within each
  // group; groups sorted by their newest snapshot.
  const groups = useMemo(() => {
    const map = new Map<string, SavedCrawl[]>();
    for (const c of crawls) {
      const key = normalizeOrigin(c.origin);
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
    }
    return [...map.entries()].sort(
      (a, b) =>
        new Date(b[1][0].updatedAt).getTime() -
        new Date(a[1][0].updatedAt).getTime(),
    );
  }, [crawls]);

  // Prune the open set when a store's history disappears (e.g. cleared) so a
  // re-crawled store comes back collapsed, not auto-opened.
  useEffect(() => {
    setOpenGroups((prev) => {
      const keys = new Set(groups.map(([k]) => k));
      const pruned = Object.fromEntries(
        Object.entries(prev).filter(([k]) => keys.has(k)),
      );
      return Object.keys(pruned).length === Object.keys(prev).length
        ? prev
        : pruned;
    });
  }, [groups]);

  // The snapshot that precedes each crawl (the previous run of the same
  // store) — used to show "+N new products" history badges.
  const prevById = useMemo(() => {
    const map = new Map<string, SavedCrawl>();
    for (const [, group] of groups) {
      for (let i = 0; i < group.length - 1; i++) {
        map.set(group[i]._id, group[i + 1]);
      }
    }
    return map;
  }, [groups]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(([, group]) =>
      group.some(
        (c) =>
          c.origin.toLowerCase().includes(q) ||
          normalizeOrigin(c.origin).includes(q),
      ),
    );
  }, [groups, query]);

  const totals = useMemo(
    () => ({
      products: crawls.reduce((n, c) => n + c.products.length, 0),
      failures: crawls.reduce((n, c) => n + c.failures.length, 0),
      urls: crawls.reduce((n, c) => n + c.stats.discovered, 0),
    }),
    [crawls],
  );

  /** Prefills the crawler page (it reads these localStorage keys on mount). */
  const recrawl = (crawl: SavedCrawl) => {
    try {
      window.localStorage.setItem(
        "parity.sources.origin",
        JSON.stringify(crawl.origin),
      );
      window.localStorage.setItem(
        "parity.sources.collections",
        JSON.stringify(crawl.collections.join(", ")),
      );
    } catch {
      // Storage unavailable — the crawler page keeps its last values.
    }
    navigate({ to: "/sources" });
  };

  const handleConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === "id") deleteOne.mutate(confirm.id);
    else clearOrigin.mutate(confirm.origin);
  };

  if (saved.isError) {
    return (
      <ErrorState description="Couldn't load saved crawls — check that the API is reachable." />
    );
  }
  if (saved.isLoading || !saved.data) {
    return <LoadingState label="Loading saved crawls…" />;
  }

  return (
    <div>
      <PageHeader
        eyebrow="History"
        title="Saved crawls"
        description="Every finished crawl is saved automatically, so you never start from zero. Browse each store's history, spot new products between runs, and re-crawl in one click."
        actions={
          <Button asChild variant="outline">
            <Link to="/sources">
              <Play className="size-4" /> New crawl
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 px-6 py-8 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Saved snapshots"
          value={crawls.length.toLocaleString()}
          hint="newest first"
        />
        <StatCard
          label="Stores crawled"
          value={groups.length.toLocaleString()}
          hint="unique domains"
        />
        <StatCard
          label="Products captured"
          value={totals.products.toLocaleString()}
          hint={`across ${totals.urls.toLocaleString()} URLs`}
        />
        <StatCard
          label="Failed requests"
          value={totals.failures.toLocaleString()}
          tone={totals.failures > 0 ? "negative" : "positive"}
          hint={totals.failures > 0 ? "retried next crawl" : "all clean"}
        />
      </div>

      {crawls.length === 0 ? (
        <StateCard
          className="mx-6 mb-8"
          title="No saved crawls yet"
          description="When a crawl finishes its result is saved to the database and listed here — products, prices, failures and discovery diagnostics. Run your first crawl to start building history."
          action={
            <Button asChild>
              <Link to="/sources">
                <Play className="size-4" /> Run a crawl
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-8 px-6 pb-8">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by domain…"
              className="pl-9"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              No saved crawls match “{query}”.
            </p>
          ) : (
            <div className="space-y-8">
              {filtered.map(([key, group]) => {
                const latest = group[0];
                return (
                  <div key={key}>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Globe className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm font-medium">
                            <Link
                              to="/stores/$origin"
                              params={{ origin: key }}
                              className="transition-colors hover:text-primary hover:underline"
                            >
                              {key}
                            </Link>
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {group.length} snapshot
                            {group.length > 1 ? "s" : ""} ·{" "}
                            {group.reduce((n, c) => n + c.products.length, 0)}{" "}
                            products · last {formatCrawlDate(latest.updatedAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-expanded={isGroupOpen(key)}
                          onClick={() => toggleGroup(key)}
                        >
                          {isGroupOpen(key) ? (
                            <ChevronUp className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                          {isGroupOpen(key) ? "Hide history" : "Show history"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => recrawl(latest)}
                        >
                          <RefreshCw className="size-3.5" /> Crawl again
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setConfirm({
                              kind: "origin",
                              origin: latest.origin,
                              count: group.length,
                            })
                          }
                        >
                          <Trash2 className="size-3.5" /> Clear history
                        </Button>
                      </div>
                    </div>

                    {isGroupOpen(key) ? (
                      <div className="divide-y divide-border border border-border bg-card">
                        {group.map((crawl) => (
                          <CrawlRow
                            key={crawl._id}
                            crawl={crawl}
                            previous={prevById.get(crawl._id)}
                            expanded={expandedId === crawl._id}
                            onToggle={() =>
                              setExpandedId(
                                expandedId === crawl._id ? null : crawl._id,
                              )
                            }
                            onRecrawl={() => recrawl(crawl)}
                            onDelete={() =>
                              setConfirm({
                                kind: "id",
                                id: crawl._id,
                                origin: crawl.origin,
                              })
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="border border-dashed border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">
                        {group.length} snapshot
                        {group.length > 1 ? "s" : ""} hidden — press “Show
                        history” to view this store's crawl history.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Dialog
        open={confirm != null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "origin"
                ? "Clear this store's history?"
                : "Delete this snapshot?"}
            </DialogTitle>
            <DialogDescription className="break-words">
              {confirm?.kind === "origin" ? (
                <>
                  All {confirm.count} saved snapshot
                  {confirm.count === 1 ? "" : "s"} for{" "}
                  <span className="font-mono">{confirm.origin}</span> will be
                  removed. You can always re-crawl the store later.
                </>
              ) : (
                <>
                  The snapshot of{" "}
                  <span className="font-mono">{confirm?.origin}</span> will be
                  removed from your saved crawls.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={handleConfirm}
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CrawlRow({
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
