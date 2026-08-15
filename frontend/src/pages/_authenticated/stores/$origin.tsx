import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  ArrowLeft,
  ChevronDown,
  Globe,
  Loader2,
  PackageSearch,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { StoreProfile } from "@/components/crawls/store-profile";
import { DiscoveryLog } from "@/components/crawls/discovery-log";
import { CrawlStatsGrid } from "@/components/cards/crawl-stats-grid";
import { ProductCell } from "@/components/common/product-cell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ErrorState,
  LoadingState,
  StateCard,
} from "@/components/common/states";
import {
  deleteStore,
  getStore,
  getStoreProducts,
  getStoreSnapshots,
  invalidateCrawlData,
  queryKeys,
  type StoreProduct,
} from "@/api";
import type { StoreProfileCrawl } from "@/components/crawls/store-profile";
import {
  formatCrawlDate,
  normalizeOrigin,
  prefillCrawlerOrigin,
  productUrlPattern,
} from "@/utils/crawls";
import { formatPrice } from "@/utils/format";

export const Route = createFileRoute("/_authenticated/stores/$origin")({
  component: StoreCataloguePage,
});

/** One price point on the sparkline (from the product's capped priceHistory). */
interface SparkPoint {
  date: string;
  price: number;
}

/** Hover tooltip for a sparkline point — the observation date and its price. */
function SparklineTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: SparkPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-popover px-2 py-1 text-[11px] shadow-sm">
      <p className="text-muted-foreground">{p.date}</p>
      <p className="numeric font-medium">{formatPrice(p.price)}</p>
    </div>
  );
}

/**
 * Compact price-history sparkline. Coloured by direction — green when the
 * latest price is below the first (cheaper), red when it rose, neutral when
 * flat. A single observation renders as a price chip.
 */
