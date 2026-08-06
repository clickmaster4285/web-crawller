import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { GitCompareArrows, Play, Plus, Store, UserPlus, X } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { AddCompetitorDialog } from "@/components/competitors/add-competitor-dialog";
import {
  ComparePanel,
  CompareSectionHeading,
} from "@/components/competitors/compare-stores";
import {
  StorePickerDialog,
  type StoreOption,
} from "@/components/competitors/store-picker-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/common/states";
import { useSavedCrawlMetas } from "@/hooks/useData";
import { useLocalStorageState } from "@/hooks/useLocalStorage";
import {
  getMyStoreData,
  invalidateMatchingData,
  queryKeys,
  setMyStoreData,
} from "@/api";
import {
  formatCrawlDate,
  normalizeOrigin,
  prefillCrawlerOrigin,
} from "@/utils/crawls";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/competitors/")({
  head: () => ({
    meta: [
      { title: "Competitors — Parity" },
      {
        name: "description",
        content:
          "Pick your website and up to four competitors to compare catalogues side by side — matched products, price differences and availability.",
      },
      { property: "og:title", content: "Competitors — Parity" },
      {
        property: "og:description",
        content:
          "Compare your store's catalogue against any crawled competitor in one place.",
      },
    ],
  }),
  component: CompetitorsPage,
});

/** How many competitor slots the page offers. */
const SLOT_COUNT = 4;

function CompetitorsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Lightweight crawl summaries (origin, platform, product count, timestamp —
  // no product arrays). Full catalogues are fetched lazily below, only for
  // the stores actually selected, so this page never downloads every store's
  // products at once (tens of thousands of products ≈ 10 MB).
  const { data: saved, isLoading, isError } = useSavedCrawlMetas();
  const stores = useMemo<StoreOption[]>(() => {
    const latest = new Map<string, StoreOption>();
    for (const c of saved?.data ?? []) {
      const key = normalizeOrigin(c.origin);
      if (!latest.has(key)) {
        latest.set(key, {
          key,
          origin: c.origin,
          productCount: c.productCount,
          platform: c.platform,
          updatedAt: c.updatedAt,
        });
      }
    }
    return [...latest.values()];
  }, [saved]);

  // Your website — a single persisted selection, used as store A everywhere.
  const myStoreQuery = useQuery({
    queryKey: queryKeys.myStore,
    queryFn: () => getMyStoreData(),
  });
  const myStore = myStoreQuery.data?.data ?? null;
  const myStoreKey = myStore?.origin ? normalizeOrigin(myStore.origin) : null;

  // Four competitor slots — all empty by default, persisted locally so the
  // selection survives a reload. Invalid keys (snapshots deleted) render empty.
  const [slots, setSlots] = useLocalStorageState<string[]>(
    "parity.competitors.slots",
    ["", "", "", ""],
  );
  // Always exactly SLOT_COUNT entries — invalid/removed keys (e.g. a snapshot
  // was deleted) render as empty so the slot can be re-picked.
  const validSlots = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const k = slots[i];
      out.push(k && stores.some((s) => s.key === k) ? k : "");
    }
    return out;
  }, [slots, stores]);

  // Matching runs server-side: the post-crawl pipeline persists ProductMatch
  // rows (GTIN > SKU > URL slug > name similarity), and every comparison
  // below reads them paginated from GET /api/match — the browser never
  // downloads the full catalogues (which is why there is no per-browser
  // fuzzy toggle anymore: the server owns matching now).

  // Which picker is open: "mine" for your website, a number for a slot index.
  const [pickerFor, setPickerFor] = useState<"mine" | number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const pickerExcludeKeys = useMemo(() => {
    if (pickerFor === "mine") return validSlots.filter(Boolean);
    if (typeof pickerFor === "number") {
      // Exclude the other filled slots (by their actual slot position) and
      // your website, so a store can't be picked twice.
      const others = validSlots.filter((k, i) => i !== pickerFor && k);
      return myStoreKey ? [...others, myStoreKey] : others;
    }
    return [];
  }, [pickerFor, validSlots, myStoreKey]);

  const selectMyStore = async (origin: string) => {
    try {
      await setMyStoreData({ origin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.myStore });
      // Your store drives the matching layer — refresh everything derived
      // from it (competitors list, matched products, analytics, pricing).
      // The saved crawl snapshots themselves are untouched.
      invalidateMatchingData(queryClient);
    } catch (error) {
      // The dialog already closed on select; surface failures to the console.
      console.error("Failed to set your website:", error);
    }
  };

  const selectSlot = (index: number) => (origin: string) => {
    const key = normalizeOrigin(origin);
    setSlots((prev) => {
      const next = [...prev];
      while (next.length < SLOT_COUNT) next.push("");
      next[index] = key;
      return next;
    });
  };

  const removeSlot = (index: number) =>
    setSlots((prev) => {
      const next = [...prev];
      while (next.length < SLOT_COUNT) next.push("");
      next[index] = "";
      return next;
    });

  const crawlNow = (origin: string) => {
    prefillCrawlerOrigin(origin);
    navigate({ to: "/sources" });
  };

  const myStoreMeta = myStoreKey
    ? stores.find((s) => s.key === myStoreKey)
    : undefined;
  const filledSlots = useMemo(() => {
    const out: Array<{ index: number; key: string; store: StoreOption }> = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const key = validSlots[i];
      if (!key) continue;
      const store = stores.find((s) => s.key === key);
      if (store) out.push({ index: i, key, store });
    }
    return out;
  }, [validSlots, stores]);

  const myLabel = myStoreKey ? `My website (${myStoreKey})` : "Your website";

  if (isError) return <ErrorState />;
  if (isLoading || !saved) return <LoadingState />;

  return (
    <div>
      <PageHeader
        eyebrow="Sources"
        title="Competitors"
        description="Choose your website, then pick up to four competitors from your crawled stores. Every comparison runs your catalogue against one competitor at a time."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" /> Add competitor
          </Button>
        }
      />

      {stores.length === 0 ? (
        <div className="mx-6 my-10 border border-dashed border-border bg-card p-10 text-center">
          <h2 className="font-display text-2xl">Nothing to compare yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Crawl a store (your own or a competitor's) and it will show up in
            the website picker here. With at least one crawled store you can set
            your website and fill the competitor slots below.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild variant="outline">
              <Link to="/sources">
                <Play className="size-4" /> Run a crawl
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> Add competitor
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Your website — the reference side of every comparison. */}
          <section className="mx-6 mt-8 border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <Store className="size-4 shrink-0 text-muted-foreground" />
                <h3 className="font-display text-lg">Your website</h3>
                {myStoreKey ? (
                  <Badge variant="secondary" className="font-normal">
                    Selected
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {myStoreKey ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPickerFor("mine")}
                    >
                      Change
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => myStore && crawlNow(myStore.origin)}
                    >
                      <Play className="size-3.5" />
                      {myStoreMeta ? "Crawl again" : "Crawl your website"}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => setPickerFor("mine")}>
                    <Store className="size-3.5" /> Choose website
                  </Button>
                )}
              </div>
            </div>
            {myStoreKey ? (
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
                <div className="min-w-0">
                  <p className="label-caps">Domain</p>
                  <p className="mt-1 truncate font-mono text-sm">
                    {myStoreKey}
                  </p>
                </div>
                <div>
                  <p className="label-caps">Products</p>
                  <p className="mt-1 numeric">
                    {myStoreMeta
                      ? myStoreMeta.productCount.toLocaleString()
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="label-caps">Platform</p>
                  <p className="mt-1">{myStoreMeta?.platform ?? "—"}</p>
                </div>
                <div>
                  <p className="label-caps">Last crawl</p>
                  <p className="mt-1">
                    {myStoreMeta ? formatCrawlDate(myStoreMeta.updatedAt) : "—"}
                  </p>
                </div>
                {!myStoreMeta ? (
                  <p className="w-full text-xs text-muted-foreground">
                    Your website hasn't been crawled yet — crawl it so its
                    catalogue can be compared against competitors.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="px-5 py-6 text-sm text-muted-foreground">
                Choose your website from the list of crawled stores. Every
                comparison below runs{" "}
                <span className="font-medium text-foreground">
                  your website
                </span>{" "}
                against one selected competitor.
              </p>
            )}
          </section>

          {/* Four competitor slots — empty until a website is chosen. */}
          <div className="grid gap-px bg-border px-6 pt-6 lg:grid-cols-4">
            {Array.from({ length: SLOT_COUNT }).map((_, i) => {
              const slot = filledSlots.find((s) => s.index === i);
              if (!slot) {
                return (
                  <div key={i} className="bg-card p-5">
                    <p className="label-caps">Competitor {i + 1}</p>
                    <div className="mt-4 flex flex-col items-center border border-dashed border-border px-4 py-8 text-center">
                      <UserPlus className="size-5 text-muted-foreground" />
                      <p className="mt-2 text-sm text-muted-foreground">
                        Select a competitor website to compare against yours.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        onClick={() => setPickerFor(i)}
                      >
                        Select competitor
                      </Button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="bg-card p-5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="label-caps">Competitor {i + 1}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Remove competitor ${i + 1}`}
                      onClick={() => removeSlot(i)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                  <h3 className="mt-2 truncate font-mono text-sm font-medium">
                    {slot.key}
                  </h3>
                  <dl className="mt-3 space-y-1.5 text-xs">
                    {[
                      ["Products", slot.store.productCount.toLocaleString()],
                      ["Platform", slot.store.platform ?? "—"],
                      ["Last crawl", formatCrawlDate(slot.store.updatedAt)],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="numeric truncate">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => setPickerFor(i)}
                    >
                      Change
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => crawlNow(slot.store.origin)}
                    >
                      <Play className="size-3.5" /> Crawl
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Comparisons — your website vs each selected competitor. */}
          <div className="space-y-5 px-6 py-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <GitCompareArrows className="size-4 text-muted-foreground" />
                <h2 className="font-display text-xl">Comparisons</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Matches are computed server-side and refreshed after every
                crawl.
              </p>
            </div>

            {!myStoreKey ? (
              <EmptyStateCard message="Choose your website above to compare it against competitors." />
            ) : !myStoreMeta ? (
              <EmptyStateCard
                message="Your website hasn't been crawled yet. Crawl it to compare catalogues."
                actionLabel="Crawl your website"
                onAction={() => myStore && crawlNow(myStore.origin)}
              />
            ) : filledSlots.length === 0 ? (
              <EmptyStateCard message="Select a competitor card above to see the comparison." />
            ) : (
              filledSlots.map((slot) => (
                <section
                  key={slot.key}
                  className="border border-border bg-card"
                >
                  <div className="border-b border-border px-5 py-3.5">
                    <CompareSectionHeading labelA={myLabel} labelB={slot.key} />
                  </div>
                  <div className="p-5">
                    {myStore ? (
                      <ComparePanel
                        competitorOrigin={slot.store.origin}
                        labelA={myLabel}
                        labelB={slot.key}
                      />
                    ) : null}
                  </div>
                </section>
              ))
            )}
          </div>
        </>
      )}

      <StorePickerDialog
        open={pickerFor !== null}
        onOpenChange={(open) => {
          if (!open) setPickerFor(null);
        }}
        stores={stores}
        excludeKeys={pickerExcludeKeys}
        onSelect={
          pickerFor === "mine"
            ? selectMyStore
            : typeof pickerFor === "number"
              ? selectSlot(pickerFor)
              : () => {}
        }
        title={
          pickerFor === "mine" ? "Choose your website" : "Choose a competitor"
        }
        description={
          pickerFor === "mine"
            ? "This store's catalogue becomes the reference side of every comparison."
            : "Pick a crawled store to fill this competitor slot."
        }
      />

      <AddCompetitorDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function EmptyStateCard({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className={cn(
        "border border-dashed border-border bg-card p-8 text-center",
      )}
    >
      <GitCompareArrows className="mx-auto size-5 text-muted-foreground" />
      <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
        {message}
      </p>
      {actionLabel && onAction ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={onAction}>
          <Play className="size-3.5" /> {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
