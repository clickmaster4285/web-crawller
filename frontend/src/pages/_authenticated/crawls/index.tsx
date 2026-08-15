import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Play, Search } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { StatCard } from "@/components/cards/stat-card";
import {
  CrawlTypeToggle,
  type TypeFilter,
} from "@/components/crawls/crawl-type-toggle";
import { StoreGroup } from "@/components/crawls/store-group";
import {
  DeleteCrawlDialog,
  type ConfirmTarget,
} from "@/components/crawls/delete-crawl-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ErrorState,
  LoadingState,
  StateCard,
} from "@/components/common/states";
import { useStoresWithSnapshots } from "@/hooks/useData";
import { useLocalStorageState } from "@/hooks/useLocalStorage";
import {
  deleteStoreSnapshot,
  deleteStoreSnapshots,
  invalidateCrawlData,
  type StoreSnapshot,
  type StoreSummary,
} from "@/api";
import { normalizeOrigin, snapshotType } from "@/utils/crawls";

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

/** One snapshot plus the store it belongs to (the D1 read-path shape). */
type CrawlEntry = { store: StoreSummary; snapshot: StoreSnapshot };

function CrawlsPage() {
  const saved = useStoresWithSnapshots();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useLocalStorageState<string | null>(
    "parity.crawls.expandedCrawlId",
    null,
  );
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  // Job-type filter — "all" shows every snapshot; "shallow"/"deep" focus on
  // the sitemap-only checks (or full crawls) only. Persisted like the rest of
  // the page state so a refresh keeps the view. Snapshot.full is the
  // normalized equivalent of the legacy `type` field (false = shallow).
  const [typeFilter, setTypeFilter] = useLocalStorageState<TypeFilter>(
    "parity.crawls.typeFilter",
    "all",
  );
  // Which stores have their snapshot history revealed — hidden by default.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const isGroupOpen = (key: string) => openGroups[key] ?? false;
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  const allStores = useMemo(() => saved.data?.data ?? [], [saved.data]);
  // Flatten to (store, snapshot) entries — stores with no snapshots (e.g.
  // the catalogue survives but history was cleared) don't appear on /crawls.
  const allEntries = useMemo<CrawlEntry[]>(
    () =>
      allStores.flatMap((store) =>
        (store.snapshots ?? []).map((snapshot) => ({ store, snapshot })),
      ),
    [allStores],
  );
  // Type-filtered entries (before grouping) — stores with no matching
  // snapshots disappear, and the stat cards reflect only what's shown.
  const entries = useMemo(
    () =>
      typeFilter === "all"
        ? allEntries
        : allEntries.filter(
            ({ snapshot }) => snapshotType(snapshot) === typeFilter,
          ),
    [allEntries, typeFilter],
  );

  const closeConfirm = () => setConfirm(null);
  const deleteOne = useMutation({
    mutationFn: ({ key, id }: { key: string; id: string }) =>
      deleteStoreSnapshot(key, id),
    onSuccess: () => {
      invalidateCrawlData(queryClient);
      setConfirm(null);
    },
    onError: closeConfirm,
  });
  const clearOrigin = useMutation({
    mutationFn: (key: string) => deleteStoreSnapshots(key),
    onSuccess: () => {
      invalidateCrawlData(queryClient);
      setConfirm(null);
    },
    onError: closeConfirm,
  });
  const deleting =
    confirm?.kind === "id" ? deleteOne.isPending : clearOrigin.isPending;

  // Snapshots grouped per store (newest first within each group — the server
  // returns them sorted); groups sorted by their newest snapshot.
  const groups = useMemo(() => {
    const map = new Map<string, CrawlEntry[]>();
    for (const e of entries) {
      const arr = map.get(e.store.key);
      if (arr) arr.push(e);
      else map.set(e.store.key, [e]);
    }
    return [...map.entries()].sort(
      (a, b) =>
        new Date(b[1][0].snapshot.finishedAt).getTime() -
        new Date(a[1][0].snapshot.finishedAt).getTime(),
    );
  }, [entries]);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(([key, group]) =>
      group.some(
        (e) => e.store.origin.toLowerCase().includes(q) || key.includes(q),
      ),
    );
  }, [groups, query]);

  // The store's CURRENT catalogue size = the live product count per store
  // (the latest snapshot's own count is also valid; store.productCount is the
  // products-collection truth). Failures stay a true historical total.
  const totals = useMemo(() => {
    const latestPerStore = groups.map(([, group]) => group[0]);
    return {
      products: latestPerStore.reduce((n, e) => n + e.store.productCount, 0),
      failures: entries.reduce((n, e) => n + e.snapshot.failures.length, 0),
      urls: latestPerStore.reduce(
        (n, e) => n + (e.snapshot.stats.discovered ?? 0),
        0,
      ),
    };
  }, [groups, entries]);

  // Per-type counts over ALL snapshots (unfiltered) — the toggle shows real
  // numbers even while a filter is active.
  const typeCounts = useMemo(
    () => ({
      shallow: allEntries.filter(
        ({ snapshot }) => snapshotType(snapshot) === "shallow",
      ).length,
      deep: allEntries.filter(
        ({ snapshot }) => snapshotType(snapshot) === "deep",
      ).length,
    }),
    [allEntries],
  );

  /** Prefills the crawler page (it reads these localStorage keys on mount). */
  const recrawl = (entry: CrawlEntry) => {
    try {
      window.localStorage.setItem(
        "parity.sources.origin",
        JSON.stringify(entry.store.origin),
      );
      window.localStorage.setItem(
        "parity.sources.collections",
        JSON.stringify(""),
      );
    } catch {
      // Storage unavailable — the crawler page keeps its last values.
    }
    navigate({ to: "/sources" });
  };

  const handleConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === "id") {
      const key = normalizeOrigin(confirm.origin);
      deleteOne.mutate({ key, id: confirm.id });
    } else {
      clearOrigin.mutate(normalizeOrigin(confirm.origin));
    }
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
          value={entries.length.toLocaleString()}
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

      {entries.length === 0 ? (
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
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by domain…"
                className="pl-9"
              />
            </div>
            <CrawlTypeToggle
              value={typeFilter}
              onChange={setTypeFilter}
              counts={typeCounts}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              {query.trim()
                ? `No saved crawls match “${query}”.`
                : typeFilter === "all"
                  ? "No saved crawls yet."
                  : typeFilter === "shallow"
                    ? "No shallow checks saved — run a Quick check on /sources to spot new products between deep crawls."
                    : "No deep crawls saved — run a full crawl on /sources to build the catalogue."}
            </p>
          ) : (
            <div className="space-y-8">
              {filtered.map(([key, group]) => (
                <StoreGroup
                  key={key}
                  storeKey={key}
                  origin={group[0].store.origin}
                  storeCount={group[0].store.productCount}
                  group={group.map((e) => e.snapshot)}
                  typeFilter={typeFilter}
                  open={isGroupOpen(key)}
                  onToggleOpen={() => toggleGroup(key)}
                  onRecrawl={(snapshot) => {
                    const entry = group.find(
                      (e) => e.snapshot._id === snapshot._id,
                    );
                    if (entry) recrawl(entry);
                  }}
                  onClearHistory={(origin, count) =>
                    setConfirm({ kind: "origin", origin, count })
                  }
                  expandedId={expandedId}
                  onToggleRow={(id) =>
                    setExpandedId(expandedId === id ? null : id)
                  }
                  onDeleteRow={(id, origin) =>
                    setConfirm({ kind: "id", id, origin })
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      <DeleteCrawlDialog
        target={confirm}
        deleting={deleting}
        onConfirm={handleConfirm}
        onCancel={closeConfirm}
      />
    </div>
  );
}
