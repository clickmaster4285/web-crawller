import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  CalendarClock,
  CircleCheck,
  Eye,
  Globe,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { PageHeader } from "@/components/layout/app-shell";
import { StoreProfile } from "@/components/crawls/store-profile";
import { DiscoveryLog } from "@/components/crawls/discovery-log";
import { SectionTitle } from "@/components/cards/stat-card";
import { CrawlDiffSummary } from "@/components/cards/crawl-diff-summary";
import { CrawlStatsGrid } from "@/components/cards/crawl-stats-grid";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorState, LoadingState } from "@/components/common/states";
import { useSavedCrawls } from "@/hooks/useData";
import { useLocalStorageState } from "@/hooks/useLocalStorage";
import { useWorkspace } from "@/hooks/useWorkspace";
import type { SavedCrawl } from "@/lib/api";
import {
  cancelCrawlSchedule,
  getCrawlProgress,
  getCrawlSchedules,
  scheduleCrawl,
  startCrawl,
  type CrawlFrequency,
  type CrawlJob,
  type CrawlJobDiscovery,
  type CrawlRunInput,
  type CrawlRunResult,
  type CrawlSchedule,
  type ScheduleCrawlInput,
} from "@/lib/crawl";
import {
  computeCrawlDiff,
  formatCrawlDate,
  normalizeOrigin,
} from "@/utils/crawls";
import { formatDuration, formatPrice } from "@/utils/format";

/** Route search params — `?job=` reconnects to a specific crawl job. */
type SourcesSearch = {
  job?: string;
};

export const Route = createFileRoute("/_authenticated/sources/")({
  // ?job= reconnects to a crawl — a refresh in another tab (or a shared
  // link) re-attaches to the same running/finished job.
  validateSearch: (search: Record<string, unknown>): SourcesSearch => ({
    job: typeof search.job === "string" ? search.job : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Crawler — Parity" },
      {
        name: "description",
        content:
          "Crawl any store: enter the domain, tune the configuration, and the engine discovers products via sitemaps, HTML crawling and structured data — politely, respecting robots.txt. Results are saved for history.",
      },
      { property: "og:title", content: "Crawler — Parity" },
    ],
  }),
  component: SourcesPage,
});

