import { CrawlStat } from "@/components/cards/crawl-stat";

/** Stats shape shared by saved snapshots and live crawl results. */
export interface CrawlStats {
  discovered: number;
  fetched: number;
  skippedUnchanged: number;
  failed: number;
  durationMs: number;
}

/** The standard 5-tile crawl stats row (discovered/fetched/skipped/failed/duration). */
export function CrawlStatsGrid({ stats }: { stats: CrawlStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <CrawlStat label="Discovered" value={stats.discovered} />
      <CrawlStat label="Fetched" value={stats.fetched} />
      <CrawlStat label="Skipped" value={stats.skippedUnchanged} />
      <CrawlStat
        label="Failed"
        value={stats.failed}
        accent={stats.failed > 0}
      />
      <CrawlStat
        label="Duration"
        value={`${(stats.durationMs / 1000).toFixed(1)}s`}
      />
    </div>
  );
}
