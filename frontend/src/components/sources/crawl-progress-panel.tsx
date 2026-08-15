import {
  BadgeCheck,
  Cpu,
  Loader2,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Square,
  TriangleAlert,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TierBadge } from "@/components/sources/tier-badge";
import { RunLog } from "@/components/crawls/run-log";
import type { CrawlJob, CrawlJobDiscovery } from "@/lib/crawl";
import { formatDuration } from "@/utils/format";
import { cn } from "@/lib/utils";

/** Human label for the live discovery phase shown in the progress panel. */
function discoveryPhaseLabel(phase: CrawlJobDiscovery["phase"]): string {
  switch (phase) {
    case "collections":
      return "Collections";
    case "sitemap":
      return "Sitemap";
    case "htmlCrawl":
      return "HTML crawl";
    case "done":
      return "Discovery complete";
  }
}

/** Live progress panel — rendered while a crawl job is running. */
export function CrawlProgressPanel({
  job,
  shallowRun,
  reconnected,
  liveDiscovery,
  discoveryMs,
  fetchElapsedMs,
  fetchStarted,
  remainingMs,
  paramsMatch,
  paused,
  controlPending,
  onPause,
  onResume,
  onCancel,
}: {
  job: CrawlJob;
  shallowRun: boolean;
  /** A running crawl was restored from localStorage / ?job= (not started here). */
  reconnected: boolean;
  /** Non-null while the discovery phase runs (job.total stays 0 until fetch). */
  liveDiscovery: CrawlJobDiscovery | null;
  discoveryMs: number;
  fetchElapsedMs: number;
  /** True once the fetch phase has begun (as opposed to pure discovery). */
  fetchStarted: boolean;
  remainingMs: number | null;
  /** False when the panel config diverges from the job's captured params. */
  paramsMatch: boolean;
  /** True while a pause request is pending or the crawl is actually held. */
  paused: boolean;
  controlPending: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-3 border border-border bg-card p-6">
      {reconnected ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="secondary"
            className="gap-1.5 border-primary/30 font-normal"
          >
            <RefreshCw className="size-3 text-primary" />
            Reconnected to running crawl
          </Badge>
          <span className="text-xs text-muted-foreground">
            Progress resumed from the server — this crawl was started before
            this page loaded.
          </span>
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {job.total === 0
            ? "Discovering product URLs…"
            : "Crawling product URLs…"}
          <Badge
            variant={shallowRun ? "secondary" : "outline"}
            className="gap-1 font-normal"
          >
            {shallowRun ? (
              <Zap className="size-3" />
            ) : (
              <Radar className="size-3" />
            )}
            {shallowRun ? "shallow check" : "deep crawl"}
          </Badge>
          {/* Claiming worker — mirrors the Active crawls page badge; amber
              when the worker's heartbeat went stale (may have crashed). */}
          <Badge
            variant={job.heartbeatStale ? "secondary" : "outline"}
            className={
              job.heartbeatStale
                ? "gap-1 border-amber-500/40 font-mono text-[11px] font-normal text-amber-600"
                : "gap-1 border-accent/40 font-mono text-[11px] font-normal"
            }
            title={
              job.heartbeatStale
                ? "No heartbeat — this worker may have crashed"
                : undefined
            }
          >
            {job.heartbeatStale ? (
              <TriangleAlert className="size-3" />
            ) : (
              <Cpu className="size-3 text-accent" />
            )}
            {job.workerId ?? "not claimed yet"}
          </Badge>
        </span>
        <span className="numeric">
          {job.total > 0
            ? `${job.processed.toLocaleString()} / ${job.total.toLocaleString()}`
            : "—"}
        </span>
      </div>
      <Progress
        value={
          job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0
        }
        aria-label="Crawl progress"
      />
      <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <span>
          {fetchStarted
            ? `Discovery ${formatDuration(discoveryMs)} · Fetch ${formatDuration(fetchElapsedMs)}`
            : `Discovering ${formatDuration(discoveryMs)}`}
        </span>
        <span>
          {paused
            ? "Paused — waiting for you to resume"
            : remainingMs != null
              ? `~${formatDuration(remainingMs)} remaining`
              : "Estimating time…"}
        </span>
      </div>

      {/* Analyze-first snapshot — the strategy this crawl was started with
          (captured at enqueue). Shows the recommendation tier, what was
          auto-applied, and any WAF warning the probes surfaced. */}
      {job.analysis ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="label-caps text-muted-foreground">Analyzed</span>
            <TierBadge tier={job.analysis.tier} />
            <span className="text-muted-foreground">
              {job.analysis.platform} · {job.analysis.rendering}
            </span>
            {job.analysis.sitemap != null ? (
              <span className="text-muted-foreground">
                {job.analysis.sitemap.toLocaleString()} product URLs in sitemap
              </span>
            ) : null}
            <span className="text-muted-foreground/70">
              {job.analysis.requests} probe requests ·{" "}
              {formatDuration(job.analysis.durationMs)}
            </span>
          </div>
          {job.analysis.applied.length > 0 ? (
            <ul className="mt-2 space-y-1 border-t border-border pt-2">
              {job.analysis.applied.map((note) => (
                <li
                  key={note}
                  className="flex items-start gap-1.5 text-muted-foreground"
                >
                  <BadgeCheck className="mt-px size-3.5 shrink-0 text-success" />
                  <span className="leading-snug">{note}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {job.analysis.warning ? (
            <p className="mt-2 flex items-start gap-1.5 border-t border-border pt-2 text-amber-600">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span className="leading-snug">{job.analysis.warning}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Cooperative control — pause/resume/cancel the running crawl. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-caps text-muted-foreground">Control</span>
        {paused ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={controlPending}
            onClick={onResume}
          >
            {controlPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Resume
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={controlPending}
            onClick={onPause}
          >
            {controlPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Pause className="size-3.5" />
            )}
            Pause
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          className="h-7"
          disabled={controlPending}
          onClick={onCancel}
        >
          {controlPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Square className="size-3.5" />
          )}
          Cancel
        </Button>
      </div>

      {/* Live discovery diagnostics — real sitemap/page counts while
          discovery runs (job.total stays 0 until the fetch phase), plus a
          verbose step-by-step log of what the engine is doing. */}
      {liveDiscovery ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {discoveryPhaseLabel(liveDiscovery.phase)}
            </span>
            <span className="numeric">
              {liveDiscovery.urlsFound.toLocaleString()} product URLs
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            {liveDiscovery.sitemapUrls > 0 ? (
              <span>Sitemap: {liveDiscovery.sitemapUrls.toLocaleString()}</span>
            ) : null}
            {liveDiscovery.htmlPagesVisited > 0 ? (
              <span>
                Pages visited: {liveDiscovery.htmlPagesVisited.toLocaleString()}
              </span>
            ) : null}
            {liveDiscovery.htmlUrls > 0 ? (
              <span>HTML URLs: {liveDiscovery.htmlUrls.toLocaleString()}</span>
            ) : null}
            {liveDiscovery.collectionHandles > 0 ? (
              <span>
                Collections: {liveDiscovery.collectionHandles.toLocaleString()}
              </span>
            ) : null}
          </div>

          {/* Verbose live log — the current step bolded, then the trail. */}
          {liveDiscovery.log.length > 0 ? (
            <div className="mt-2.5 max-h-36 space-y-1 overflow-auto border-t border-border pt-2.5">
              {liveDiscovery.log.slice(-8).map((line, i) => {
                const isLast = i === Math.min(liveDiscovery.log.length, 8) - 1;
                return (
                  <p
                    key={`${line}-${i}`}
                    className={cn(
                      "flex gap-2",
                      isLast
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-1 shrink-0 rounded-full",
                        isLast ? "animate-pulse bg-accent" : "bg-border",
                      )}
                    />
                    <span className="leading-snug">{line}</span>
                  </p>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Structured run log — the crawl's story (engine lifecycle + HTTP
          warnings + worker lines), live. Open by default here: this panel is
          where a run is watched, and the log is why. */}
      <RunLog lines={job.log} defaultOpen />

      {/* The parameters this job actually runs with (captured at start) — so
          it's clear when the panel config changed. */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="label-caps text-muted-foreground">Running with</span>
        <Badge variant="secondary" className="font-normal">
          {(job.params.delayMs / 1000).toLocaleString()}s delay
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {job.params.maxConcurrencyPerHost} concurrent
        </Badge>
        {job.params.maxPages != null ? (
          <Badge variant="secondary" className="font-normal">
            max {job.params.maxPages.toLocaleString()} pages
          </Badge>
        ) : null}
        <Badge variant="secondary" className="font-normal">
          {job.params.respectRobotsTxt ? "robots respected" : "robots ignored"}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {job.params.productOnly ? "product-only" : "all pages"}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {job.params.storeSnapshots ? "snapshots on" : "no snapshots"}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {job.params.useBrowser ? "auto JS rendering" : "http only"}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {job.params.proxy ? "residential proxy" : "direct"}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {job.params.userAgent != null ? "browser UA" : "ParityBot UA"}
        </Badge>
        {job.params.productUrlPattern ? (
          <Badge
            variant="secondary"
            className="max-w-56 truncate font-mono font-normal"
            title={`Product URL pattern: ${job.params.productUrlPattern}`}
          >
            pattern: {job.params.productUrlPattern}
          </Badge>
        ) : null}
        {job.params.locale ? (
          <Badge
            variant="secondary"
            className="font-mono font-normal uppercase"
            title={`Region filter: only ${job.params.locale} sitemaps crawled`}
          >
            region: {job.params.locale}
          </Badge>
        ) : null}
      </div>

      {!paramsMatch ? (
        <Alert className="border-warning/50 [&>svg]:text-warning">
          <TriangleAlert className="size-4" />
          <AlertTitle>Config changed mid-run</AlertTitle>
          <AlertDescription>
            This crawl is using the parameters it started with. Your panel
            settings changed after it began — they apply to the next crawl.
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {job.total === 0
          ? `Reading sitemaps and following internal links — ${job.params.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}.`
          : `Polite crawl (max ${job.params.maxConcurrencyPerHost} concurrent requests, ${(job.params.delayMs / 1000).toLocaleString()}s base delay, ${job.params.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}) — the estimate adjusts to the observed speed and any rate limits.${job.params.maxPages != null ? ` Crawl capped at ${job.params.maxPages.toLocaleString()} pages.` : ""}`}
      </p>
    </section>
  );
}