function PriceSparkline({ prices }: { prices: SparkPoint[] }) {
  const data = prices.map((p, i) => ({ i, date: p.date, price: p.price }));
  if (data.length === 0)
    return <span className="text-muted-foreground">—</span>;
  if (data.length < 2) {
    return (
      <span className="numeric inline-flex items-center rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[11px]">
        {formatPrice(data[0].price)}
      </span>
    );
  }
  const first = data[0].price;
  const last = data[data.length - 1].price;
  const stroke =
    last < first
      ? "var(--color-success)"
      : last > first
        ? "var(--color-destructive)"
        : "var(--color-muted-foreground)";
  return (
    <div className="w-36" aria-hidden="true">
      <ResponsiveContainer width="100%" height={32}>
        <LineChart
          data={data}
          margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          <Tooltip cursor={false} content={<SparklineTooltip />} />
          <Line
            type="monotone"
            dataKey="price"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Server-paginated catalogue loader (D1 read path): `q=` search is applied
 * on the backend, pages are fetched by keyset cursor and ACCUMULATED here
 * ("Load more"), so a 10k-product store never ships its full catalogue to
 * the browser. A fresh search resets the accumulation.
 */
function useStoreCatalogue(key: string, q: string) {
  const [loaded, setLoaded] = useState<StoreProduct[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every fresh search; a loadMore started under an older token
  // discards its response, so a stale page can never append onto a newer
  // search's list.
  const searchTokenRef = useRef(0);

  // Fresh search / store change → reset and load page 1. The cancelled flag
  // discards stale responses (a slower earlier search must never overwrite a
  // newer one).
  useEffect(() => {
    let cancelled = false;
    const token = ++searchTokenRef.current;
    setLoaded([]);
    setNextCursor(null);
    setHasMore(false);
    setError(null);
    setLoading(true);
    getStoreProducts(key, { q: q || undefined, limit: 50 })
      .then((res) => {
        if (cancelled || searchTokenRef.current !== token) return;
        setLoaded(res.data);
        setNextCursor(res.nextCursor);
        setHasMore(res.hasMore);
      })
      .catch((e) => {
        if (!cancelled && searchTokenRef.current === token) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled && searchTokenRef.current === token) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, q]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    const token = searchTokenRef.current;
    setLoadingMore(true);
    setError(null);
    getStoreProducts(key, { q: q || undefined, limit: 50, cursor: nextCursor })
      .then((res) => {
        if (searchTokenRef.current !== token) return; // search changed mid-flight
        setLoaded((prev) => [...prev, ...res.data]);
        setNextCursor(res.nextCursor);
        setHasMore(res.hasMore);
      })
      .catch((e) => {
        if (searchTokenRef.current === token) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (searchTokenRef.current === token) setLoadingMore(false);
      });
  }, [key, q, nextCursor, loadingMore]);

  return { products: loaded, hasMore, loading, loadingMore, error, loadMore };
}

function StoreCataloguePage() {
  const { origin } = Route.useParams();
  // Normalize the raw route param so manually typed URLs (uppercase,
  // protocol, www) still match saved origins.
  const key = normalizeOrigin(origin);
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  // D1 read path — the normalized collections replace the legacy reads.
  const storeQuery = useQuery({
    queryKey: queryKeys.store(key),
    queryFn: () => getStore(key),
  });
  const snapshotsQuery = useQuery({
    queryKey: queryKeys.storeSnapshots(key),
    queryFn: () => getStoreSnapshots(key),
  });

  // The snapshot whose stats / detection profile / discovery log are shown
  // (the catalogue table itself is always the CURRENT state).
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Search is server-side (q=) — debounce so a keystroke isn't a request.
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => window.clearTimeout(id);
  }, [query]);
  const catalogue = useStoreCatalogue(key, debouncedQ);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const snapshots = snapshotsQuery.data?.data ?? [];
  const selected = snapshots.find((s) => s._id === snapshotId) ?? snapshots[0];
  const store = storeQuery.data?.data.store ?? null;
  const uniqueProducts =
    store?.productCount ?? selected?.productCount ?? catalogue.products.length;
  const priceCaptures = snapshots.reduce((n, s) => n + s.productCount, 0);
  const latestFinishedAt = snapshots[0]?.finishedAt;

  // The selected snapshot mapped to the shape StoreProfile expects — the
  // read path has no product arrays, so the count/URL pattern are passed as
  // overrides. Snapshots carry a `full` boolean (false = shallow check), the
  // Snapshot equivalent of the legacy `type` field.
  const profileCrawl: StoreProfileCrawl | undefined = useMemo(() => {
    if (!selected) return undefined;
    return {
      updatedAt: selected.finishedAt,
      stats: selected.stats,
      discovery: selected.discovery ?? undefined,
    };
  }, [selected]);

  // URL pattern for the profile card — derived from the first catalogue row.
  const urlPattern = catalogue.products[0]?.url
    ? productUrlPattern(catalogue.products[0].url)
    : null;
  // The selected snapshot's verbose discovery log (if any).
  const discoveryLog = selected?.discovery?.log;

  const crawlAgain = () => {
    prefillCrawlerOrigin(store?.origin ?? key);
    navigate({ to: "/sources" });
  };

  // Remove the store from the normalized collections (the frozen legacy
  // crawlresults data is intentionally left untouched).
  const deleteStoreMutation = useMutation({
    mutationFn: (k: string) => deleteStore(k),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.stores });
      // Refresh every crawl-derived query so the store disappears everywhere.
      invalidateCrawlData(queryClient);
      setConfirmDelete(false);
      navigate({ to: "/crawls" });
    },
    onError: () => setConfirmDelete(false),
  });

  // Keep the document title in sync with the store being viewed.
  useEffect(() => {
    document.title = `${key} — Store catalogue — Parity`;
  }, [key]);

  if (storeQuery.isError || snapshotsQuery.isError) {
    return (
      <ErrorState description="Couldn't load the store catalogue — check that the API is reachable." />
    );
  }
  if (storeQuery.isLoading || snapshotsQuery.isLoading) {
    return <LoadingState label="Loading store catalogue…" />;
  }

  // Never-crawled store (and nothing on the read path) → honest empty state.
  const hasAnyData =
    snapshots.length > 0 || catalogue.products.length > 0 || store != null;
  if (!hasAnyData && !catalogue.loading) {
    return (
      <div>
        <PageHeader
          eyebrow="Store catalogue"
          title={key}
          description="This store has no saved crawls."
          actions={
            <Button asChild variant="outline">
              <Link to="/crawls">
                <ArrowLeft className="size-4" /> Saved crawls
              </Link>
            </Button>
          }
        />
        <StateCard
          className="mx-6 mb-8"
          icon={<PackageSearch className="size-5 text-muted-foreground" />}
          title="No catalogue yet"
          description="Run a crawl on this store and its full product list will appear here — saved automatically, so you never start from zero."
          action={
            <>
              <Button
                onClick={() => {
                  prefillCrawlerOrigin(key);
                  navigate({ to: "/sources" });
                }}
              >
                <Play className="size-4" /> Crawl {key}
              </Button>
              <Button asChild variant="outline">
                <Link to="/crawls">Back to saved crawls</Link>
              </Button>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Store catalogue"
        title={key}
        description={`${uniqueProducts.toLocaleString()} products across ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"}${latestFinishedAt ? ` · last crawled ${formatCrawlDate(latestFinishedAt)}` : ""}`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/crawls">
                <ArrowLeft className="size-4" /> Saved crawls
              </Link>
            </Button>
            <Button variant="ghost" onClick={crawlAgain}>
              <RefreshCw className="size-4" /> Crawl again
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" /> Delete store
            </Button>
          </>
        }
      />

      <div className="space-y-6 px-6 py-8">
        {/* Snapshot details picker — drives the stats / profile / discovery
            log below. The catalogue table always shows the current state. */}
        {snapshots.length > 0 ? (
          <Card className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Snapshot details
            </span>
            <Select value={selected._id} onValueChange={setSnapshotId}>
              <SelectTrigger className="w-auto min-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {snapshots.map((s) => (
                  <SelectItem key={s._id} value={s._id}>
                    {formatCrawlDate(s.finishedAt)} · {s.productCount} products
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected ? (
              <span className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant={selected.full ? "outline" : "secondary"}
                  className="gap-1 font-normal"
                >
                  {selected.full ? "deep crawl" : "shallow check"}
                </Badge>
                {selected.addedCount > 0
                  ? `+${selected.addedCount} new`
                  : selected.removedCount > 0
                    ? `${selected.removedCount} removed`
                    : "no changes"}
              </span>
            ) : null}
          </Card>
        ) : null}

        {/* Stats for the selected snapshot */}
        {selected ? <CrawlStatsGrid stats={selected.stats} /> : null}

        {/* Detection profile (platform / sitemap / robots.txt) */}
        <StoreProfile
          crawl={profileCrawl}
          domain={key}
          productCount={selected?.productCount}
          urlPattern={urlPattern}
        />

        {/* Verbose discovery log — the specific reasons behind this result
            (which sitemaps were tried, why 0 products were found, …). */}
        {discoveryLog && discoveryLog.length > 0 ? (
          <DiscoveryLog lines={discoveryLog} />
        ) : null}

        {/* Catalogue — the CURRENT state, server-paginated (D1 read path) */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <PackageSearch className="size-4 text-muted-foreground" />
              <h3 className="font-display text-lg">Catalogue</h3>
              <Badge variant="secondary" className="font-normal">
                {uniqueProducts.toLocaleString()} unique products
              </Badge>
              {priceCaptures > 0 ? (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  · {priceCaptures.toLocaleString()} price captures across{" "}
                  {snapshots.length} snapshot
                  {snapshots.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="store-product-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, brand or URL…"
                aria-label="Search products"
                className="pl-9"
              />
            </div>
          </div>

          {catalogue.error ? (
            <p className="p-8 text-center text-sm text-destructive">
              {catalogue.error}
            </p>
          ) : catalogue.loading && catalogue.products.length === 0 ? (
            <div className="flex items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {debouncedQ
                ? `Searching for “${debouncedQ}”…`
                : "Loading catalogue…"}
            </div>
          ) : catalogue.products.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {debouncedQ
                ? `No products match “${debouncedQ}”.`
                : "No products in the catalogue yet — run a crawl to populate it."}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[280px]">Product</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead>Price history</TableHead>
                    <TableHead className="text-right">Latest price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {catalogue.products.map((p) => {
                    const points: SparkPoint[] = p.priceHistory.map((ph) => ({
                      date: formatCrawlDate(ph.t),
                      price: ph.price,
                    }));
                    const latest =
                      points[points.length - 1] ??
                      (p.price != null ? { date: "", price: p.price } : null);
                    const min =
                      points.length > 0
                        ? Math.min(...points.map((x) => x.price))
                        : null;
                    const max =
                      points.length > 0
                        ? Math.max(...points.map((x) => x.price))
                        : null;
                    return (
                      <TableRow key={p._id}>
                        <TableCell className="w-full max-w-0">
                          <ProductCell
                            name={p.name}
                            brand={p.brand}
                            url={p.url}
                          />
                          {min != null && max != null ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {points.length} price point
                              {points.length === 1 ? "" : "s"} · range{" "}
                              {formatPrice(min)} – {formatPrice(max)}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {p.brand || "—"}
                        </TableCell>
                        <TableCell>
                          <PriceSparkline prices={points} />
                        </TableCell>
                        <TableCell className="numeric text-right font-semibold">
                          {latest ? formatPrice(latest.price) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {catalogue.hasMore ? (
                <div className="flex justify-center border-t border-border p-4">
                  <Button
                    variant="outline"
                    onClick={catalogue.loadMore}
                    disabled={catalogue.loadingMore}
                  >
                    {catalogue.loadingMore ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ChevronDown className="size-4" />
                    )}
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {key}?</DialogTitle>
            <DialogDescription className="break-words">
              The store, all {snapshots.length} saved snapshot
              {snapshots.length === 1 ? "" : "s"} and{" "}
              {uniqueProducts.toLocaleString()} product
              {uniqueProducts === 1 ? "" : "s"} for{" "}
              <span className="font-mono">{key}</span> will be removed. You can
              re-crawl the store anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteStoreMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteStoreMutation.isPending}
              onClick={() => deleteStoreMutation.mutate(key)}
            >
              {deleteStoreMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete store
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