function SourcesPage() {
  const { data: workspace, isLoading, isError } = useWorkspace();
  const saved = useSavedCrawls();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  // Live crawl controls — persisted to localStorage so an accidental refresh
  // (or restart) restores the panel exactly as it was, and re-attaches to a
  // crawl that is still running server-side via the saved job id.
  const [crawlOrigin, setCrawlOrigin] = useLocalStorageState(
    "parity.sources.origin",
    "https://obdesignsusa.com",
  );
  const [collections, setCollections] = useLocalStorageState(
    "parity.sources.collections",
    "",
  );
  const [jobId, setJobId] = useLocalStorageState<string | null>(
    "parity.sources.jobId",
    null,
  );

  // Keep the URL's ?job= param in sync with the live jobId so a refresh in
  // another tab (or a shared link) reconnects to the same crawl. On a fresh
  // load the URL param wins over the localStorage copy; afterwards jobId is
  // the source of truth and the URL mirrors it via replace (no back-button
  // history spam). The param clears automatically when jobId clears (dead
  // job, edited inputs, or a new crawl).
  const urlJobAdopted = useRef(false);
  useEffect(() => {
    const urlJob = typeof search.job === "string" ? search.job : null;
    if (!urlJobAdopted.current) {
      urlJobAdopted.current = true;
      if (urlJob && urlJob !== jobId) {
        setJobId(urlJob);
        return;
      }
    }
    const target = jobId ?? null;
    if (urlJob !== target) {
      navigate({
        search: (prev) => ({ ...prev, job: jobId ?? undefined }),
        replace: true,
      });
    }
  }, [search.job, jobId, navigate, setJobId]);

  // Crawl parameters — wired into the crawler via startCrawl.
  const [crawlDelay, setCrawlDelay] = useLocalStorageState(
    "parity.sources.delayMs",
    1000,
  );
  const [maxConcurrency, setMaxConcurrency] = useLocalStorageState(
    "parity.sources.concurrency",
    2,
  );
  // Max pages: preset modes plus a free "Custom…" input (e.g. 5 or 10 for
  // quick test crawls). The effective cap is derived below.
  const [maxPagesMode, setMaxPagesMode] = useLocalStorageState<MaxPagesMode>(
    "parity.sources.maxPagesMode",
    "5000",
  );
  const [customMaxPages, setCustomMaxPages] = useLocalStorageState(
    "parity.sources.customMaxPages",
    "",
  );
  const maxPages: number | null =
    maxPagesMode === "unlimited"
      ? null
      : maxPagesMode === "custom"
        ? parseCustomMaxPages(customMaxPages)
        : Number(maxPagesMode);
  const [respectRobots, setRespectRobots] = useLocalStorageState(
    "parity.sources.respectRobots",
    true,
  );
  const [productOnly, setProductOnly] = useLocalStorageState(
    "parity.sources.productOnly",
    true,
  );
  const [storeSnapshots, setStoreSnapshots] = useLocalStorageState(
    "parity.sources.snapshots",
    true,
  );
  // Tier 1 — Playwright browser rendering (opt-in): JS-shell pages are
  // rendered in a headless browser so JS-rendered stores crawl properly.
  const [useBrowser, setUseBrowser] = useLocalStorageState(
    "parity.sources.useBrowser",
    false,
  );
  // Tier 2 — rotating residential proxy gateway URL (opt-in). Credentials
  // stay in the user's own localStorage; only the boolean is ever sent to
  // the server's job params.
  const [proxy, setProxy] = useLocalStorageState("parity.sources.proxy", "");
  const [frequency, setFrequency] = useLocalStorageState<CrawlFrequency>(
    "parity.sources.frequency",
    "6h",
  );

  // The job id this page session started itself (vs one restored from
  // localStorage / ?job= after a reload) — lets us show a "reconnected"
  // badge only when we didn't just kick the crawl off from this page.
  const startedInThisSession = useRef<string | null>(null);

  const start = useMutation({
    mutationFn: (input: CrawlRunInput) => startCrawl({ data: input }),
    onSuccess: ({ jobId: id }) => {
      startedInThisSession.current = id;
      setJobId(id);
    },
  });

  // Recurring crawls — registered on the server, ticked by its 30s interval.
  const schedulesQuery = useQuery({
    queryKey: ["crawl-schedules"],
    queryFn: () => getCrawlSchedules(),
    refetchInterval: 60_000,
  });

  // Persisted copy of the active schedules — the live server response is
  // always the source of truth; this cache only smooths the loading window
  // and covers a brief server outage, so a refresh never flashes empty.
  const [cachedSchedules, setCachedSchedules] = useLocalStorageState<
    CrawlSchedule[]
  >("parity.sources.schedules", []);
  useEffect(() => {
    if (schedulesQuery.data) {
      setCachedSchedules(schedulesQuery.data);
    }
  }, [schedulesQuery.data, setCachedSchedules]);
  const schedules = schedulesQuery.data ?? cachedSchedules;
  const schedule = useMutation({
    mutationFn: (input: ScheduleCrawlInput) => scheduleCrawl({ data: input }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["crawl-schedules"] }),
  });
  const cancelSchedule = useMutation({
    mutationFn: (origin: string) => cancelCrawlSchedule({ data: origin }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["crawl-schedules"] }),
  });

  // TanStack Start server functions are one-shot RPC (no SSE), so live
  // progress is polled: `startCrawl` returns a job id immediately and the
  // crawl runs in the background; this query polls the job while it runs.
  const progress = useQuery({
    queryKey: ["crawl-progress", jobId],
    queryFn: () => {
      if (!jobId) throw new Error("No crawl job");
      return getCrawlProgress({ data: jobId });
    },
    enabled: !!jobId,
    refetchInterval: (query) => {
      const job = query.state.data;
      // Stop once the job is gone (server restarted mid-crawl) or finished.
      if (job === null || (job && job.status !== "running")) return false;
      return 800;
    },
  });

  const job: CrawlJob | undefined = progress.data ?? undefined;
  const isRunning = job?.status === "running";
  // Live discovery snapshot — non-null while the discovery phase runs
  // (job.total stays 0 until the fetch phase begins).
  const liveDiscovery =
    job && job.total === 0 && job.discovery ? job.discovery : null;
  // True when we restored (from localStorage or ?job=) a crawl that is still
  // running — the page reconnected to it instead of starting it fresh here.
  const reconnected =
    isRunning && jobId != null && jobId !== startedInThisSession.current;
  const result: CrawlRunResult | undefined =
    job?.status === "done" ? job.result : undefined;

  // When a crawl finishes and persists, refresh the Saved crawls list so the
  // new result shows up without a manual reload.
  useEffect(() => {
    if (job?.persisted) {
      void queryClient.invalidateQueries({ queryKey: ["saved-crawls"] });
    }
  }, [job?.persisted, queryClient]);

  // If a persisted job id no longer exists on the server (restart, or the
  // 10-minute job prune), drop it so a refresh doesn't keep polling a dead id.
  useEffect(() => {
    if (jobId != null && progress.isFetched && progress.data === null) {
      setJobId(null);
    }
  }, [jobId, progress.isFetched, progress.data, setJobId]);

  // Live clock — re-renders every second while a crawl runs so the elapsed
  // timer and ETA tick smoothly (the progress poll is 800ms).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const startedAt = job?.startedAt ?? 0;
  const fetchStartedAt = job?.fetchStartedAt ?? null;
  const elapsedMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
  // Discovery runs before any product is fetched, so the ETA is computed
  // from the *fetch-phase* rate only — discovery time never inflates the
  // per-page estimate. The two phases are shown separately in the panel.
  const discoveryMs =
    fetchStartedAt != null && startedAt > 0
      ? Math.max(0, fetchStartedAt - startedAt)
      : elapsedMs;
  const fetchElapsedMs =
    fetchStartedAt != null ? Math.max(0, now - fetchStartedAt) : 0;
  // Adaptive ETA from the observed fetch rate (products per ms), so it
  // responds to crawl parameters as they change: rate limits slow it down,
  // warmup speeds it up, and a growing discovery count extends it. A 5s
  // warm-up floor on fetch time avoids a briefly absurd optimistic estimate
  // from the very first tick's tiny denominator.
  const ratePerMs =
    job && job.total > 0 && fetchElapsedMs >= 5000
      ? job.processed / fetchElapsedMs
      : 0;
  const remainingMs =
    job && ratePerMs > 0
      ? Math.max(0, (job.total - job.processed) / ratePerMs)
      : null;

  // Whether the panel's current config still matches what the running job
  // was started with — false means the job is using stale parameters.
  const paramsMatch =
    !job ||
    (job.params.delayMs === crawlDelay &&
      job.params.maxConcurrencyPerHost === maxConcurrency &&
      job.params.maxPages === maxPages &&
      job.params.respectRobotsTxt === respectRobots &&
      job.params.productOnly === productOnly &&
      job.params.storeSnapshots === storeSnapshots &&
      job.params.useBrowser === useBrowser &&
      job.params.proxy === proxy.trim().length > 0);

  // The previous saved snapshot for the origin being crawled — everything
  // saved *after* this run started (including this run's own persistence)
  // is excluded, so the "what's new" diff is always against the last crawl
  // that existed before this one.
  const prevCrawl = useMemo(() => {
    if (!startedAt) return undefined;
    const key = normalizeOrigin(crawlOrigin.trim());
    return (saved.data?.data ?? []).find(
      (c) =>
        normalizeOrigin(c.origin) === key &&
        new Date(c.updatedAt).getTime() < startedAt,
    );
  }, [saved.data, crawlOrigin, startedAt]);

  const diff = useMemo(
    () =>
      result ? computeCrawlDiff(result.products, prevCrawl?.products) : null,
    [result, prevCrawl],
  );

  // Unique stores from saved crawls (newest first) — one-click re-runs.
  const recentDomains = useMemo(() => {
    const seen = new Set<string>();
    const out: SavedCrawl[] = [];
    for (const c of saved.data?.data ?? []) {
      const key = normalizeOrigin(c.origin);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
        if (out.length >= 6) break;
      }
    }
    return out;
  }, [saved.data]);

  const pickRecent = (c: SavedCrawl) => {
    setCrawlOrigin(c.origin);
    setCollections(c.collections.join(", "));
    setJobId(null);
  };

  // Newest saved snapshot for the domain currently entered — feeds the
  // compact Store profile card (platform / sitemap / robots.txt detection).
  const profileKey = normalizeOrigin(crawlOrigin.trim());
  const profileCrawl = useMemo(
    () =>
      (saved.data?.data ?? []).find(
        (c) => normalizeOrigin(c.origin) === profileKey,
      ),
    [saved.data, profileKey],
  );

  const collectionsList = collections
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  if (isError) return <ErrorState />;
  if (isLoading || !workspace) return <LoadingState label="Loading crawler…" />;

  const runCrawl = () =>
    start.mutate({
      origin: crawlOrigin.trim(),
      collections: collectionsList,
      delayMs: crawlDelay,
      maxConcurrencyPerHost: maxConcurrency,
      maxPages: maxPages ?? undefined,
      respectRobotsTxt: respectRobots,
      productOnly,
      storeSnapshots,
      useBrowser,
      proxy: proxy.trim() || undefined,
    });

  const scheduleIt = () =>
    schedule.mutate({
      origin: crawlOrigin.trim(),
      collections: collectionsList,
      frequency,
      delayMs: crawlDelay,
      maxConcurrencyPerHost: maxConcurrency,
      maxPages: maxPages ?? undefined,
      respectRobotsTxt: respectRobots,
      productOnly,
      storeSnapshots,
      useBrowser,
      proxy: proxy.trim() || undefined,
    });

  return (
    <div>
      <PageHeader
        // eyebrow="Crawl"
        title="Crawler"
        // description="Enter a store domain and the engine discovers its catalogue — sitemap + HTML crawl, then per-product extraction with robots.txt and rate-limit respect. Every result is saved, so re-crawling only picks up what's new."
        actions={
          <Button asChild variant="outline">
            <Link to="/crawls">
              <Archive className="size-4" /> Saved crawls
            </Link>
          </Button>
        }
      />

      <div className="space-y-8 px-6 py-8">
        {/* ── 1. The domain — primary action, top of the page ─────────── */}
        <section className="border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-6 py-4">
            <Globe className="size-4 text-muted-foreground" />
            <h2 className="font-display text-xl">Start a crawl</h2>
          </div>
          <div className="space-y-4 p-6">
            <div className="grid gap-2">
              <Label htmlFor="crawl-origin">Store domain</Label>
              <Input
                id="crawl-origin"
                value={crawlOrigin}
                onChange={(e) => {
                  setCrawlOrigin(e.target.value);
                  setJobId(null);
                }}
                placeholder="https://store.example.com"
                className="font-mono"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="crawl-collections">
                Collections{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="crawl-collections"
                value={collections}
                onChange={(e) => {
                  setCollections(e.target.value);
                  setJobId(null);
                }}
                placeholder="silicone-toys, bundles — leave empty for the full catalogue"
              />
            </div>

            {recentDomains.length > 0 ? (
              <div className="border-t border-border pt-4">
                <p className="label-caps mb-2">Recently crawled</p>
                <div className="flex flex-wrap gap-2">
                  {recentDomains.map((c) => (
                    <button
                      key={c._id}
                      type="button"
                      onClick={() => pickRecent(c)}
                      className="group flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted"
                    >
                      <Globe className="size-3 text-muted-foreground group-hover:text-primary" />
                      <span className="font-mono">
                        {normalizeOrigin(c.origin)}
                      </span>
                      <span className="text-muted-foreground">
                        · {c.products.length} products
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button
                size="lg"
                onClick={runCrawl}
                disabled={start.isPending || isRunning || !crawlOrigin.trim()}
              >
                {start.isPending || isRunning ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {start.isPending
                  ? "Starting…"
                  : isRunning
                    ? "Crawling…"
                    : "Run crawl"}
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={frequency}
                  onValueChange={(v) => setFrequency(v as CrawlFrequency)}
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1h">Every hour</SelectItem>
                    <SelectItem value="6h">Every 6 hours</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  onClick={scheduleIt}
                  disabled={schedule.isPending || !crawlOrigin.trim()}
                >
                  <CalendarClock className="size-4" />
                  Schedule recurring
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Recurring crawls run automatically on the server (schedules are
              in-memory and reset on restart). Re-scheduling an origin replaces
              its existing schedule.
            </p>
          </div>
        </section>

        {/* ── 1.5 Store profile — detection from the latest crawl ─────── */}
        <StoreProfile
          crawl={profileCrawl}
          domain={profileKey}
          onSuggestionClick={(url) => {
            // "Crawl {linked store}" — prefill the crawler with the store
            // this site links out to (e.g. a corporate site → its shop).
            setCrawlOrigin(url);
            setCollections("");
            setJobId(null);
          }}
          headerAction={
            profileCrawl && profileCrawl.products.length > 0 ? (
              <Button asChild variant="outline" size="sm" className="h-7">
                <Link to="/stores/$origin" params={{ origin: profileKey }}>
                  <Eye className="size-3.5" /> View catalogue
                </Link>
              </Button>
            ) : undefined
          }
        />

        {/* ── 2. Live progress while a crawl runs ─────────────────────── */}
        {isRunning && job ? (
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
                  Progress resumed from the server — this crawl was started
                  before this page loaded.
                </span>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="text-muted-foreground">
                {job.total === 0
                  ? "Discovering product URLs…"
                  : "Crawling product URLs…"}
              </span>
              <span className="numeric">
                {job.total > 0
                  ? `${job.processed.toLocaleString()} / ${job.total.toLocaleString()}`
                  : "—"}
              </span>
            </div>
            <Progress
              value={
                job.total > 0
                  ? Math.round((job.processed / job.total) * 100)
                  : 0
              }
              aria-label="Crawl progress"
            />
            <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
              <span>
                {fetchStartedAt != null
                  ? `Discovery ${formatDuration(discoveryMs)} · Fetch ${formatDuration(fetchElapsedMs)}`
                  : `Discovering ${formatDuration(discoveryMs)}`}
              </span>
              <span>
                {remainingMs != null
                  ? `~${formatDuration(remainingMs)} remaining`
                  : "Estimating time…"}
              </span>
            </div>

            {/* Live discovery diagnostics — real sitemap/page counts while
                discovery runs (job.total stays 0 until the fetch phase), plus
                a verbose step-by-step log of what the engine is doing. */}
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
                    <span>
                      Sitemap: {liveDiscovery.sitemapUrls.toLocaleString()}
                    </span>
                  ) : null}
                  {liveDiscovery.htmlPagesVisited > 0 ? (
                    <span>
                      Pages visited:{" "}
                      {liveDiscovery.htmlPagesVisited.toLocaleString()}
                    </span>
                  ) : null}
                  {liveDiscovery.htmlUrls > 0 ? (
                    <span>
                      HTML URLs: {liveDiscovery.htmlUrls.toLocaleString()}
                    </span>
                  ) : null}
                  {liveDiscovery.collectionHandles > 0 ? (
                    <span>
                      Collections:{" "}
                      {liveDiscovery.collectionHandles.toLocaleString()}
                    </span>
                  ) : null}
                </div>

                {/* Verbose live log — the current step bolded, then the trail. */}
                {liveDiscovery.log.length > 0 ? (
                  <div className="mt-2.5 max-h-36 space-y-1 overflow-auto border-t border-border pt-2.5">
                    {liveDiscovery.log.slice(-8).map((line, i) => {
                      const isLast =
                        i === Math.min(liveDiscovery.log.length, 8) - 1;
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

            {/* The parameters this job actually runs with (captured at
                start) — so it's clear when the panel config changed. */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="label-caps text-muted-foreground">
                Running with
              </span>
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
                {job.params.respectRobotsTxt
                  ? "robots respected"
                  : "robots ignored"}
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {job.params.productOnly ? "product-only" : "all pages"}
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {job.params.storeSnapshots ? "snapshots on" : "no snapshots"}
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {job.params.useBrowser ? "browser rendering" : "http only"}
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {job.params.proxy ? "residential proxy" : "direct"}
              </Badge>
            </div>

            {!paramsMatch ? (
              <Alert className="border-warning/50 [&>svg]:text-warning">
                <TriangleAlert className="size-4" />
                <AlertTitle>Config changed mid-run</AlertTitle>
                <AlertDescription>
                  This crawl is using the parameters it started with. Your panel
                  settings changed after it began — they apply to the next
                  crawl.
                </AlertDescription>
              </Alert>
            ) : null}

            <p className="text-xs text-muted-foreground">
              {job.total === 0
                ? `Reading sitemaps and following internal links — ${job.params.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}.`
                : `Polite crawl (max ${job.params.maxConcurrencyPerHost} concurrent requests, ${(job.params.delayMs / 1000).toLocaleString()}s base delay, ${job.params.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}) — the estimate adjusts to the observed speed and any rate limits.${job.params.maxPages != null ? ` Crawl capped at ${job.params.maxPages.toLocaleString()} pages.` : ""}`}
            </p>
          </section>
        ) : null}

        {/* ── Errors ──────────────────────────────────────────────────── */}
        {start.isError ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>Request failed</AlertTitle>
            <AlertDescription className="break-all font-mono text-xs">
              {start.error instanceof Error
                ? start.error.message
                : String(start.error)}
            </AlertDescription>
          </Alert>
        ) : null}
        {job?.status === "error" ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>Crawl failed</AlertTitle>
            <AlertDescription className="break-all font-mono text-xs">
              {job.error}
            </AlertDescription>
          </Alert>
        ) : null}
        {progress.isError ? (
          <p className="text-xs text-muted-foreground">
            Progress updates stopped — check your connection. The crawl may
            still be running server-side.
          </p>
        ) : null}
        {jobId != null &&
        progress.isFetched &&
        progress.data === null &&
        !start.isPending ? (
          <p className="text-xs text-muted-foreground">
            No progress available — the server may have restarted mid-crawl.
            Start a new crawl.
          </p>
        ) : null}

        {/* ── 3. Results once a crawl finishes ────────────────────────── */}
        {result ? (
          <section className="space-y-5 border border-border bg-card p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-display text-xl">Crawl complete</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {normalizeOrigin(crawlOrigin)} · finished{" "}
                  {job?.finishedAt
                    ? formatCrawlDate(new Date(job.finishedAt).toISOString())
                    : "just now"}
                </p>
              </div>
              {job?.persisted ? (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <CircleCheck className="size-3 text-success" /> Saved to
                  database
                </Badge>
              ) : null}
            </div>

            {diff ? (
              <div>
                <p className="label-caps mb-2">
                  What's new since the last crawl
                </p>
                <CrawlDiffSummary
                  newCount={diff.newProducts.length}
                  removedCount={diff.removedProducts.length}
                  priceChangedCount={diff.priceChangedCount}
                  products={diff.newProducts}
                  productsFooter={`…and ${diff.newProducts.length - 6} more — see the full list under Saved crawls.`}
                />
              </div>
            ) : null}

            <CrawlStatsGrid stats={result.stats} />

            {/* Detection summary captured from this run. */}
            {result.discovery ? (
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary" className="font-normal">
                  {result.discovery.platform?.platform ?? "Unknown platform"}
                  {result.discovery.platform?.kind === "store"
                    ? " · store"
                    : result.discovery.platform?.kind === "corporate"
                      ? " · corporate site"
                      : ""}
                </Badge>
                {result.discovery.sitemap?.error ? (
                  <Badge variant="secondary" className="font-normal">
                    No sitemap
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="font-normal">
                    {(result.discovery.sitemap?.urls ?? 0).toLocaleString()}{" "}
                    sitemap URLs
                  </Badge>
                )}
                {result.discovery.robots?.status === "found" ? (
                  <Badge variant="secondary" className="font-normal">
                    robots.txt respected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="font-normal">
                    robots: {result.discovery.robots?.status ?? "skipped"}
                  </Badge>
                )}
                {result.stats.fetched > 0 ? (
                  <Badge variant="secondary" className="font-normal">
                    {Math.round(
                      (result.products.length / result.stats.fetched) * 100,
                    )}
                    % parsed
                  </Badge>
                ) : null}
              </div>
            ) : null}

            {/* Verbose findings + full discovery log from this run. */}
            {result.discovery?.findings?.length ? (
              <div>
                <p className="label-caps mb-2">What the crawler found</p>
                <ul className="space-y-1.5">
                  {result.discovery.findings.map((f, i) => (
                    <li
                      key={`${f.message}-${i}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                    >
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 font-medium",
                          f.level === "success" && "bg-success/10 text-success",
                          f.level === "warning" && "bg-warning/10 text-warning",
                          f.level === "info" && "bg-accent/10 text-accent",
                        )}
                      >
                        {f.level === "success"
                          ? "Found"
                          : f.level === "warning"
                            ? "Heads up"
                            : "Suggestion"}
                      </span>
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {f.message}
                      </span>
                      {f.action ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 text-xs"
                          onClick={() => {
                            setCrawlOrigin(f.action!.url);
                            setCollections("");
                            setJobId(null);
                          }}
                        >
                          <Link2 className="size-3" />
                          {f.action.label}
                          <ArrowUpRight className="size-3" />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <DiscoveryLog lines={result.discovery?.log ?? []} />

            {result.failures.length > 0 ? (
              <div>
                <p className="label-caps mb-2">Failures</p>
                <ul className="max-h-40 space-y-1 overflow-auto text-xs">
                  {result.failures.slice(0, 12).map((f) => (
                    <li key={f.url} className="flex justify-between gap-3">
                      <span className="truncate font-mono text-muted-foreground">
                        {f.url}
                      </span>
                      <span className="shrink-0 text-destructive">
                        {f.error}
                      </span>
                    </li>
                  ))}
                  {result.failures.length > 12 ? (
                    <li className="text-muted-foreground">
                      …and {result.failures.length - 12} more
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {result.products.length > 0 ? (
              <div>
                <p className="label-caps mb-2">
                  Products ({result.products.length}) — first{" "}
                  {Math.min(result.products.length, 8)}
                </p>
                <ul className="divide-y divide-border border border-border">
                  {result.products.slice(0, 8).map((p) => (
                    <li
                      key={p.url}
                      className="flex items-center justify-between gap-3 p-3 text-sm"
                    >
                      <ProductCell name={p.name} brand={p.brand} url={p.url} />
                      <span className="flex shrink-0 items-center gap-3">
                        <StockBadge available={p.available} />
                        <span className="text-right">
                          <span className="numeric block">
                            {formatPrice(p.price)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            store price
                          </span>
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No products were parsed — the store may have rate-limited this
                machine (HTTP 429) or no structured data was found. Check the
                failures above.
              </p>
            )}
          </section>
        ) : null}

        {/* ── 4. Configuration — bottom of the page ───────────────────── */}
        <section>
          <SectionTitle
            aside={
              <Badge variant="secondary" className="font-normal">
                Applies to the next crawl
              </Badge>
            }
          >
            Configuration
          </SectionTitle>
          <div className="grid gap-6 border border-border bg-card p-6 lg:grid-cols-2">
            <div className="grid gap-2">
              <Label>Maximum pages per crawl</Label>
              <Select
                value={maxPagesMode}
                onValueChange={(v) => setMaxPagesMode(v as MaxPagesMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="500">500</SelectItem>
                  <SelectItem value="1000">1,000</SelectItem>
                  <SelectItem value="5000">5,000</SelectItem>
                  <SelectItem value="custom">Custom…</SelectItem>
                  <SelectItem value="unlimited">Unlimited</SelectItem>
                </SelectContent>
              </Select>
              {maxPagesMode === "custom" ? (
                <div className="grid gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={customMaxPages}
                    onChange={(e) => setCustomMaxPages(e.target.value)}
                    placeholder="e.g. 5 or 10 for a quick test"
                  />
                  <p className="text-xs text-muted-foreground">
                    Small caps like 5 or 10 are great for testing — the crawl
                    stops after this many product pages. Leave empty for
                    unlimited.
                  </p>
                </div>
              ) : null}
            </div>

            <div className="grid gap-2">
              <Label>
                Concurrency{" "}
                <span className="font-normal text-muted-foreground">
                  (requests per host)
                </span>
              </Label>
              <Select
                value={String(maxConcurrency)}
                onValueChange={(v) => setMaxConcurrency(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 request at a time</SelectItem>
                  <SelectItem value="2">2 (polite default)</SelectItem>
                  <SelectItem value="4">4</SelectItem>
                  <SelectItem value="6">6</SelectItem>
                  <SelectItem value="8">8 (aggressive)</SelectItem>
                </SelectContent>
              </Select>
              {maxConcurrency > 2 ? (
                <Alert className="border-warning/50 [&>svg]:text-warning">
                  <TriangleAlert className="size-4" />
                  <AlertTitle>Politeness warning</AlertTitle>{" "}
                  <AlertDescription>
                    Higher concurrency speeds up crawling but can trigger rate
                    limits (HTTP 429) or IP blocks on some stores.{" "}
                    {respectRobots
                      ? "robots.txt is still respected and the crawler slows down adaptively."
                      : "You've disabled robots.txt — be extra careful about rate limits."}
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>

            <div className="grid gap-2">
              <Label>
                Request delay{" "}
                <span className="font-normal text-muted-foreground">
                  (per request)
                </span>
              </Label>
              <Select
                value={String(crawlDelay)}
                onValueChange={(v) => setCrawlDelay(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="250">0.25s</SelectItem>
                  <SelectItem value="500">0.5s</SelectItem>
                  <SelectItem value="1000">1s</SelectItem>
                  <SelectItem value="2000">2s</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="product-only">Product-only mode</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Skip blog, help and policy pages
                </p>
              </div>
              <Switch
                id="product-only"
                checked={productOnly}
                onCheckedChange={setProductOnly}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="robots">Respect robots.txt</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Recommended for all sources
                </p>
              </div>
              <Switch
                id="robots"
                checked={respectRobots}
                onCheckedChange={setRespectRobots}
              />
            </div>
            {!respectRobots ? (
              <Alert className="border-warning/50 [&>svg]:text-warning lg:col-span-2">
                <TriangleAlert className="size-4" />
                <AlertTitle>robots.txt disabled</AlertTitle>
                <AlertDescription>
                  The crawler will ignore robots.txt disallow rules and
                  crawl-delay. This can violate site terms and get your IP
                  blocked — use only on sites you own.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="snapshot">Store full snapshots</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Keeps history for trend analysis
                </p>
              </div>
              <Switch
                id="snapshot"
                checked={storeSnapshots}
                onCheckedChange={setStoreSnapshots}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="browser">Browser rendering</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Playwright fallback for JS-rendered stores (Nuxt/SPA) —
                  slower, needs Chrome installed
                </p>
              </div>
              <Switch
                id="browser"
                checked={useBrowser}
                onCheckedChange={setUseBrowser}
              />
            </div>
            {useBrowser ? (
              <Alert className="border-accent/50 [&>svg]:text-accent lg:col-span-2">
                <Globe className="size-4" />
                <AlertTitle>Tier 1 — browser rendering on</AlertTitle>
                <AlertDescription>
                  Pages that look like a JS shell are rendered in headless
                  Chrome before discovery and extraction see them. This is for
                  stores whose products load client-side; leave it off for
                  regular stores to keep crawls fast.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="lg:col-span-2">
              <Label htmlFor="proxy">Residential proxy (optional)</Label>
              <Input
                id="proxy"
                type="password"
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="http://user:pass@gate.provider.com:8000"
                autoComplete="off"
                spellCheck={false}
                className="mt-1.5 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Tier 2 — routes every request through a rotating residential
                gateway (Oxylabs / Bright Data / Smartproxy) to fix IP blocks on
                stores that 403 this machine. Credentials stay in your browser;
                the server never stores or logs them.
              </p>
            </div>
          </div>
        </section>

        {/* ── 5. Active schedules ──────────────────────────────────────── */}
        {schedulesQuery.isError &&
        !schedulesQuery.data &&
        cachedSchedules.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Server unreachable — showing the last known schedules from memory.
            Recurring crawls live server-side and reset on restart.
          </p>
        ) : null}
        {schedules.length > 0 ? (
          <section>
            <SectionTitle>Active schedules</SectionTitle>
            <ul className="divide-y divide-border border border-border bg-card">
              {schedules.map((s) => (
                <li
                  key={s.origin}
                  className="flex items-center justify-between gap-3 p-3.5 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono">{s.origin}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Every {frequencyLabel(s.frequency)} · next run{" "}
                      {formatScheduleTime(s.nextRunAt)} ·{" "}
                      {s.running
                        ? "running"
                        : s.lastRunAt
                          ? `last ran ${formatScheduleTime(s.lastRunAt)}`
                          : "never ran"}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => cancelSchedule.mutate(s.origin)}
                    disabled={cancelSchedule.isPending}
                  >
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function frequencyLabel(frequency: CrawlFrequency): string {
  switch (frequency) {
    case "1h":
      return "hour";
    case "6h":
      return "6 hours";
    case "daily":
      return "day";
    case "weekly":
      return "week";
  }
}

function formatScheduleTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

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

/** Max-pages select modes: presets, a free "Custom…" input, or unlimited. */
type MaxPagesMode = "500" | "1000" | "5000" | "custom" | "unlimited";

/** Parses the Custom… input into a positive page cap (`null` when empty/invalid). */
function parseCustomMaxPages(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
