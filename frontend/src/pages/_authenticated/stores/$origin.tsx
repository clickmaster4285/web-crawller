import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
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
import { useSavedCrawls } from "@/hooks/useData";
import { usePagination } from "@/hooks/usePagination";
import { PaginationBar } from "@/components/common/pagination";
import {
  deleteCrawlResultsByOrigin,
  invalidateCrawlData,
  type SavedCrawlProduct,
} from "@/api";
import {
  formatCrawlDate,
  normalizeOrigin,
  prefillCrawlerOrigin,
} from "@/utils/crawls";
import { formatPrice } from "@/utils/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/stores/$origin")({
  component: StoreCataloguePage,
});

/** Sentinel snapshot-selector value meaning "union of every snapshot". */
const ALL_SNAPSHOTS = "__all__";

type SortKey = "name" | "price";
type SortDir = "asc" | "desc";

/** One product's price across every snapshot it appeared in (chronological). */
interface PriceTrail {
  product: SavedCrawlProduct;
  prices: Array<{ date: string; price: number }>;
}

/** Hover tooltip for a sparkline point — the snapshot date and its price. */
function SparklineTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { date: string; price: number } }>;
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
 * Compact price-history sparkline for the All-snapshots table. Coloured by
 * direction — green when the latest price is below the first (cheaper), red
 * when it rose, neutral when flat. A single snapshot renders as a price chip.
 */
function PriceSparkline({
  prices,
}: {
  prices: Array<{ date: string; price: number }>;
}) {
  const data = prices.map((p, i) => ({ i, date: p.date, price: p.price }));
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

/** Clickable table header that sorts by `key` (name or price). */
function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cn(
        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
        active && "text-foreground",
        className,
      )}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {active ? (
        sort.dir === "asc" ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        )
      ) : (
        <ArrowUpDown className="size-3 opacity-40" />
      )}
    </button>
  );
}

