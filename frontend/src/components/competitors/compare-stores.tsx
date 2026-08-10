import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BadgePercent, Check, GitCompareArrows, Loader2 } from "lucide-react";

import { PaginationBar } from "@/components/common/pagination";
import { PriceDelta } from "@/components/common/price-delta";
import { ProductCell } from "@/components/common/product-cell";
import { CrawlDiffTile } from "@/components/cards/crawl-diff-tile";
import { StorePill } from "@/components/competitors/store-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/api";
import {
  getMatchesForCompetitor,
  type CompetitorMatches,
  type MatchSideList,
  type MatchSideProduct,
} from "@/api/matching";
import { cn } from "@/lib/utils";
import { normalizeOrigin } from "@/utils/crawls";
import { formatPrice } from "@/utils/format";

const PAGE_SIZE = 25;

/**
 * Formats a price that may be missing (server rows can carry `null`);
 * appends the native currency code when one was detected, so a GCC store's
 * AED price never reads like a bare USD number.
 */
function formatMaybePrice(
  price: number | null,
  currency?: string | null,
): string {
  if (price != null && price > 0) {
    const c = (currency ?? "").trim().toUpperCase();
    return c ? `${formatPrice(price)} ${c}` : formatPrice(price);
  }
  return "—";
}

/**
 * The comparison value for one side: the USD-normalized price when the rates
 * table converted it (fxService at ingest); the native price only when both
 * sides share a currency (null === null counts — legacy rows). Cross-currency
 * rows without a conversion return null → not comparable.
 */
function effectivePrice(
  usd: number | null | undefined,
  native: number,
  sameCurrency: boolean,
): number | null {
  if (usd != null && usd > 0) return usd;
  return sameCurrency && native > 0 ? native : null;
}

/** Which store sells a matched product cheaper — or "same price". */
function CheapestBadge({
  a,
  b,
  labelA,
  labelB,
}: {
  a: number | null;
  b: number | null;
  labelA: string;
  labelB: string;
}) {
  const comparable = a != null && b != null && a > 0 && b > 0;
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

/** The match tier a row was paired by, with its confidence as a tooltip. */
function MethodBadge({
  method,
  confidence,
}: {
  method: string;
  confidence: number;
}) {
  const fuzzy = method === "fuzzy";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm"
      title={
        fuzzy
          ? `Matched by name similarity (${confidence}%)`
          : `Matched by ${method} (${confidence}%)`
      }
    >
      <GitCompareArrows className="size-3 shrink-0" />
      {fuzzy ? "≈ fuzzy" : method}
    </span>
  );
}

/**
 * Price difference for a matched row — the absolute delta (colored by
 * direction) plus a small percentage, so a reader sees both "how much" and
 * "how much %" at a glance.
 */
