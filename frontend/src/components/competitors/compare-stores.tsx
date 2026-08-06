import { useEffect, useMemo, useRef, useState } from "react";
import { BadgePercent, GitCompareArrows, Loader2 } from "lucide-react";

import { PaginationBar } from "@/components/common/pagination";
import { usePagination } from "@/hooks/usePagination";

import { CrawlDiffTile } from "@/components/cards/crawl-diff-tile";
import { PriceDelta } from "@/components/common/price-delta";
import { ProductCell } from "@/components/common/product-cell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SavedCrawl, SavedCrawlProduct } from "@/api";
import { compareStoresAsync, type StoreComparison } from "@/utils/compare";
import { formatPrice } from "@/utils/format";

/** Which store sells a matched product cheaper — or "same price". */
function CheapestBadge({
  a,
  b,
  labelA,
  labelB,
}: {
  a: number;
  b: number;
  labelA: string;
  labelB: string;
}) {
  const comparable = a > 0 && b > 0;
  if (comparable && a !== b) {
    const cheaper = a < b ? labelA : labelB;
    return (
      <Badge
        className="max-w-40 whitespace-nowrap border-success/40 bg-success/10 font-normal text-success"
        title={`Cheaper in ${cheaper}`}
      >
        <BadgePercent className="size-3 shrink-0" />
        <span className="truncate">{cheaper}</span>
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {comparable ? "Same price" : "—"}
    </Badge>
  );
}

function EmptyTab({ label }: { label: string }) {
  return (
    <p className="border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
      {label}
    </p>
  );
}

/** Product + price table used by the "Only A" / "Only B" tabs. */
function ProductsTab({
  products,
  emptyLabel,
}: {
  products: SavedCrawlProduct[];
  emptyLabel: string;
}) {
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageItems } =
    usePagination(products, 25);
  if (products.length === 0) {
    return <EmptyTab label={emptyLabel} />;
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageItems.map((p) => (
            <TableRow key={p.url}>
              <TableCell className="max-w-0 w-full">
                <ProductCell name={p.name} url={p.url} />
              </TableCell>
              <TableCell className="numeric text-right">
                {formatPrice(p.price)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationBar
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </>
  );
}

/**
 * Catalogue comparison between a fixed pair of crawled stores — "your website"
 * as store A and one selected competitor as store B. Matching products (by
 * normalized name / URL slug) are shown side by side with price differences,
 * plus products found in only one of the two stores.
 *
 * Fuzzy matching and its similarity floor are controlled by the parent so a
 * single toggle applies to every competitor at once.
 */
export function ComparePanel({
  storeA,
  storeB,
  labelA,
  labelB,
  fuzzy,
  threshold,
}: {
  storeA: SavedCrawl;
  storeB: SavedCrawl;
  labelA: string;
  labelB: string;
  fuzzy: boolean;
  threshold: number;
}) {
  // Cheap fingerprint of everything that affects the result. The page's 30s
  // refetch hands back fresh object identities with *identical* data, so the
  // effect keys on this fingerprint instead of the objects — otherwise the
  // whole comparison (tens of thousands of products) would recompute on every
  // poll for data that didn't change.
  const fingerprint = useMemo(
    () =>
      [
        storeA.updatedAt,
        storeA.products.length,
        storeB.updatedAt,
        storeB.products.length,
        fuzzy,
        threshold,
      ].join("|"),
    [storeA, storeB, fuzzy, threshold],
  );
  const fingerprintRef = useRef<string | null>(null);
  const [comparison, setComparison] = useState<StoreComparison | null>(null);
  const [computing, setComputing] = useState(true);

  useEffect(() => {
    // Same snapshots as last time (e.g. the 30s refetch found nothing new) —
    // keep the existing result instead of recomputing the comparison. The
    // fingerprint is only recorded *after* a run completes, so a cancelled
    // invocation (e.g. a double-mount) is always retried by the next one
    // instead of being skipped.
    if (fingerprintRef.current === fingerprint) return;
    let cancelled = false;
    setComparison(null);
    setComputing(true);
    // Async + chunked: the fuzzy pass yields to the event loop between
    // slices, so large catalogues never block the main thread (no "Page
    // Unresponsive" while this runs).
    void compareStoresAsync(storeA.products, storeB.products, {
      fuzzy,
      fuzzyThreshold: threshold,
    })
      .then((result) => {
        if (cancelled) return;
        setComparison(result);
        fingerprintRef.current = fingerprint;
      })
      .finally(() => {
        if (!cancelled) setComputing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fingerprint, storeA, storeB, fuzzy, threshold]);

  // Hooks must be unconditional — derive paginated rows from a memoised list
  // so the computing guard below can early-return safely.
  const matched = useMemo(
    () =>
      comparison
        ? [...comparison.matched].sort(
            (x, y) => Math.abs(y.priceDiff) - Math.abs(x.priceDiff),
          )
        : [],
    [comparison],
  );
  const matchedPager = usePagination(matched, 25);

  if (computing || !comparison) {
    return (
      <div className="flex items-center gap-3 border border-dashed border-border bg-muted/30 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        Comparing {storeA.products.length.toLocaleString()} vs{" "}
        {storeB.products.length.toLocaleString()} products…
      </div>
    );
  }

  const onlyA = comparison.onlyA;
  const onlyB = comparison.onlyB;
  const fuzzyCount = matched.filter((m) => m.fuzzy).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CrawlDiffTile
          tone="neutral"
          value={String(comparison.matched.length)}
          label="in both stores"
        />
        <CrawlDiffTile
          tone="success"
          value={String(onlyA.length)}
          label={`only in ${labelA}`}
        />
        <CrawlDiffTile
          tone="destructive"
          value={String(onlyB.length)}
          label={`only in ${labelB}`}
        />
        <CrawlDiffTile
          tone="warning"
          value={String(comparison.priceChangedCount)}
          label="price differs"
        />
      </div>

      {comparison.fuzzySkipped ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
          Fuzzy matching was stopped partway — the catalogues are too large to
          compare in the browser. Exact matches (identical name / URL slug) and
          the fuzzy matches found so far are shown.
        </p>
      ) : null}

      {fuzzy && fuzzyCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          ≈ {fuzzyCount} of the matches are fuzzy — similar names, not
          identical. Hover the “≈ fuzzy” tag to see the similarity score.
        </p>
      ) : null}

      <Tabs defaultValue="matches">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="matches">Matches ({matched.length})</TabsTrigger>
          <TabsTrigger value="onlyA">
            Only {labelA} ({onlyA.length})
          </TabsTrigger>
          <TabsTrigger value="onlyB">
            Only {labelB} ({onlyB.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="matches">
          {matched.length === 0 ? (
            <EmptyTab
              label={
                fuzzy
                  ? "No products matched between these stores. Try lowering the similarity threshold."
                  : "No products matched between these stores (matching is by exact name or URL slug). Try enabling fuzzy matching."
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">{labelA} price</TableHead>
                    <TableHead className="text-right">{labelB} price</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                    <TableHead className="text-right">Cheapest</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matchedPager.pageItems.map((m) => {
                    const comparable = m.a.price > 0 && m.b.price > 0;
                    const aCheaper = comparable && m.a.price < m.b.price;
                    const bCheaper = comparable && m.b.price < m.a.price;
                    return (
                      <TableRow key={m.key}>
                        <TableCell className="max-w-0 w-full">
                          <ProductCell name={m.a.name} url={m.a.url} />
                          {m.fuzzy ? (
                            <>
                              <span
                                className="mt-1 inline-flex items-center rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                                title={
                                  m.similarity != null
                                    ? `Matched by name similarity (${Math.round(m.similarity * 100)}%)`
                                    : "Matched approximately"
                                }
                              >
                                ≈ fuzzy
                              </span>
                              <span className="mt-1 block truncate text-xs text-muted-foreground">
                                ≈ {m.b.name}
                              </span>
                            </>
                          ) : null}
                        </TableCell>
                        <TableCell className="numeric text-right">
                          <span
                            className={
                              aCheaper
                                ? "font-semibold text-success"
                                : "text-muted-foreground"
                            }
                          >
                            {formatPrice(m.a.price)}
                          </span>
                        </TableCell>
                        <TableCell className="numeric text-right">
                          <span
                            className={
                              bCheaper
                                ? "font-semibold text-success"
                                : "text-muted-foreground"
                            }
                          >
                            {formatPrice(m.b.price)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <PriceDelta before={m.a.price} after={m.b.price} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end">
                            <CheapestBadge
                              a={m.a.price}
                              b={m.b.price}
                              labelA={labelA}
                              labelB={labelB}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <PaginationBar
                page={matchedPager.page}
                totalPages={matchedPager.totalPages}
                total={matchedPager.total}
                pageSize={matchedPager.pageSize}
                onPageChange={matchedPager.setPage}
                onPageSizeChange={matchedPager.setPageSize}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="onlyA">
          <ProductsTab
            products={onlyA}
            emptyLabel={`No products that only ${labelA} sells.`}
          />
        </TabsContent>

        <TabsContent value="onlyB">
          <ProductsTab
            products={onlyB}
            emptyLabel={`No products that only ${labelB} sells.`}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Section heading shown above a single competitor's comparison. */
export function CompareSectionHeading({
  labelA,
  labelB,
}: {
  labelA: string;
  labelB: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <GitCompareArrows className="size-4 text-muted-foreground" />
      <h3 className="font-display text-base">
        <span className="text-muted-foreground">{labelA}</span>
        {"  vs  "}
        {labelB}
      </h3>
    </div>
  );
}
