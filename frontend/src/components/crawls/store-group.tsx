import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Globe, RefreshCw, Trash2 } from "lucide-react";

import { CrawlRow } from "./crawl-row";
import type { TypeFilter } from "./crawl-type-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { StoreSnapshot } from "@/api";
import type { StoreHealth } from "@/lib/crawl";
import { formatCrawlDate } from "@/utils/crawls";
import { HealthChip } from "@/components/sources/health-chip";

/**
 * One store's snapshot history on /crawls: a header (domain, count, actions)
 * and either the collapsed hint or the expanded list of CrawlRows. Reads the
 * D1 read path — each row is a Snapshot doc (metadata + ingest-time change
 * counts), never a full product dump.
 */
export function StoreGroup({
  storeKey,
  origin,
  storeCount,
  health,
  group,
  typeFilter,
  open,
  onToggleOpen,
  onRecrawl,
  onClearHistory,
  expandedId,
  onToggleRow,
  onDeleteRow,
}: {
  /** Normalized host (route param for the store link). */
  storeKey: string;
  /** Store origin URL (recrawl prefill + clear-history label). */
  origin: string;
  /** Current catalogue size — the store's live product count. */
  storeCount: number;
  /**
   * P4 store-health pass — last pre-flight verdict, so a 0-product store
   * (no-products / blocked / corporate) is flagged right in the history list
   * without running a fresh analysis.
   */
  health?: StoreHealth | null;
  /** Snapshots for this store, newest first. */
  group: StoreSnapshot[];
  /** Active type filter — shown in the subtitle when not "all". */
  typeFilter: TypeFilter;
  open: boolean;
  onToggleOpen: () => void;
  onRecrawl: (snapshot: StoreSnapshot) => void;
  onClearHistory: (origin: string, count: number) => void;
  expandedId: string | null;
  onToggleRow: (id: string) => void;
  onDeleteRow: (id: string, origin: string) => void;
}) {
  const latest = group[0];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-mono text-sm font-medium">
              <Link
                to="/stores/$origin"
                params={{ origin: storeKey }}
                className="truncate transition-colors hover:text-primary hover:underline"
              >
                {storeKey}
              </Link>
              {health?.verdict ? (
                <HealthChip verdict={health.verdict} score={health.score} />
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {group.length} snapshot
              {group.length > 1 ? "s" : ""}
              {typeFilter === "all" ? "" : ` (${typeFilter})`} ·{" "}
              {latest.productCount.toLocaleString()} products in the latest run
              · last {formatCrawlDate(latest.finishedAt)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            onClick={onToggleOpen}
          >
            {open ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            {open ? "Hide history" : "Show history"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onRecrawl(latest)}>
            <RefreshCw className="size-3.5" /> Crawl again
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onClearHistory(origin, group.length)}
          >
            <Trash2 className="size-3.5" /> Clear history
          </Button>
        </div>
      </div>

      {open ? (
        <Card className="divide-y divide-border">
          {group.map((snapshot, i) => (
            <CrawlRow
              key={snapshot._id}
              snapshot={snapshot}
              origin={origin}
              storeKey={storeKey}
              storeCount={storeCount}
              hasPrevious={i < group.length - 1}
              expanded={expandedId === snapshot._id}
              onToggle={() => onToggleRow(snapshot._id)}
              onRecrawl={() => onRecrawl(snapshot)}
              onDelete={() => onDeleteRow(snapshot._id, origin)}
            />
          ))}
        </Card>
      ) : (
        <p className="border border-dashed border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">
          {group.length} snapshot
          {group.length > 1 ? "s" : ""} hidden — press “Show history” to view
          this store's crawl history.
        </p>
      )}
    </div>
  );
}
