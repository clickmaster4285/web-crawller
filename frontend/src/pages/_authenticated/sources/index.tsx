import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { SectionTitle } from "@/components/cards/stat-card";
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
import { cn } from "@/lib/utils";

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
      { title: "Sources & crawling — Parity" },
      {
        name: "description",
        content:
          "Connect your store, verify ownership, and configure discovery, crawl frequency, page limits and robots.txt behaviour.",
      },
      { property: "og:title", content: "Sources & crawling — Parity" },
      {
        property: "og:description",
        content:
          "Connect and verify your store, then configure crawl frequency and discovery rules.",
      },
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
  // Persisted so an accidental refresh keeps the expanded saved-crawl row open.
  const [expandedId, setExpandedId] = useLocalStorageState<string | null>(
    "parity.sources.expandedCrawlId",
    null,
  );

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
      job.params.storeSnapshots === storeSnapshots);

  if (isError) return <ErrorState />;
  if (isLoading || !workspace) return <LoadingState label="Loading sources…" />;

  // Real detection values from the latest saved crawl (GET returns newest
  // first). The workspace isn't connected yet, so store-level fields stay
  // honest "—" and everything else is measured from the last crawl.
  const latestCrawl = saved.data?.data?.[0];
  const d = latestCrawl?.discovery;
  const parseRate =
    latestCrawl && latestCrawl.stats.fetched > 0
      ? Math.round(
          (latestCrawl.products.length / latestCrawl.stats.fetched) * 100,
        )
      : null;
  const detected: Array<[string, string, string?]> = [
    [
      "Platform",
      latestCrawl?.discovery?.platform?.platform || workspace.platform || "—",
      latestCrawl?.discovery?.platform?.signal,
    ],
    ["Currency", workspace.currency || "—"],
    ["Language", workspace.language || "—"],
    [
      "Products found",
      latestCrawl ? latestCrawl.stats.discovered.toLocaleString() : "—",
    ],
    [
      "Categories",
      workspace.categories > 0 ? String(workspace.categories) : "—",
    ],
    [
      "Product URL pattern",
      latestCrawl?.products?.[0]?.url
        ? productUrlPattern(latestCrawl.products[0].url)
        : "—",
    ],
    [
      "Sitemap",
      d
        ? d.sitemap.error
          ? "Not found"
          : `${d.sitemap.urls.toLocaleString()} product URLs`
        : "—",
    ],
    ["robots.txt", robotsRowText(d)],
    [
      "Structured data",
      parseRate != null ? `${parseRate}% of pages parsed` : "—",
    ],
  ];

  // Real discovery diagnostics from the latest saved crawl — replaces the
  // old static "1,284 product URLs"-style placeholders.
  const discoveryRows: Array<[string, string]> = [];
  if (latestCrawl && d) {
    discoveryRows.push([
      "Sitemap",
      d.sitemap.error
        ? "Failed"
        : `${d.sitemap.urls.toLocaleString()} product URLs`,
    ]);
    discoveryRows.push([
      "HTML crawl",
      d.htmlCrawl.error
        ? "Failed"
        : `${d.htmlCrawl.pagesVisited.toLocaleString()} pages visited`,
    ]);
    if (d.collections.length > 0) {
      discoveryRows.push([
        "Collections",
        d.collections.map((c) => `${c.collection}: ${c.handles}`).join(", "),
      ]);
    }
    discoveryRows.push([
      "Platform",
      latestCrawl.discovery?.platform?.platform ?? "Unknown",
    ]);
    discoveryRows.push([
      "Structured data",
      parseRate != null ? `${parseRate}% of pages parsed` : "—",
    ]);
  }

  const collectionsList = collections
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  return (
    <div>
      <PageHeader
        eyebrow="Configuration"
        title="Sources & crawling"
        description="Your own store is scanned in depth after ownership verification. Competitor stores are crawled politely, respecting robots.txt and rate limits."
        actions={
          <Button>
            <Globe className="size-4" /> Add website
          </Button>
        }
      />

      <div className="grid gap-8 px-6 py-8 lg:grid-cols-2">
        <div>
          <SectionTitle
            aside={
              workspace.verified ? (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <CircleCheck className="size-3 text-success" /> Verified
                </Badge>
              ) : latestCrawl ? (
                <Badge variant="secondary" className="font-normal">
                  Detected from crawl
                </Badge>
              ) : (
                <Badge variant="secondary" className="font-normal">
                  Not connected
                </Badge>
              )
            }
          >
            Your website
          </SectionTitle>
          <div className="border border-border bg-card p-5">
            <p className="font-display text-2xl">{workspace.site || "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {workspace.verified
                ? `Ownership confirmed via ${workspace.verificationMethod} · last scan ${workspace.lastScan}`
                : latestCrawl
                  ? `Detected from the last crawl · ${formatCrawlDate(latestCrawl.updatedAt)}`
                  : "No store connected — run a crawl to detect your store."}
            </p>
            <dl className="mt-5 space-y-2 text-sm">
              {detected.map(([k, v, title]) => (
                <div
                  key={k}
                  className="flex justify-between gap-4 border-b border-border pb-2 last:border-0"
                >
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right" title={title}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <SectionTitle
            aside={
              latestCrawl ? (
                <Badge variant="secondary" className="font-normal">
                  Last crawl {formatCrawlDate(latestCrawl.updatedAt)}
                </Badge>
              ) : null
            }
          >
            Discovery engine
          </SectionTitle>
          {discoveryRows.length > 0 ? (
            <ul className="divide-y divide-border border border-border bg-card">
              {discoveryRows.map(([k, v]) => (
                <li
                  key={k}
                  className="flex items-center justify-between gap-4 p-3.5 text-sm"
                >
                  <span>{k}</span>
                  <span className="text-xs text-muted-foreground">{v}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border border-border bg-card p-5 text-sm text-muted-foreground">
              No crawl data yet — run a crawl to populate the discovery
              diagnostics.
            </p>
          )}
        </div>

        <div>
          <SectionTitle>Crawl configuration</SectionTitle>
          <div className="space-y-6 border border-border bg-card p-5">
            <div className="grid gap-2">
              <Label>Frequency</Label>
              <Select
                value={frequency}
                onValueChange={(v) => setFrequency(v as CrawlFrequency)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">Every hour</SelectItem>
                  <SelectItem value="6h">Every 6 hours</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>

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
              <Alert className="border-warning/50 [&>svg]:text-warning">
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
          </div>

          <SectionTitle>Verify a new website</SectionTitle>
          <div className="space-y-4 border border-border bg-card p-5">
            <div className="grid gap-2">
              <Label htmlFor="url">Website URL</Label>
              <Input id="url" placeholder="https://mystore.com" />
            </div>
            <div className="rule-top space-y-3 pt-4 text-sm">
              <p className="label-caps">Verification methods</p>
              <p className="text-muted-foreground">
                Upload <span className="numeric">parity-verify.html</span> to
                your web root, add a
                <span className="numeric">
                  {" "}
                  &lt;meta name="parity-verify"&gt;
                </span>{" "}
                tag, or publish a DNS TXT record.
              </p>
            </div>
            <Button variant="outline" className="w-full">
              Verify ownership
            </Button>
          </div>
        </div>
      </div>

      {/* Live crawl — runs the real crawler on the server. */}
      <div className="px-6 pb-8">
        <SectionTitle>Live crawl</SectionTitle>
        <div className="space-y-5 border border-border bg-card p-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Runs the real crawler against a store — sitemap + HTML discovery,
            then per-product JSON-LD / OpenGraph extraction with robots.txt and
            rate-limit respect. Leave collections empty to crawl the full
            catalogue.
          </p>
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
            <div className="grid gap-2">
              <Label htmlFor="crawl-origin">Store origin</Label>
              <Input
                id="crawl-origin"
                value={crawlOrigin}
                onChange={(e) => {
                  setCrawlOrigin(e.target.value);
                  setJobId(null);
                }}
                placeholder="https://store.example.com"
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
                placeholder="silicone-toys, bundles"
              />
            </div>
            <Button
              onClick={() =>
                start.mutate({
                  origin: crawlOrigin.trim(),
                  collections: collectionsList,
                  delayMs: crawlDelay,
                  maxConcurrencyPerHost: maxConcurrency,
                  maxPages: maxPages ?? undefined,
                  respectRobotsTxt: respectRobots,
                  productOnly,
                  storeSnapshots,
                })
              }
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
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button
              variant="outline"
              onClick={() =>
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
                })
              }
              disabled={schedule.isPending || !crawlOrigin.trim()}
            >
              <CalendarClock className="size-4" />
              Schedule every {frequencyLabel(frequency)}
            </Button>
            <span className="text-xs text-muted-foreground">
              Recurring crawls run automatically on the server (schedules are
              in-memory and reset on restart). Re-scheduling an origin replaces
              its existing schedule.
            </span>
          </div>{" "}
          {schedulesQuery.isError &&
          !schedulesQuery.data &&
          cachedSchedules.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Server unreachable — showing the last known schedules from memory.
              Recurring crawls live server-side and reset on restart.
            </p>
          ) : null}
          {schedules.length > 0 ? (
            <div>
              <p className="label-caps mb-2">Active schedules</p>
              <ul className="divide-y divide-border border border-border">
                {schedules.map((s) => (
                  <li
                    key={s.origin}
                    className="flex items-center justify-between gap-3 p-3 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono">
                        {s.origin}
                      </span>
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
            </div>
          ) : null}
          {isRunning && job ? (
            <div className="space-y-3">
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
                  discovery runs (job.total stays 0 until the fetch phase). */}
              {job.total === 0 && job.discovery ? (
                <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {discoveryPhaseLabel(job.discovery.phase)}
                    </span>
                    <span className="numeric">
                      {job.discovery.urlsFound.toLocaleString()} product URLs
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    {job.discovery.sitemapUrls > 0 ? (
                      <span>
                        Sitemap: {job.discovery.sitemapUrls.toLocaleString()}
                      </span>
                    ) : null}
                    {job.discovery.htmlPagesVisited > 0 ? (
                      <span>
                        Pages visited:{" "}
                        {job.discovery.htmlPagesVisited.toLocaleString()}
                      </span>
                    ) : null}
                    {job.discovery.htmlUrls > 0 ? (
                      <span>
                        HTML URLs: {job.discovery.htmlUrls.toLocaleString()}
                      </span>
                    ) : null}
                    {job.discovery.collectionHandles > 0 ? (
                      <span>
                        Collections:{" "}
                        {job.discovery.collectionHandles.toLocaleString()}
                      </span>
                    ) : null}
                  </div>
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
              </div>

              {!paramsMatch ? (
                <Alert className="border-warning/50 [&>svg]:text-warning">
                  <TriangleAlert className="size-4" />
                  <AlertTitle>Config changed mid-run</AlertTitle>
                  <AlertDescription>
                    This crawl is using the parameters it started with. Your
                    panel settings changed after it began — they apply to the
                    next crawl.
                  </AlertDescription>
                </Alert>
              ) : null}

              <p className="text-xs text-muted-foreground">
                {job.total === 0
                  ? `Reading sitemaps and following internal links — ${job.params.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}.`
                  : `Polite crawl (max ${job.params.maxConcurrencyPerHost} concurrent requests, ${(job.params.delayMs / 1000).toLocaleString()}s base delay, ${job.params.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}) — the estimate adjusts to the observed speed and any rate limits.${job.params.maxPages != null ? ` Crawl capped at ${job.params.maxPages.toLocaleString()} pages.` : ""}`}
              </p>
            </div>
          ) : null}
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
          {result ? (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">Crawl complete</p>
                {job?.persisted ? (
                  <Badge variant="secondary" className="gap-1 font-normal">
                    <CircleCheck className="size-3 text-success" /> Saved to
                    database
                  </Badge>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <CrawlStat label="Discovered" value={result.stats.discovered} />
                <CrawlStat label="Fetched" value={result.stats.fetched} />
                <CrawlStat
                  label="Skipped (unchanged)"
                  value={result.stats.skippedUnchanged}
                />
                <CrawlStat
                  label="Failed"
                  value={result.stats.failed}
                  accent={result.stats.failed > 0}
                />
                <CrawlStat
                  label="Duration"
                  value={`${(result.stats.durationMs / 1000).toFixed(1)}s`}
                />
              </div>

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
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {p.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {p.brand} ·{" "}
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono underline-offset-2 hover:underline"
                            >
                              {p.url}
                            </a>
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <Badge
                            variant={p.available ? "secondary" : "destructive"}
                            className="font-normal"
                          >
                            {p.available ? "In stock" : "Out of stock"}
                          </Badge>
                          <span className="text-right">
                            <span className="numeric block">
                              {p.price.toLocaleString("en-US", {
                                maximumFractionDigits: 2,
                              })}
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
            </div>
          ) : null}
        </div>
      </div>

      {/* Saved crawls — persisted results, reviewable without re-crawling. */}
      <div className="px-6 pb-8">
        <SectionTitle
          aside={
            <Badge variant="secondary" className="font-normal">
              {saved.data ? `${saved.data.data.length} saved` : "—"}
            </Badge>
          }
        >
          Saved crawls
        </SectionTitle>
        <div className="border border-border bg-card">
          {saved.isError ? (
            <p className="p-5 text-sm text-muted-foreground">
              Couldn't load saved crawls — check that the API is reachable.
            </p>
          ) : saved.isLoading || !saved.data ? (
            <p className="p-5 text-sm text-muted-foreground">
              <span className="inline-block size-2 animate-pulse rounded-full bg-accent" />{" "}
              Loading saved crawls…
            </p>
          ) : saved.data.data.length === 0 ? (
            <div className="p-10 text-center">
              <p className="font-display text-xl">No saved crawls yet</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Run a crawl above — when it finishes, the result is saved to the
                database and you can review it here without re-crawling.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {saved.data.data.map((crawl) => (
                <li key={crawl._id}>
                  <button
                    type="button"
                    aria-expanded={expandedId === crawl._id}
                    onClick={() =>
                      setExpandedId(expandedId === crawl._id ? null : crawl._id)
                    }
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-sm font-medium">
                        {crawl.origin}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {formatCrawlDate(crawl.updatedAt)} ·{" "}
                        {crawl.products.length} products ·{" "}
                        {crawl.failures.length} failed
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <Badge variant="secondary" className="font-normal">
                        {crawl.stats.discovered.toLocaleString()} URLs
                      </Badge>
                      {expandedId === crawl._id ? (
                        <ChevronUp className="size-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="size-4 text-muted-foreground" />
                      )}
                    </span>
                  </button>
                  {expandedId === crawl._id ? (
                    <div className="space-y-5 border-t border-border px-5 py-4">
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                        <CrawlStat
                          label="Discovered"
                          value={crawl.stats.discovered}
                        />
                        <CrawlStat
                          label="Fetched"
                          value={crawl.stats.fetched}
                        />
                        <CrawlStat
                          label="Skipped"
                          value={crawl.stats.skippedUnchanged}
                        />
                        <CrawlStat
                          label="Failed"
                          value={crawl.stats.failed}
                          accent={crawl.stats.failed > 0}
                        />
                        <CrawlStat
                          label="Duration"
                          value={`${(crawl.stats.durationMs / 1000).toFixed(1)}s`}
                        />
                      </div>

                      {crawl.failures.length > 0 ? (
                        <div>
                          <p className="label-caps mb-2">
                            Failures ({crawl.failures.length})
                          </p>
                          <ul className="max-h-40 space-y-1 overflow-auto text-xs">
                            {crawl.failures.slice(0, 12).map((f) => (
                              <li
                                key={f.url}
                                className="flex justify-between gap-3"
                              >
                                <span className="truncate font-mono text-muted-foreground">
                                  {f.url}
                                </span>
                                <span className="shrink-0 text-destructive">
                                  {f.error}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {crawl.products.length > 0 ? (
                        <div>
                          <p className="label-caps mb-2">
                            Products ({crawl.products.length}) — first{" "}
                            {Math.min(crawl.products.length, 8)}
                          </p>
                          <ul className="divide-y divide-border border border-border">
                            {crawl.products.slice(0, 8).map((p) => (
                              <li
                                key={p.url}
                                className="flex items-center justify-between gap-3 p-3 text-sm"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-medium">
                                    {p.name}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {p.brand}
                                  </span>
                                </span>
                                <span className="flex shrink-0 items-center gap-3">
                                  <Badge
                                    variant={
                                      p.available ? "secondary" : "destructive"
                                    }
                                    className="font-normal"
                                  >
                                    {p.available ? "In stock" : "Out of stock"}
                                  </Badge>
                                  <span className="numeric text-right">
                                    {p.price.toLocaleString("en-US", {
                                      maximumFractionDigits: 2,
                                    })}
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function formatCrawlDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Derives a store's product-URL pattern from a real crawled product URL. */
function productUrlPattern(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    parts[parts.length - 1] = "{slug}";
    return `/${parts.join("/")}`;
  } catch {
    return url;
  }
}

/** robots.txt presence + crawl-delay for the detected card's robots row. */
function robotsRowText(d: SavedCrawl["discovery"] | undefined): string {
  const r = d?.robots;
  if (!r) return "—";
  switch (r.status) {
    case "found":
      return r.crawlDelayMs != null
        ? `Present, crawl allowed · ${(r.crawlDelayMs / 1000).toLocaleString()}s crawl-delay`
        : "Present, crawl allowed";
    case "absent":
      return "Not found (crawl allowed)";
    case "unreachable":
      return "Unreachable — allow-all fallback";
    case "skipped":
      return "Not checked (respect off)";
  }
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

function CrawlStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="border border-border p-3">
      <p className="numeric text-xl" aria-label={label}>
        {value}
      </p>
      <p
        className={cn(
          "mt-0.5 text-xs",
          accent ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </p>
    </div>
  );
}
