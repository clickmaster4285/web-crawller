import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Globe,
  Loader2,
  Play,
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
import { useWorkspace } from "@/hooks/useWorkspace";
import {
  cancelCrawlSchedule,
  getCrawlProgress,
  getCrawlSchedules,
  scheduleCrawl,
  startCrawl,
  type CrawlFrequency,
  type CrawlJob,
  type CrawlRunInput,
  type CrawlRunResult,
  type ScheduleCrawlInput,
} from "@/lib/crawl";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/sources/")({
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

const discovery = [
  ["XML sitemaps", "1,284 product URLs"],
  ["Category pages", "26 categories traversed"],
  ["Internal links", "4,911 links followed"],
  ["Structured data", "Product + Breadcrumb parsed"],
  ["Product feeds", "Google Merchant feed detected"],
  ["Store APIs", "Shopify products.json available"],
];

function SourcesPage() {
  const { data: workspace, isLoading, isError } = useWorkspace();
  const saved = useSavedCrawls();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Live crawl controls.
  const [crawlOrigin, setCrawlOrigin] = useState("https://obdesignsusa.com");
  const [collections, setCollections] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);

  // Crawl parameters — wired into the crawler via startCrawl.
  const [crawlDelay, setCrawlDelay] = useState(1000);
  const [maxConcurrency, setMaxConcurrency] = useState(2);
  const [maxPages, setMaxPages] = useState<number | null>(5000);
  const [respectRobots, setRespectRobots] = useState(true);
  const [productOnly, setProductOnly] = useState(true);
  const [storeSnapshots, setStoreSnapshots] = useState(true);
  const [frequency, setFrequency] = useState<CrawlFrequency>("6h");

  const start = useMutation({
    mutationFn: (input: CrawlRunInput) => startCrawl({ data: input }),
    onSuccess: ({ jobId: id }) => setJobId(id),
  });

  // Recurring crawls — registered on the server, ticked by its 30s interval.
  const schedulesQuery = useQuery({
    queryKey: ["crawl-schedules"],
    queryFn: () => getCrawlSchedules(),
    refetchInterval: 60_000,
  });
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
  const result: CrawlRunResult | undefined =
    job?.status === "done" ? job.result : undefined;

  // When a crawl finishes and persists, refresh the Saved crawls list so the
  // new result shows up without a manual reload.
  useEffect(() => {
    if (job?.persisted) {
      void queryClient.invalidateQueries({ queryKey: ["saved-crawls"] });
    }
  }, [job?.persisted, queryClient]);

  // Live clock — re-renders every second while a crawl runs so the elapsed
  // timer and ETA tick smoothly (the progress poll is 800ms).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const startedAt = job?.startedAt ?? 0;
  const elapsedMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
  // Adaptive ETA from the observed rate (products per ms), so it responds to
  // crawl parameters as they change: rate limits slow it down, warmup speeds
  // it up, and a growing discovery count extends it.
  const ratePerMs =
    job && job.total > 0 && elapsedMs > 0 ? job.processed / elapsedMs : 0;
  const remainingMs =
    job && ratePerMs > 0
      ? Math.max(0, (job.total - job.processed) / ratePerMs)
      : null;

  if (isError) return <ErrorState />;
  if (isLoading || !workspace) return <LoadingState label="Loading sources…" />;

  const detected = [
    ["Platform", workspace.platform],
    ["Currency", workspace.currency],
    ["Language", workspace.language],
    ["Products found", workspace.products.toLocaleString()],
    ["Categories", workspace.categories.toString()],
    ["Product URL pattern", "/products/{slug}"],
    ["Sitemap", "sitemap_index.xml — found"],
    ["robots.txt", "Present, crawl allowed"],
    ["Structured data", "schema.org/Product on 98% of pages"],
  ];

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
              <Badge variant="secondary" className="gap-1 font-normal">
                <CircleCheck className="size-3 text-success" /> Verified
              </Badge>
            }
          >
            Your website
          </SectionTitle>
          <div className="border border-border bg-card p-5">
            <p className="font-display text-2xl">{workspace.site}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Ownership confirmed via {workspace.verificationMethod} · last scan{" "}
              {workspace.lastScan}
            </p>
            <dl className="mt-5 space-y-2 text-sm">
              {detected.map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between gap-4 border-b border-border pb-2 last:border-0"
                >
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <SectionTitle>Discovery engine</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {discovery.map(([k, v]) => (
              <li
                key={k}
                className="flex items-center justify-between gap-4 p-3.5 text-sm"
              >
                <span>{k}</span>
                <span className="text-xs text-muted-foreground">{v}</span>
              </li>
            ))}
          </ul>
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
                value={maxPages === null ? "unlimited" : String(maxPages)}
                onValueChange={(v) =>
                  setMaxPages(v === "unlimited" ? null : Number(v))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="500">500</SelectItem>
                  <SelectItem value="1000">1,000</SelectItem>
                  <SelectItem value="5000">5,000</SelectItem>
                  <SelectItem value="unlimited">Unlimited</SelectItem>
                </SelectContent>
              </Select>
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
          </div>

          {schedulesQuery.data && schedulesQuery.data.length > 0 ? (
            <div>
              <p className="label-caps mb-2">Active schedules</p>
              <ul className="divide-y divide-border border border-border">
                {schedulesQuery.data.map((s) => (
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
                  Elapsed{" "}
                  <span className="numeric">{formatDuration(elapsedMs)}</span>
                </span>
                <span>
                  {remainingMs != null
                    ? `~${formatDuration(remainingMs)} remaining`
                    : "Estimating time…"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {job.total === 0
                  ? `Reading sitemaps and following internal links — ${job.params?.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}.`
                  : `Polite crawl (max ${job.params?.maxConcurrencyPerHost ?? 2} concurrent requests, ${(job.params?.delayMs ?? 1000) / 1000}s base delay, ${job.params?.respectRobotsTxt === false ? "robots.txt ignored" : "robots.txt respected"}) — the estimate adjusts to the observed speed and any rate limits.${job.params?.maxPages != null ? ` Crawl capped at ${job.params.maxPages.toLocaleString()} pages.` : ""}`}
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

          {progress.isFetched && progress.data === null && !start.isPending ? (
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
