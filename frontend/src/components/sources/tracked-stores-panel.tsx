import { Link } from "@tanstack/react-router";
import { Globe, HeartPulse } from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { HealthChip } from "@/components/sources/health-chip";
import { EmptyState } from "@/components/common/empty-state";
import type { StoreSummary } from "@/api";
import type { StoreHealthVerdict } from "@/lib/crawl";
import { formatCrawlDate } from "@/utils/crawls";

/**
 * P4 store-health pass — the at-a-glance health column. Lists EVERY tracked
 * store with its verdict so a 0-product store (no-products / blocked /
 * corporate) is visible before you waste a crawl on it. Problem verdicts
 * sort to the top; a healthy store with no verdict yet reads "—" until it's
 * analyzed (Run analysis or a deep crawl).
 */
export function TrackedStoresPanel({
  stores,
  onPickStore,
}: {
  /** Every tracked store (StoreSummary from GET /api/stores). */
  stores: StoreSummary[];
  /** Loads the store's origin into the crawler (one-click re-run). */
  onPickStore: (origin: string) => void;
}) {
  // Verdict priority: the expensive dead ends first, then unknown, then
  // healthy. Null verdict (never analyzed) sorts last.
  const VERDICT_RANK: Record<StoreHealthVerdict, number> = {
    "no-products": 0,
    blocked: 1,
    corporate: 2,
    unclear: 3,
    healthy: 4,
  };
  const sorted = [...stores].sort((a, b) => {
    const ra = a.health ? VERDICT_RANK[a.health.verdict] : 5;
    const rb = b.health ? VERDICT_RANK[b.health.verdict] : 5;
    if (ra !== rb) return ra - rb;
    // Ties: most products first (a healthy big store beats a healthy tiny one).
    return b.productCount - a.productCount;
  });

  if (stores.length === 0) {
    return (
      <section>
        <h2 className="label-caps mb-3 flex items-center gap-2">
          <HeartPulse className="size-4" /> Store health
        </h2>
        <EmptyState
          icon={Globe}
          title="No tracked stores yet"
          description="Crawl a store above and it appears here with its health verdict — so a 0-product store is flagged before you waste a crawl on it."
        />
      </section>
    );
  }

  return (
    <section>
      <h2 className="label-caps mb-3 flex items-center gap-2">
        <HeartPulse className="size-4" /> Store health
      </h2>
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Store</TableHead>
              <TableHead className="text-right">Products</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Last crawled</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((s) => (
              <TableRow
                key={s.key}
                className="cursor-pointer"
                onClick={() => onPickStore(s.origin)}
              >
                <TableCell>
                  <span className="flex items-center gap-2 font-mono text-xs">
                    <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                    <Link
                      to="/stores/$origin"
                      params={{ origin: s.key }}
                      className="truncate transition-colors hover:text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {s.key}
                    </Link>
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.productCount.toLocaleString()}
                </TableCell>
                <TableCell>
                  {s.health ? (
                    <HealthChip
                      verdict={s.health.verdict}
                      score={s.health.score}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {s.lastCrawl?.at
                    ? formatCrawlDate(s.lastCrawl.at)
                    : "never crawled"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Verdicts come from the pre-flight analysis (Run analysis, or the probe
        before a deep crawl). Click a row to load it into the crawler.
      </p>
    </section>
  );
}