function DifferenceCell({ aEff, bEff }: { aEff: number; bEff: number }) {
  const pct = aEff > 0 ? Math.abs((bEff - aEff) / aEff) * 100 : null;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <PriceDelta before={aEff} after={bEff} />
      {pct != null && pct >= 0.1 ? (
        <span className="numeric text-[11px] text-muted-foreground">
          {pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`}
        </span>
      ) : null}
    </div>
  );
}

/** Tone-specific card styling for the two sides of a match row. */
const SIDE_TONES = {
  a: { card: "border-primary/15 bg-primary/5" },
  b: { card: "border-accent/25 bg-accent/10" },
} as const;

/** Column template shared by the matches header and rows — flexible product
 *  columns with fixed-width action columns. Fixed widths matter here: every
 *  row is its own grid instance, so `auto` columns would resolve to per-row
 *  widths and the header labels would drift off their columns. */
const MATCH_GRID =
  "grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_6rem_11rem] gap-3";

/**
 * One side of a matched pair, rendered as a self-contained product card:
 * store pill + name/URL + native price (with USD estimate when converted).
 * Every match row shows BOTH cards side by side, so it reads "my product
 * (my price) vs their product (their price)" with nothing hidden.
 */
function MatchSideCell({
  label,
  side,
  cheaper,
  tone,
}: {
  label: string;
  side: MatchSideProduct;
  cheaper: boolean;
  tone: "a" | "b";
}) {
  const t = SIDE_TONES[tone];
  const usd = side.priceUsd != null && side.priceUsd > 0 ? side.priceUsd : null;
  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col rounded-lg border p-3",
        t.card,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <StorePill label={label} tone={tone === "a" ? "mine" : "competitor"} />
        {!side.available ? (
          <span className="shrink-0 rounded border border-destructive/25 bg-destructive/5 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            out of stock
          </span>
        ) : null}
      </div>
      <ProductCell name={side.name} url={side.url} />
      <div className="mt-auto">
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
          <span
            className={cn(
              "numeric text-lg leading-none font-semibold",
              cheaper && "text-success",
            )}
          >
            {formatMaybePrice(side.price, side.currency)}
          </span>
          {cheaper ? (
            <Badge className="shrink-0 gap-1 border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
              <Check className="size-3" /> best price
            </Badge>
          ) : null}
        </div>
        {usd != null ? (
          <span className="mt-1.5 block text-[11px] text-muted-foreground">
            ≈ {formatPrice(usd)} USD
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Server-paginated "Only A" / "Only B" tab. */
function ProductsTab({
  list,
  page,
  onPageChange,
  emptyLabel,
}: {
  list: MatchSideList;
  page: number;
  onPageChange: (page: number) => void;
  emptyLabel: string;
}) {
  if (list.total === 0) {
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
          {list.rows.map((p) => (
            <TableRow key={p.productId}>
              <TableCell className="max-w-0 w-full">
                <ProductCell name={p.name} url={p.url} />
              </TableCell>
              <TableCell className="numeric text-right">
                {formatMaybePrice(p.price, p.currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationBar
        page={page}
        totalPages={Math.max(1, Math.ceil(list.total / PAGE_SIZE))}
        total={list.total}
        pageSize={PAGE_SIZE}
        onPageChange={onPageChange}
      />
    </>
  );
}

type CompareTab = "matches" | "onlyA" | "onlyB";

/**
 * Catalogue comparison between your website and one competitor — served by
 * the indexed matcher (`GET /api/match`), so the browser NEVER downloads the
 * two full catalogues: matched rows and the only-A / only-B lists are
 * paginated server-side (~25 rows per page). Matches are persisted by the
 * post-crawl pipeline (GTIN > SKU > URL slug > name similarity) and read
 * with zero recomputation.
 */
export function ComparePanel({
  competitorOrigin,
  labelA,
  labelB,
}: {
  competitorOrigin: string;
  labelA: string;
  labelB: string;
}) {
  const competitorKey = normalizeOrigin(competitorOrigin);
  // Each tab keeps its own page, so paging through Matches and switching to
  // Only-A doesn't lose your place.
  const [tab, setTab] = useState<CompareTab>("matches");
  const [pages, setPages] = useState<Record<CompareTab, number>>({
    matches: 1,
    onlyA: 1,
    onlyB: 1,
  });
  const page = pages[tab];
  const setPage = (next: number) =>
    setPages((prev) => ({ ...prev, [tab]: Math.max(1, next) }));

  const query = useQuery({
    queryKey: [...queryKeys.competitorMatches, competitorKey, tab, page],
    queryFn: () =>
      getMatchesForCompetitor(competitorOrigin, { page, limit: PAGE_SIZE }),
    // Matches are recomputed by the post-crawl pipeline; invalidateCrawlData /
    // invalidateMatchingData (query-keys.ts) refresh them after a crawl or a
    // "your website" change, so a long-lived page doesn't show stale rows.
    staleTime: 60_000,
  });
  const data: CompetitorMatches | null = query.data?.data ?? null;

  if (query.isError && !data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border border-dashed border-destructive/40 bg-destructive/5 p-6 text-sm text-muted-foreground">
        <p>Couldn't load the comparison for {labelB}.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (query.isLoading && !data) {
    return (
      <div className="flex items-center gap-3 border border-dashed border-border bg-muted/30 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        Loading the comparison…
      </div>
    );
  }
  if (!data) {
    return (
      <EmptyTab label="No matching data for this pair yet — crawl both stores and the matcher will pair them after each crawl." />
    );
  }

  const matched = data.rows;
  const activeList =
    tab === "matches"
      ? null
      : tab === "onlyA"
        ? data.onlyMine
        : data.onlyTheirs;
  const fuzzyCount = matched.filter((m) => m.method === "fuzzy").length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CrawlDiffTile
          tone="neutral"
          value={String(data.total)}
          label="in both stores"
        />
        <CrawlDiffTile
          tone="success"
          value={String(data.onlyMine.total)}
          label={`only in ${labelA}`}
        />
        <CrawlDiffTile
          tone="destructive"
          value={String(data.onlyTheirs.total)}
          label={`only in ${labelB}`}
        />
        <CrawlDiffTile
          tone="warning"
          value={String(data.priceDifferCount)}
          label="price differs"
        />
      </div>

      {fuzzyCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          ≈ {fuzzyCount} of the matches on this page are fuzzy — similar names,
          not identical. Hover the “≈ fuzzy” tag to see the similarity score.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Matches are computed server-side (GTIN &gt; SKU &gt; URL slug &gt;
          name similarity) and refreshed after every crawl. Prices are shown in
          each store's own currency, with a USD estimate under converted values.
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as CompareTab)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="matches">
            Matches ({data.total.toLocaleString()})
          </TabsTrigger>
          <TabsTrigger value="onlyA">
            Only {labelA} ({data.onlyMine.total.toLocaleString()})
          </TabsTrigger>
          <TabsTrigger value="onlyB">
            Only {labelB} ({data.onlyTheirs.total.toLocaleString()})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="matches">
          {matched.length === 0 ? (
            <EmptyTab
              label={
                data.total === 0
                  ? "No products matched between these stores yet — crawl both stores so the matcher can pair them."
                  : "No more matches to show — you're past the last page."
              }
            />
          ) : (
            <>
              <div className="space-y-2">
                <div
                  className={`${MATCH_GRID} items-center px-2 pb-1 text-xs font-medium text-muted-foreground`}
                >
                  <span className="truncate">{labelA}</span>
                  <span className="text-center">Match</span>
                  <span className="truncate">{labelB}</span>
                  <span className="text-right">Difference</span>
                  <span className="text-right">Cheapest</span>
                </div>
                {matched.map((m) => {
                  const aPrice = m.mine.price ?? 0;
                  const bPrice = m.theirs.price ?? 0;
                  // Cross-currency safety: compare USD-normalized prices
                  // when available, native only when both stores share a
                  // currency — AED 100 vs PKR 100 must never read as equal.
                  const sameCurrency = m.mine.currency === m.theirs.currency;
                  const aEff = effectivePrice(
                    m.mine.priceUsd,
                    aPrice,
                    sameCurrency,
                  );
                  const bEff = effectivePrice(
                    m.theirs.priceUsd,
                    bPrice,
                    sameCurrency,
                  );
                  const comparable = aEff != null && bEff != null;
                  const aCheaper =
                    comparable && aEff != null && bEff != null && aEff < bEff;
                  const bCheaper =
                    comparable && aEff != null && bEff != null && bEff < aEff;
                  // Whether the comparison ran on USD-normalized prices
                  // (vs native same-currency prices) — drives the tooltip
                  // text below so it never mislabels the basis.
                  const usedUsd =
                    m.mine.priceUsd != null || m.theirs.priceUsd != null;
                  return (
                    <div
                      key={m.id}
                      className="rounded-lg border border-border bg-card p-2 transition-colors hover:bg-muted/20"
                    >
                      <div className={`${MATCH_GRID} items-stretch`}>
                        <MatchSideCell
                          label={labelA}
                          side={m.mine}
                          cheaper={aCheaper}
                          tone="a"
                        />
                        <div className="flex items-center justify-center">
                          <MethodBadge
                            method={m.method}
                            confidence={m.confidence}
                          />
                        </div>
                        <MatchSideCell
                          label={labelB}
                          side={m.theirs}
                          cheaper={bCheaper}
                          tone="b"
                        />
                        <div className="flex flex-col items-end justify-start gap-0.5">
                          {aEff != null && bEff != null ? (
                            <span
                              className="inline-block"
                              title={`${formatPrice(aEff)} vs ${formatPrice(bEff)}${usedUsd ? " (USD-converted)" : ""}`}
                            >
                              <DifferenceCell aEff={aEff} bEff={bEff} />
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              different currencies
                            </span>
                          )}
                        </div>
                        <div className="flex items-start justify-end">
                          <CheapestBadge
                            a={aEff}
                            b={bEff}
                            labelA={labelA}
                            labelB={labelB}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <PaginationBar
                page={page}
                totalPages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
                total={data.total}
                pageSize={PAGE_SIZE}
                onPageChange={setPage}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="onlyA">
          {activeList ? (
            <ProductsTab
              list={activeList}
              page={page}
              onPageChange={setPage}
              emptyLabel={`No products that only ${labelA} sells.`}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="onlyB">
          {activeList ? (
            <ProductsTab
              list={activeList}
              page={page}
              onPageChange={setPage}
              emptyLabel={`No products that only ${labelB} sells.`}
            />
          ) : null}
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
