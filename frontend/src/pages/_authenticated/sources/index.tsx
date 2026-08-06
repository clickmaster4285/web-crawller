import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Eye, PlayCircle, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { StoreProfile } from "@/components/crawls/store-profile";
import { CancelCrawlDialog } from "@/components/crawls/cancel-crawl-dialog";
import { CrawlSetupPanel } from "@/components/sources/crawl-setup-panel";
import { CrawlProgressPanel } from "@/components/sources/crawl-progress-panel";
import { CrawlResultsPanel } from "@/components/sources/crawl-results-panel";
import { CrawlConfigPanel } from "@/components/sources/crawl-config-panel";
import { ActiveSchedulesPanel } from "@/components/sources/active-schedules-panel";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErrorState, LoadingState } from "@/components/common/states";
import { useSavedCrawls } from "@/hooks/useData";
import { useLocalStorageState } from "@/hooks/useLocalStorage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { invalidateCrawlData, type SavedCrawl } from "@/api";
import {
  cancelCrawlJob,
  cancelCrawlSchedule,
  getCrawlProgress,
  getCrawlSchedules,
  pauseCrawlJob,
  resumeCrawlJob,
  scheduleCrawl,
  startCrawl,
  type CrawlFrequency,
  type CrawlJob,
  type CrawlRunInput,
  type CrawlRunResult,
  type CrawlSchedule,
  type ScheduleCrawlInput,
} from "@/lib/crawl";
import {
  computeCrawlDiff,
  crawlType,
  normalizeOrigin,
  parseCustomMaxPages,
  type MaxPagesMode,
} from "@/utils/crawls";
import {
  notifyCrawlControl,
  notifyCrawlControlError,
  type CrawlControlVariables,
} from "@/utils/crawl-controls";

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
  // Max pages: preset modes plus a free "Custom…" free number input (e.g. 5
  // or 10 for quick test crawls). The effective cap is derived below.
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

  // The running crawl being considered for cancellation (the confirmation
  // dialog target) — null while no dialog is open.
  const [cancelTarget, setCancelTarget] = useState<CrawlJob | null>(null);

  // Cooperative control — pause/resume/cancel the running job from the
  // progress panel (the same endpoints the Active crawls page uses).
  const control = useMutation({
    mutationFn: ({ id, action }: CrawlControlVariables) =>
      action === "pause"
        ? pauseCrawlJob({ data: id })
        : action === "resume"
          ? resumeCrawlJob({ data: id })
          : cancelCrawlJob({ data: id }),
    onSuccess: (_data, variables) => {
      // Invalidate the specific job's progress so the next poll reflects the
      // new control state (pause/resume/cancel) without waiting 800ms.
      void queryClient.invalidateQueries({
        queryKey: ["crawl-progress", variables.id],
      });
      // Close the cancel confirmation once the cancel itself lands — a
      // pause/resume settling must not dismiss an open cancel dialog.
      if (variables.action === "cancel") setCancelTarget(null);
      // Confirmation toast — visible no matter which page started the action.
      notifyCrawlControl(variables.action, variables.label, variables.id);
    },
    onError: (error, variables) =>
      notifyCrawlControlError(variables.action, error),
  });

  // True only while the confirmed cancel for the dialog's job is in flight
  // (a pending pause/resume must not disable the dialog's buttons).
  const cancelling =
    control.isPending &&
    control.variables?.action === "cancel" &&
    control.variables?.id === cancelTarget?.id;

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
  // Shallow = sitemap-only check: the badge, and the "no new products"
  // zero-fetch state, only apply to those runs (deep runs keep the full
  // results layout).
  const shallowRun = job?.type === "shallow";

  // Dismiss the cancel confirmation if the crawl stops while it's open (it
  // finished, was cancelled elsewhere, or the poll lost it) — cancelling a
  // dead job would 404. Keyed on the *status* only: the 800ms poll hands back
  // a fresh job object every tick, and depending on the whole object would
  // re-run this effect on every poll for no reason.
  useEffect(() => {
    if (cancelTarget != null && job?.status !== "running") {
      setCancelTarget(null);
    }
  }, [cancelTarget, job?.status]);

  // When a crawl finishes and persists, every crawl-derived query is stale —
  // refresh the saved-crawls list (and mark the rest stale) so results show
  // up without a manual reload.
  useEffect(() => {
    if (job?.persisted) {
      invalidateCrawlData(queryClient);
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

  // Which job kind this session started — only the button actually clicked
  // shows the "Starting…" spinner (the start mutation is shared by both).
  const [starting, setStarting] = useState<"deep" | "shallow" | null>(null);

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
  // warmup speeds it up, and a growing discovery count extends it. A short
  // 2s warm-up floor on fetch time avoids a briefly absurd optimistic
  // estimate from the very first tick's tiny denominator — but the ETA now
  // appears almost immediately once fetching starts, instead of hiding for
  // 5+ seconds.
  const ratePerMs =
    job && job.total > 0 && fetchElapsedMs >= 2000
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

  /** Fills the crawler from a discovery suggestion/finding action link. */
  const actionUrl = (url: string) => {
    setCrawlOrigin(url);
    setCollections("");
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

  // Newest shallow (sitemap-only) snapshot for the domain — the "Last quick
  // check" strip on the Store profile card. Old snapshots without a `type`
  // are all deep crawls, so they're excluded.
  const lastShallowCrawl = useMemo(
    () =>
      (saved.data?.data ?? []).find(
        (c) =>
          crawlType(c) === "shallow" &&
          normalizeOrigin(c.origin) === profileKey,
      ),
    [saved.data, profileKey],
  );

  const collectionsList = collections
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  if (isError) return <ErrorState />;
  if (isLoading || !workspace) return <LoadingState label="Loading crawler…" />;

  const buildCrawlInput = (type: "deep" | "shallow") => ({
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
    type,
  });
  const runCrawl = () => {
    setStarting("deep");
    start.mutate(buildCrawlInput("deep"));
  };
  // Quick check — a shallow sitemap-only crawl: discovery is sitemap-only and
  // only NEW product pages are fetched (~1 request when nothing changed).
  // Partial results never soft-delete the catalogue (fullCrawl: false).
  const runQuickCheck = () => {
    setStarting("shallow");
    start.mutate(buildCrawlInput("shallow"));
  };
  const pendingDeep = start.isPending && starting === "deep";
  const pendingShallow = start.isPending && starting === "shallow";

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
        title="Crawler"
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/crawler">
                <PlayCircle className="size-4" /> Active crawls
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/crawls">
                <Archive className="size-4" /> Saved crawls
              </Link>
            </Button>
          </>
        }
      />

      <div className="space-y-8 px-6 py-8">
        {/* ── 1. The domain — primary action, top of the page ─────────── */}
        <CrawlSetupPanel
          crawlOrigin={crawlOrigin}
          onOriginChange={(value) => {
            setCrawlOrigin(value);
            setJobId(null);
          }}
          collections={collections}
          onCollectionsChange={(value) => {
            setCollections(value);
            setJobId(null);
          }}
          recentDomains={recentDomains}
          onPickRecent={pickRecent}
          frequency={frequency}
          onFrequencyChange={(value) => setFrequency(value)}
          onRunCrawl={runCrawl}
          onRunQuickCheck={runQuickCheck}
          onSchedule={scheduleIt}
          running={isRunning}
          pendingDeep={pendingDeep}
          pendingShallow={pendingShallow}
          startPending={start.isPending}
          schedulePending={schedule.isPending}
        />

        {/* ── 1.5 Store profile — detection from the latest crawl ─────── */}
        <StoreProfile
          crawl={profileCrawl}
          domain={profileKey}
          lastShallow={lastShallowCrawl}
          onSuggestionClick={actionUrl}
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
          <CrawlProgressPanel
            job={job}
            shallowRun={shallowRun}
            reconnected={reconnected}
            liveDiscovery={liveDiscovery}
            discoveryMs={discoveryMs}
            fetchElapsedMs={fetchElapsedMs}
            fetchStarted={fetchStartedAt != null}
            remainingMs={remainingMs}
            paramsMatch={paramsMatch}
            paused={job.control === "pause"}
            controlPending={control.isPending}
            onPause={() =>
              jobId &&
              control.mutate({
                id: jobId,
                action: "pause",
                label: job?.origin,
              })
            }
            onResume={() =>
              jobId &&
              control.mutate({
                id: jobId,
                action: "resume",
                label: job?.origin,
              })
            }
            onCancel={() => setCancelTarget(job)}
          />
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
        {job?.status === "cancelled" ? (
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertTitle>Crawl cancelled</AlertTitle>
            <AlertDescription className="text-xs">
              This crawl was stopped before it finished — no partial result was
              saved. Start a new crawl when you're ready.
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
          <CrawlResultsPanel
            result={result}
            job={job}
            shallowRun={shallowRun}
            diff={diff}
            crawlOrigin={crawlOrigin}
            onActionUrl={actionUrl}
          />
        ) : null}

        {/* ── 4. Configuration — bottom of the page ───────────────────── */}
        <CrawlConfigPanel
          maxPagesMode={maxPagesMode}
          onMaxPagesModeChange={(mode) => setMaxPagesMode(mode)}
          customMaxPages={customMaxPages}
          onCustomMaxPagesChange={(value) => setCustomMaxPages(value)}
          maxConcurrency={maxConcurrency}
          onMaxConcurrencyChange={(value) => setMaxConcurrency(value)}
          crawlDelay={crawlDelay}
          onCrawlDelayChange={(value) => setCrawlDelay(value)}
          productOnly={productOnly}
          onProductOnlyChange={(value) => setProductOnly(value)}
          respectRobots={respectRobots}
          onRespectRobotsChange={(value) => setRespectRobots(value)}
          storeSnapshots={storeSnapshots}
          onStoreSnapshotsChange={(value) => setStoreSnapshots(value)}
          useBrowser={useBrowser}
          onUseBrowserChange={(value) => setUseBrowser(value)}
          proxy={proxy}
          onProxyChange={(value) => setProxy(value)}
        />

        {/* ── 5. Active schedules ──────────────────────────────────────── */}
        <ActiveSchedulesPanel
          schedules={schedules}
          offline={
            schedulesQuery.isError &&
            !schedulesQuery.data &&
            cachedSchedules.length > 0
          }
          onCancel={(origin) => cancelSchedule.mutate(origin)}
          cancelPending={cancelSchedule.isPending}
        />
      </div>

      {/* Cancel confirmation — a stop is irreversible (nothing persisted). */}
      <CancelCrawlDialog
        job={cancelTarget}
        cancelling={cancelling}
        onConfirm={() => {
          if (cancelTarget) {
            control.mutate({
              id: cancelTarget.id,
              action: "cancel",
              label: cancelTarget.origin,
            });
          }
        }}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
