import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { CircleCheck, Globe, Loader2, Play, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { SectionTitle } from "@/components/cards/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorState, LoadingState } from "@/components/common/states";
import { useWorkspace } from "@/hooks/useWorkspace";
import {
  runCrawlNow,
  type CrawlRunInput,
  type CrawlRunResult,
} from "@/lib/api";
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

  // Live crawl controls.
  const [crawlOrigin, setCrawlOrigin] = useState("https://obdesignsusa.com");
  const [collections, setCollections] = useState("");
  const crawl = useMutation({
    mutationFn: (input: CrawlRunInput) => runCrawlNow({ data: input }),
  });

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

  const result: CrawlRunResult | undefined = crawl.data;

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
              <Select defaultValue="6h">
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
              <Select defaultValue="5000">
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

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="product-only">Product-only mode</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Skip blog, help and policy pages
                </p>
              </div>
              <Switch id="product-only" defaultChecked />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="robots">Respect robots.txt</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Recommended for all sources
                </p>
              </div>
              <Switch id="robots" defaultChecked />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="snapshot">Store full snapshots</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Keeps history for trend analysis
                </p>
              </div>
              <Switch id="snapshot" defaultChecked />
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
                  crawl.reset();
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
                  crawl.reset();
                }}
                placeholder="silicone-toys, bundles"
              />
            </div>
            <Button
              onClick={() =>
                crawl.mutate({
                  origin: crawlOrigin.trim(),
                  collections: collectionsList,
                })
              }
              disabled={crawl.isPending || !crawlOrigin.trim()}
            >
              {crawl.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {crawl.isPending ? "Crawling…" : "Run crawl"}
            </Button>
          </div>

          {crawl.isPending ? (
            <p className="text-xs text-muted-foreground">
              Crawling politely (max 2 requests/second, robots.txt respected).
              Large catalogues can take a few minutes.
            </p>
          ) : null}

          {crawl.isError ? (
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertTitle>Request failed</AlertTitle>
              <AlertDescription className="break-all font-mono text-xs">
                {crawl.error instanceof Error
                  ? crawl.error.message
                  : String(crawl.error)}
              </AlertDescription>
            </Alert>
          ) : null}

          {result ? (
            result.error ? (
              <Alert variant="destructive">
                <TriangleAlert className="size-4" />
                <AlertTitle>Crawl failed</AlertTitle>
                <AlertDescription className="break-all font-mono text-xs">
                  {result.error}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <CrawlStat
                    label="Discovered"
                    value={result.stats.discovered}
                  />
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
                              variant={
                                p.available ? "secondary" : "destructive"
                              }
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
                    No products were parsed — the store may have rate-limited
                    this machine (HTTP 429) or no structured data was found.
                    Check the failures above.
                  </p>
                )}
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
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
