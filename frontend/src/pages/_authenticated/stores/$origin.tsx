import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Globe,
  PackageSearch,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { StoreProfile } from "@/components/crawls/store-profile";
import { CrawlStatsGrid } from "@/components/cards/crawl-stats-grid";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type SortKey = "name" | "price";
type SortDir = "asc" | "desc";

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

  // The snapshot being viewed — defaults to the newest for this store.
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });

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

  // Fall back to the newest snapshot if the picked id is stale (deleted).
  const crawl = snapshots.find((c) => c._id === snapshotId) ?? snapshots[0];

  // Search + sort the selected snapshot's products.
  const products = useMemo(() => {
    if (!crawl) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? crawl.products.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.brand.toLowerCase().includes(q) ||
            p.url.toLowerCase().includes(q),
        )
      : crawl.products;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) =>
      sort.key === "price"
        ? (a.price - b.price) * dir
        : a.name.localeCompare(b.name) * dir,
    );
  }, [crawl, query, sort]);

  const totalProducts = snapshots.reduce((n, c) => n + c.products.length, 0);

  const crawlAgain = (c: typeof crawl) => {
    if (!c) return;
    prefillCrawlerOrigin(c.origin);
    navigate({ to: "/sources" });
  };

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
        description={`${totalProducts.toLocaleString()} products across ${snapshots.length} snapshot${snapshots.length > 1 ? "s" : ""} · last crawled ${formatCrawlDate(snapshots[0].updatedAt)}`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/crawls">
                <ArrowLeft className="size-4" /> Saved crawls
              </Link>
            </Button>
            <Button onClick={() => crawlAgain(crawl)}>
              <RefreshCw className="size-4" /> Crawl again
            </Button>
          </>
        }
      />

      <div className="space-y-6 px-6 py-8">
        {/* Snapshot selector */}
        {snapshots.length > 1 ? (
          <div className="flex flex-wrap items-center gap-3 border border-border bg-card px-5 py-3.5">
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Snapshot</span>
            <Select value={crawl._id} onValueChange={(v) => setSnapshotId(v)}>
              <SelectTrigger className="w-auto min-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {snapshots.map((c) => (
                  <SelectItem key={c._id} value={c._id}>
                    {formatCrawlDate(c.updatedAt)} · {c.products.length}{" "}
                    products
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs text-muted-foreground">
              {crawl.products.length.toLocaleString()} products in this snapshot
            </span>
          </div>
        ) : null}

        {/* Stats for the selected snapshot */}
        <CrawlStatsGrid stats={crawl.stats} />

        {/* Detection profile (platform / sitemap / robots.txt) */}
        <StoreProfile crawl={crawl} domain={key} />

        {/* Full product list */}
        <section className="border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <PackageSearch className="size-4 text-muted-foreground" />
              <h3 className="font-display text-lg">Products</h3>
              {parseRate != null ? (
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

          {crawl.products.length === 0 ? (
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
                  <TableHead className="text-right">Stock</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
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
                    <TableCell className="text-right">
                      <StockBadge available={p.available} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {products.length > 0 ? (
            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              Showing {products.length.toLocaleString()} of{" "}
              {crawl.products.length.toLocaleString()} products
              {query.trim() ? ` matching “${query.trim()}”` : ""}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