function StoreCataloguePage() {
  const { origin } = Route.useParams();
  // Normalize the raw route param so manually typed URLs (uppercase,
  // protocol, www) still match saved origins.
  const key = normalizeOrigin(origin);
  const saved = useSavedCrawls();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  // The snapshot being viewed — "all" shows every product across snapshots.
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Every snapshot of this store, newest first.
  const snapshots = useMemo(
    () =>
      (saved.data?.data ?? [])
        .filter((c) => normalizeOrigin(c.origin) === key)
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [saved.data, key],
  );

  const latest = snapshots[0];
  const viewAll = snapshotId === ALL_SNAPSHOTS;
  // Fall back to the newest snapshot if the picked id is stale (deleted).
  const crawl = viewAll
    ? latest
    : (snapshots.find((c) => c._id === snapshotId) ?? latest);

  const totalProducts = snapshots.reduce((n, c) => n + c.products.length, 0);

  // Union of every product seen in any snapshot, keyed by URL (slug fallback),
  // with a chronological price trail per product. This is the "all snapshots"
  // view — every item, every price it has had.
  const priceTrails = useMemo<PriceTrail[]>(() => {
    const map = new Map<string, PriceTrail>();
    for (const c of [...snapshots].reverse()) {
      const date = formatCrawlDate(c.updatedAt);
      for (const p of c.products) {
        const ukey = p.url || `name:${p.name}`;
        const entry = map.get(ukey);
        if (entry) entry.prices.push({ date, price: p.price });
        else map.set(ukey, { product: p, prices: [{ date, price: p.price }] });
      }
    }
    return [...map.values()];
  }, [snapshots]);

  // Search + sort helpers shared by the per-snapshot and all-snapshots tables.
  const q = query.trim().toLowerCase();
  const matches = (p: { name: string; brand: string; url: string }) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.brand.toLowerCase().includes(q) ||
    p.url.toLowerCase().includes(q);

  // Per-snapshot products (search + sort only).
  const products = useMemo(() => {
    if (!crawl) return [];
    const dir = sort.dir === "asc" ? 1 : -1;
    const filtered = crawl.products.filter(matches);
    return [...filtered].sort((a, b) =>
      sort.key === "price"
        ? (a.price - b.price) * dir
        : a.name.localeCompare(b.name) * dir,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crawl, query, sort]);

  // All-snapshots rows (search + sort by latest price or name).
  const trailRows = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    return priceTrails
      .filter((t) => matches(t.product))
      .sort((a, b) => {
        const latestPrice = (t: PriceTrail) =>
          t.prices[t.prices.length - 1]?.price ?? 0;
        return sort.key === "price"
          ? (latestPrice(a) - latestPrice(b)) * dir
          : a.product.name.localeCompare(b.product.name) * dir;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceTrails, query, sort]);

  const crawlAgain = (c: typeof crawl) => {
    if (!c) return;
    prefillCrawlerOrigin(c.origin);
    navigate({ to: "/sources" });
  };

  // Paginate both tables — per-snapshot rows and the all-snapshots union — so
  // full catalogues (thousands of products) render in fixed-size pages.
  const productsPager = usePagination(products, 50);
  const trailsPager = usePagination(trailRows, 50);

  // Remove this store from the saved crawls entirely (all snapshots).
  const deleteStore = useMutation({
    mutationFn: (origin: string) => deleteCrawlResultsByOrigin(origin),
    onSuccess: () => {
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

  if (saved.isError) {
    return (
      <ErrorState description="Couldn't load saved crawls — check that the API is reachable." />
    );
  }
  if (saved.isLoading || !saved.data) {
    return <LoadingState label="Loading store catalogue…" />;
  }

  if (snapshots.length === 0) {
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

  const parseRate =
    crawl.stats.fetched > 0
      ? Math.round((crawl.products.length / crawl.stats.fetched) * 100)
      : null;

  return (
    <div>
      <PageHeader
        eyebrow="Store catalogue"
        title={key}
        description={`${totalProducts.toLocaleString()} products across ${snapshots.length} snapshot${snapshots.length > 1 ? "s" : ""} · last crawled ${formatCrawlDate(latest.updatedAt)}`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/crawls">
                <ArrowLeft className="size-4" /> Saved crawls
              </Link>
            </Button>
            <Button variant="ghost" onClick={() => crawlAgain(latest)}>
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
        {/* Snapshot selector — a snapshot, or every snapshot at once */}
        <div className="flex flex-wrap items-center gap-3 border border-border bg-card px-5 py-3.5">
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Snapshot</span>
          <Select
            value={viewAll ? ALL_SNAPSHOTS : crawl._id}
            onValueChange={setSnapshotId}
          >
            <SelectTrigger className="w-auto min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SNAPSHOTS}>
                All snapshots · {totalProducts.toLocaleString()} captures
              </SelectItem>
              {snapshots.map((c) => (
                <SelectItem key={c._id} value={c._id}>
                  {formatCrawlDate(c.updatedAt)} · {c.products.length} products
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">
            {viewAll
              ? `${priceTrails.length.toLocaleString()} unique products`
              : `${crawl.products.length.toLocaleString()} products in this snapshot`}
          </span>
        </div>

        {/* Stats — per-snapshot stats, or a union summary for all snapshots */}
        {viewAll ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="border border-border bg-card p-4">
              <p className="label-caps">Unique products</p>
              <p className="mt-1.5 numeric text-2xl">
                {priceTrails.length.toLocaleString()}
              </p>
            </div>
            <div className="border border-border bg-card p-4">
              <p className="label-caps">Snapshots</p>
              <p className="mt-1.5 numeric text-2xl">
                {snapshots.length.toLocaleString()}
              </p>
            </div>
            <div className="border border-border bg-card p-4">
              <p className="label-caps">Price captures</p>
              <p className="mt-1.5 numeric text-2xl">
                {totalProducts.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                One price per product per snapshot — every point is a real
                crawl.
              </p>
            </div>
          </div>
        ) : (
          <CrawlStatsGrid stats={crawl.stats} />
        )}

        {/* Detection profile (platform / sitemap / robots.txt) */}
        <StoreProfile crawl={latest} domain={key} />

        {/* Verbose discovery log — the specific reasons behind this result
            (e.g. which sitemaps were tried and what they contained, why 0
            products were found, platform/server details). */}
        {latest.discovery?.log?.length ? (
          <DiscoveryLog lines={latest.discovery.log} />
        ) : null}

        {/* Product list */}
        <section className="border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <PackageSearch className="size-4 text-muted-foreground" />
              <h3 className="font-display text-lg">
                {viewAll ? "All products" : "Products"}
              </h3>
              {viewAll ? (
                <Badge variant="secondary" className="font-normal">
                  {priceTrails.length.toLocaleString()} unique
                </Badge>
              ) : parseRate != null ? (
                <Badge variant="secondary" className="font-normal">
                  {parseRate}% parsed
                </Badge>
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

          {viewAll ? (
            trailRows.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {q
                  ? `No products match “${query}”.`
                  : "No products were captured in any snapshot."}
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[280px]">
                        <SortHeader
                          label="Product"
                          k="name"
                          sort={sort}
                          onSort={(k) =>
                            setSort((s) => ({
                              key: k,
                              dir:
                                s.key === k && s.dir === "asc" ? "desc" : "asc",
                            }))
                          }
                        />
                      </TableHead>
                      <TableHead>Brand</TableHead>
                      <TableHead>Price history</TableHead>
                      <TableHead className="text-right">
                        <SortHeader
                          label="Latest price"
                          k="price"
                          sort={sort}
                          className="w-full justify-end"
                          onSort={(k) =>
                            setSort((s) => ({
                              key: k,
                              dir:
                                s.key === k && s.dir === "asc" ? "desc" : "asc",
                            }))
                          }
                        />
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trailsPager.pageItems.map((t) => {
                      const latestPrice = t.prices[t.prices.length - 1].price;
                      const min = Math.min(...t.prices.map((p) => p.price));
                      const max = Math.max(...t.prices.map((p) => p.price));
                      return (
                        <TableRow key={t.product.url || t.product.name}>
                          <TableCell className="max-w-0 w-full">
                            <ProductCell
                              name={t.product.name}
                              url={t.product.url}
                            />
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              Seen in {t.prices.length} snapshot
                              {t.prices.length === 1 ? "" : "s"} · range{" "}
                              {formatPrice(min)} – {formatPrice(max)}
                            </p>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {t.product.brand || "—"}
                          </TableCell>
                          <TableCell>
                            <PriceSparkline prices={t.prices} />
                          </TableCell>
                          <TableCell className="numeric text-right font-semibold">
                            {formatPrice(latestPrice)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {trailsPager.total > 0 ? (
                  <PaginationBar
                    page={trailsPager.page}
                    totalPages={trailsPager.totalPages}
                    total={trailsPager.total}
                    pageSize={trailsPager.pageSize}
                    onPageChange={trailsPager.setPage}
                    onPageSizeChange={trailsPager.setPageSize}
                  />
                ) : null}
              </>
            )
          ) : crawl.products.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No products were parsed in this snapshot — the store may have
              rate-limited the crawl or no structured data was found.
            </p>
          ) : products.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No products match “{query}”.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[280px]">
                    <SortHeader
                      label="Product"
                      k="name"
                      sort={sort}
                      onSort={(k) =>
                        setSort((s) => ({
                          key: k,
                          dir: s.key === k && s.dir === "asc" ? "desc" : "asc",
                        }))
                      }
                    />
                  </TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead className="text-right">
                    <SortHeader
                      label="Price"
                      k="price"
                      sort={sort}
                      className="w-full justify-end"
                      onSort={(k) =>
                        setSort((s) => ({
                          key: k,
                          dir: s.key === k && s.dir === "asc" ? "desc" : "asc",
                        }))
                      }
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productsPager.pageItems.map((p) => (
                  <TableRow key={p.url}>
                    <TableCell className="max-w-0 w-full">
                      <ProductCell name={p.name} url={p.url} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.brand || "—"}
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {formatPrice(p.price)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!viewAll && productsPager.total > 0 ? (
            <PaginationBar
              page={productsPager.page}
              totalPages={productsPager.totalPages}
              total={productsPager.total}
              pageSize={productsPager.pageSize}
              onPageChange={productsPager.setPage}
              onPageSizeChange={productsPager.setPageSize}
            />
          ) : null}
        </section>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {key}?</DialogTitle>
            <DialogDescription className="break-words">
              All {snapshots.length} saved snapshot
              {snapshots.length === 1 ? "" : "s"} for{" "}
              <span className="font-mono">{key}</span> will be removed from your
              saved crawls. You can re-crawl the store anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteStore.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteStore.isPending}
              onClick={() => deleteStore.mutate(latest.origin)}
            >
              {deleteStore.isPending ? (
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
