import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BadgePercent,
  GitCompareArrows,
  Loader2,
  Play,
  Store,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

import { CrawlDiffTile } from "@/components/cards/crawl-diff-tile";
import { PriceDelta } from "@/components/common/price-delta";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSavedCrawls } from "@/hooks/useData";
import { useLocalStorageState } from "@/hooks/useLocalStorage";
import {
  getMyStoreData,
  setMyStoreData,
  type SavedCrawl,
  type SavedCrawlProduct,
} from "@/lib/api";
import { compareStores } from "@/utils/compare";
import {
  normalizeOrigin,
  prefillCrawlerOrigin,
  toOriginUrl,
} from "@/utils/crawls";
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

/** Product + price + stock table used by the "Only A" / "Only B" tabs. */
function ProductsTab({
  products,
  emptyLabel,
}: {
  products: SavedCrawlProduct[];
  emptyLabel: string;
}) {
  if (products.length === 0) {
    return <EmptyTab label={emptyLabel} />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Stock</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((p) => (
          <TableRow key={p.url}>
            <TableCell className="max-w-0 w-full">
              <ProductCell name={p.name} url={p.url} />
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
  );
}

interface Store {
  key: string;
  crawl: SavedCrawl;
}

/**
 * Catalogue comparison between two crawled stores — including your own store
 * (set via the "Your store" bar). Matching products (by normalized name / URL
 * slug) are shown side by side with price differences, plus products found in
 * only one of the two stores.
 */
export function CompareStores() {
  const saved = useSavedCrawls();
  const queryClient = useQueryClient();
  const [aKey, setAKey] = useState("");
  const [bKey, setBKey] = useState("");
  // Fuzzy mode also matches near-identical product names, not just exact ones.
  // Both the mode and its strictness are persisted across visits.
  const [fuzzy, setFuzzy] = useLocalStorageState(
    "parity.competitors.fuzzy",
    false,
  );
  // Similarity floor for fuzzy matches (0.5–0.95); clamped defensively in case
  // a stale value was persisted.
  const [rawThreshold, setThreshold] = useLocalStorageState(
    "parity.competitors.fuzzyThreshold",
    0.8,
  );
  // NaN (corrupt persisted value) falls back to the default 0.8.
  const threshold = Number.isFinite(rawThreshold)
    ? Math.min(0.95, Math.max(0.5, rawThreshold))
    : 0.8;

  // Your store — the single document the user sets so they can compare their
  // own catalogue against competitors.
  const myStoreQuery = useQuery({
    queryKey: ["my-store"],
    queryFn: () => getMyStoreData(),
  });
  const myStore = myStoreQuery.data?.data ?? null;
  const myStoreKey = myStore?.origin ? normalizeOrigin(myStore.origin) : null;

  const [editingStore, setEditingStore] = useState(false);
  const [storeInput, setStoreInput] = useState("");
  const [savingStore, setSavingStore] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);

  const saveMyStore = async () => {
    const normalized = toOriginUrl(storeInput);
    if (!/^https?:\/\/\S+$/i.test(normalized)) return;
    setSavingStore(true);
    setStoreError(null);
    try {
      await setMyStoreData({ origin: normalized });
      void queryClient.invalidateQueries({ queryKey: ["my-store"] });
      void queryClient.invalidateQueries({ queryKey: ["competitors"] });
      setStoreInput("");
      setEditingStore(false);
    } catch (error) {
      setStoreError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingStore(false);
    }
  };

  const stores = useMemo<Store[]>(() => {
    const latest = new Map<string, SavedCrawl>();
    for (const c of saved.data?.data ?? []) {
      const key = normalizeOrigin(c.origin);
      if (!latest.has(key)) latest.set(key, c);
    }
    return [...latest.entries()].map(([key, crawl]) => ({ key, crawl }));
  }, [saved.data]);

  const label = (key: string) =>
    key === myStoreKey ? `My store (${key})` : key;

  // Keep the two selections valid and distinct: prefer your own store as
  // Store A once set; fill in defaults on first load and repair invalid or
  // colliding selections (e.g. a store's snapshots were deleted).
  useEffect(() => {
    if (stores.length < 2) return;
    const valid = (k: string) => stores.some((s) => s.key === k);
    const defaultA =
      myStoreKey && valid(myStoreKey) ? myStoreKey : stores[0].key;
    const a = valid(aKey) ? aKey : defaultA;
    let b = valid(bKey) && bKey !== a ? bKey : "";
    if (!b || b === a) {
      b = stores.find((s) => s.key !== a)?.key ?? stores[1].key;
    }
    if (a !== aKey) setAKey(a);
    if (b !== bKey) setBKey(b);
  }, [stores, aKey, bKey, myStoreKey]);

  const storeA = stores.find((s) => s.key === aKey)?.crawl;
  const storeB = stores.find((s) => s.key === bKey)?.crawl;

  const comparison = useMemo(
    () =>
      storeA && storeB
        ? compareStores(storeA.products, storeB.products, {
            fuzzy,
            fuzzyThreshold: threshold,
          })
        : null,
    [storeA, storeB, fuzzy, threshold],
  );

  // Your store is set but hasn't been crawled — the compare needs its data.
  const myStoreNotCrawled =
    !!myStoreKey && !stores.some((s) => s.key === myStoreKey);

  const myStoreBar = (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-5 py-3">
      <Store className="size-4 shrink-0 text-muted-foreground" />
      <span className="label-caps">Your store</span>
      {myStore ? (
        <>
          <span className="truncate font-mono text-xs">{myStoreKey}</span>
          {myStoreNotCrawled ? (
            <Button asChild variant="outline" size="sm" className="h-7">
              <Link
                to="/sources"
                onClick={() => prefillCrawlerOrigin(myStore.origin)}
              >
                <Play className="size-3.5" /> Crawl your store
              </Link>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => {
                setStoreInput(myStore.origin);
                setEditingStore(true);
              }}
            >
              Change
            </Button>
          )}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">
          Set your store URL to compare your own catalogue against competitors.
        </span>
      )}
      {editingStore || !myStore ? (
        <>
          <Input
            value={storeInput}
            onChange={(e) => setStoreInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveMyStore();
            }}
            placeholder="mystore.com"
            className="h-8 w-56 font-mono text-xs"
            aria-label="Your store domain"
          />
          <Button
            size="sm"
            className="h-8"
            disabled={savingStore || !toOriginUrl(storeInput)}
            onClick={() => void saveMyStore()}
          >
            {savingStore ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Store className="size-3.5" />
            )}
            Save
          </Button>
          {editingStore ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setEditingStore(false)}
            >
              Cancel
            </Button>
          ) : null}
        </>
      ) : null}
      {storeError ? (
        <span className="text-xs text-destructive">{storeError}</span>
      ) : null}
    </div>
  );

  if (stores.length < 2) {
    return (
      <section className="border border-border bg-card">
        {myStoreBar}
        <div className="p-8 text-center">
          <GitCompareArrows className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 font-display text-xl">Compare stores</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {stores.length === 0
              ? myStore
                ? "Crawl one competitor to compare against your store."
                : "Set your store and crawl at least one competitor to compare catalogues side by side."
              : "Crawl one more store to compare catalogues side by side."}
          </p>
          <Button asChild variant="outline" className="mt-5">
            <Link to="/sources">Run a crawl</Link>
          </Button>
        </div>
      </section>
    );
  }

  const matched = comparison
    ? [...comparison.matched].sort(
        (x, y) => Math.abs(y.priceDiff) - Math.abs(x.priceDiff),
      )
    : [];
  const onlyA = comparison?.onlyA ?? [];
  const onlyB = comparison?.onlyB ?? [];
  const fuzzyCount = matched.filter((m) => m.fuzzy).length;

  return (
    <section className="border border-border bg-card">
      {myStoreBar}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="size-4 text-muted-foreground" />
          <h3 className="font-display text-lg">Compare stores</h3>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label
            htmlFor="compare-fuzzy"
            className="flex cursor-pointer items-center gap-2"
          >
            <Switch
              id="compare-fuzzy"
              checked={fuzzy}
              onCheckedChange={setFuzzy}
            />
            <span className="text-xs font-medium">Fuzzy matching</span>
          </label>
          <label
            htmlFor="fuzzy-threshold"
            className="flex items-center gap-2"
            aria-disabled={!fuzzy}
          >
            <span
              className={`text-xs text-muted-foreground${fuzzy ? "" : " opacity-50"}`}
            >
              Similarity
            </span>
            <input
              id="fuzzy-threshold"
              type="range"
              min={50}
              max={95}
              step={5}
              value={Math.round(threshold * 100)}
              onChange={(e) => setThreshold(Number(e.target.value) / 100)}
              disabled={!fuzzy}
              aria-label="Similarity threshold for fuzzy name matching"
              className="w-32 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span
              className={`numeric w-9 text-right text-xs${fuzzy ? "" : " opacity-50"}`}
            >
              {Math.round(threshold * 100)}%
            </span>
          </label>
          <p className="text-xs text-muted-foreground">
            {fuzzy
              ? `Exact matches plus names ≥ ${Math.round(threshold * 100)}% similar.`
              : "Products matched by exact name / URL slug across each store's latest crawl."}
          </p>
        </div>
      </div>

      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <div className="grid gap-2">
            <Label>Store A</Label>
            <Select value={aKey} onValueChange={setAKey}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stores
                  .filter((s) => s.key !== bKey)
                  .map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {label(s.key)} · {s.crawl.products.length} products
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <ArrowRight className="mx-auto hidden size-4 self-center text-muted-foreground sm:block" />
          <div className="grid gap-2">
            <Label>Store B</Label>
            <Select value={bKey} onValueChange={setBKey}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stores
                  .filter((s) => s.key !== aKey)
                  .map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {label(s.key)} · {s.crawl.products.length} products
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {comparison ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <CrawlDiffTile
                tone="neutral"
                value={String(comparison.matched.length)}
                label="in both stores"
              />
              <CrawlDiffTile
                tone="success"
                value={String(comparison.onlyA.length)}
                label={`only in ${label(aKey)}`}
              />
              <CrawlDiffTile
                tone="destructive"
                value={String(comparison.onlyB.length)}
                label={`only in ${label(bKey)}`}
              />
              <CrawlDiffTile
                tone="warning"
                value={String(comparison.priceChangedCount)}
                label="price differs"
              />
            </div>

            {fuzzy && fuzzyCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                ≈ {fuzzyCount} of the matches are fuzzy — similar names, not
                identical. Hover the “≈ fuzzy” tag to see the similarity score.
              </p>
            ) : null}

            <Tabs defaultValue="matches">
              <TabsList className="h-auto flex-wrap">
                <TabsTrigger value="matches">
                  Matches ({matched.length})
                </TabsTrigger>
                <TabsTrigger value="onlyA">
                  Only {label(aKey)} ({onlyA.length})
                </TabsTrigger>
                <TabsTrigger value="onlyB">
                  Only {label(bKey)} ({onlyB.length})
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
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">
                          {label(aKey)} price
                        </TableHead>
                        <TableHead className="text-right">
                          {label(bKey)} price
                        </TableHead>
                        <TableHead className="text-right">Difference</TableHead>
                        <TableHead className="text-right">Cheapest</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matched.map((m) => {
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
                              <PriceDelta
                                before={m.a.price}
                                after={m.b.price}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end">
                                <CheapestBadge
                                  a={m.a.price}
                                  b={m.b.price}
                                  labelA={label(aKey)}
                                  labelB={label(bKey)}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>

              <TabsContent value="onlyA">
                <ProductsTab
                  products={onlyA}
                  emptyLabel={`No products that only ${label(aKey)} sells.`}
                />
              </TabsContent>

              <TabsContent value="onlyB">
                <ProductsTab
                  products={onlyB}
                  emptyLabel={`No products that only ${label(bKey)} sells.`}
                />
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Pick two stores to compare their catalogues.
          </p>
        )}
      </div>
    </section>
  );
}
