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
import { useSavedCrawls } from "@/hooks/useData";
import { useLocalStorageState } from "@/hooks/useLocalStorage";
import {
  deleteCrawlResult,
  deleteCrawlResultsByOrigin,
  invalidateCrawlData,
  type SavedCrawl,
} from "@/api";
import { crawlType, normalizeOrigin } from "@/utils/crawls";

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
  // Job-type filter — "all" shows every snapshot; "shallow"/"deep" focus on
  // the sitemap-only checks (or full crawls) only. Persisted like the rest of
  // the page state so a refresh keeps the view. Old snapshots without a `type`
  // field were all deep crawls, so they count as deep.
  const [typeFilter, setTypeFilter] = useLocalStorageState<TypeFilter>(
    "parity.crawls.typeFilter",
    "all",
  );
  // Which stores have their snapshot history revealed — hidden by default.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const isGroupOpen = (key: string) => openGroups[key] ?? false;
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  const allCrawls = useMemo(() => saved.data?.data ?? [], [saved.data]);
  // Type-filtered snapshot list (before grouping) — stores with no matching
  // snapshots disappear, and the stat cards reflect only what's shown.
  const crawls = useMemo(
    () =>
      typeFilter === "all"
        ? allCrawls
        : allCrawls.filter((c) => crawlType(c) === typeFilter),
    [allCrawls, typeFilter],
  );

  const closeConfirm = () => setConfirm(null);
  const deleteOne = useMutation({
    mutationFn: (id: string) => deleteCrawlResult(id),
    onSuccess: () => {
      invalidateCrawlData(queryClient);
      setConfirm(null);
    },
    onError: closeConfirm,
  });
  const clearOrigin = useMutation({
    mutationFn: (origin: string) => deleteCrawlResultsByOrigin(origin),
    onSuccess: () => {
      invalidateCrawlData(queryClient);
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

  // Per-type counts over ALL snapshots (unfiltered) — the toggle shows real
  // numbers even while a filter is active.
  const typeCounts = useMemo(
    () => ({
      shallow: allCrawls.filter((c) => crawlType(c) === "shallow").length,
      deep: allCrawls.filter((c) => crawlType(c) === "deep").length,
    }),
    [allCrawls],
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
                  group={group}
                  typeFilter={typeFilter}
                  open={isGroupOpen(key)}
                  onToggleOpen={() => toggleGroup(key)}
                  onRecrawl={recrawl}
                  onClearHistory={(origin, count) =>
                    setConfirm({ kind: "origin", origin, count })
                  }
                  prevById={prevById}
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
