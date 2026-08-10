import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Globe, RefreshCw, Trash2 } from "lucide-react";

import { CrawlRow } from "./crawl-row";
import type { TypeFilter } from "./crawl-type-toggle";
import { Button } from "@/components/ui/button";
import type { SavedCrawl } from "@/api";
import { formatCrawlDate } from "@/utils/crawls";

/**
 * One store's snapshot history on /crawls: a header (domain, count, actions)
 * and either the collapsed hint or the expanded list of CrawlRows.
 */
export function StoreGroup({
  storeKey,
  group,
  typeFilter,
  open,
  onToggleOpen,
  onRecrawl,
  onClearHistory,
  prevById,
  expandedId,
  onToggleRow,
  onDeleteRow,
}: {
  storeKey: string;
  group: SavedCrawl[];
  /** Active type filter — shown in the subtitle when not "all". */
  typeFilter: TypeFilter;
  open: boolean;
  onToggleOpen: () => void;
  onRecrawl: (crawl: SavedCrawl) => void;
  onClearHistory: (origin: string, count: number) => void;
  /** Snapshot that precedes each crawl (for "+N new" badges). */
  prevById: Map<string, SavedCrawl>;
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
            <p className="truncate font-mono text-sm font-medium">
              <Link
                to="/stores/$origin"
                params={{ origin: storeKey }}
                className="transition-colors hover:text-primary hover:underline"
              >
                {storeKey}
              </Link>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {group.length} snapshot
              {group.length > 1 ? "s" : ""}
              {typeFilter === "all" ? "" : ` (${typeFilter})`} ·{" "}
              {/* The store's current catalogue size = the LATEST snapshot's
                  capture. Summing every snapshot double-counts products that
                  appear in multiple runs (e.g. 4 snapshots × 5,086 ≠ 20,340).
                  Each individual CrawlRow below still shows its own count. */}
              {latest.products.length.toLocaleString()} products · last{" "}
              {formatCrawlDate(latest.updatedAt)}
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
            onClick={() => onClearHistory(latest.origin, group.length)}
          >
            <Trash2 className="size-3.5" /> Clear history
          </Button>
        </div>
      </div>

      {open ? (
        <div className="divide-y divide-border border border-border bg-card">
          {group.map((crawl) => (
            <CrawlRow
              key={crawl._id}
              crawl={crawl}
              previous={prevById.get(crawl._id)}
              expanded={expandedId === crawl._id}
              onToggle={() => onToggleRow(crawl._id)}
              onRecrawl={() => onRecrawl(crawl)}
              onDelete={() => onDeleteRow(crawl._id, crawl.origin)}
            />
          ))}
        </div>
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
