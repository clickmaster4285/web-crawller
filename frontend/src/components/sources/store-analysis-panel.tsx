import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  BadgeCheck,
  FlaskConical,
  Loader2,
  ScanSearch,
  ShieldAlert,
} from "lucide-react";

import { SectionTitle } from "@/components/cards/stat-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TierBadge } from "@/components/sources/tier-badge";
import { HealthChip } from "@/components/sources/health-chip";
import { analyzeWebsite, type WebsiteProfile } from "@/lib/crawl";

/**
 * What "apply recommendation" changes in the crawl config. Today only
 * `useBrowser` needs to move — a csr-shell verdict means pages are JS shells
 * and must be rendered to extract prices. Everything else the engine already
 * auto-decides (API-first probes, sitemap, HTML fallback).
 */
export interface AnalysisConfigPatch {
  useBrowser: boolean;
}

/** Human-readable line for each recommendation tier. */
const TIER_NOTES: Record<WebsiteProfile["recommendation"]["tier"], string> = {
  "API-first":
    "A public store API exists (Shopify products.json / WooCommerce / BigCommerce). The engine probes it automatically during discovery — structured JSON beats HTML scraping.",
  "sitemap-HTTP":
    "Product sitemap + server-rendered content-rich pages — plain HTTP at full speed, no rendering cost.",
  "sitemap-browser":
    "Pages are client-rendered shells — crawl with auto JS rendering ON so prices can be extracted.",
  "HTML-BFS":
    "No usable sitemap — the engine falls back to following product links from the homepage.",
  manual:
    "This WAF blocks automated requests from this machine — use a Tier-2 residential proxy with slower concurrency, or skip the store.",
};

/** Small labelled value cell (matches the StoreProfile grid style). */
function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="label-caps truncate">{label}</p>
      <p className="mt-1.5 truncate text-sm font-medium" title={value}>
        {value}
      </p>
    </div>
  );
}

/**
 * P2 Phase 2 — Website Intelligence Analyzer UI on the Sources store profile.
 * "Run analysis" fires the five probes (platform, store APIs, JSON-LD, bot
 * protection, render mode) WITHOUT enqueuing a crawl, then renders the
 * `WebsiteProfile` and offers to pre-fill the crawl config from the
 * recommendation.
 */
export function StoreAnalysisPanel({
  origin,
  proxy,
  userAgent,
  onApplyRecommendation,
  onCrawlInstead,
}: {
  /** Full origin URL to analyze (https://…). */
  origin: string;
  /** Current Tier-2 proxy URL from the config panel (probes route through it). */
  proxy?: string;
  /**
   * Current per-store User-Agent: "browser" probes with a Chrome UA so a WAF
   * that 403s ParityBot (dawlance) doesn't hide its real answers here either.
   */
  userAgent?: "browser";
  /** Applies the recommended crawl config (e.g. useBrowser for JS shells). */
  onApplyRecommendation?: (patch: AnalysisConfigPatch) => void;
  /**
   * Fills the crawler with an external store URL (a corporate site's real
   * priced storefront, e.g. haiermall.pk behind haier.com) so the user can
   * crawl THAT domain instead.
   */
  onCrawlInstead?: (url: string) => void;
}) {
  const [profile, setProfile] = useState<WebsiteProfile | null>(null);
  // When the run that produced the CURRENT profile started, so the "Probes"
  // cell can show its actual duration — frozen in onSuccess. Computing it
  // from `Date.now()` at render time would grow on every re-render (the
  // Sources page ticks a 1s clock while a crawl runs) and a failed re-run
  // would pair an old profile with a new start.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [runDurationMs, setRunDurationMs] = useState<number | null>(null);
  const analyze = useMutation({
    mutationFn: () => analyzeWebsite({ data: { origin, proxy, userAgent } }),
    onMutate: () => {
      setStartedAt(Date.now());
      setProfile(null); // a re-run replaces the previous result (no stale pair)
      setRunDurationMs(null);
    },
    onSuccess: (result) => {
      setProfile(result);
      // Freeze the run's wall-clock duration (round-trip + server probes).
      setRunDurationMs(startedAt != null ? Date.now() - startedAt : null);
    },
  });

  const probeSeconds =
    runDurationMs != null
      ? Math.max(1, Math.round(runDurationMs / 1000))
      : null;

  // Only a csr-shell verdict has a REAL config change to apply: those pages
  // are JS shells, so the next crawl must render them. For every other
  // verdict the recommendation is already the engine's default (auto render
  // ON is recommended — never emit `useBrowser: false` for an ssr store; it
  // would disable the safety net and gain nothing).
  const canApply = profile != null && profile.rendering.verdict === "csr-shell";

  return (
    <section>
      <SectionTitle
        aside={
          <Button
            variant={profile ? "outline" : "default"}
            size="sm"
            onClick={() => analyze.mutate()}
            disabled={analyze.isPending}
          >
            {analyze.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FlaskConical className="size-4" />
            )}
            {analyze.isPending
              ? "Analyzing…"
              : profile
                ? "Re-run analysis"
                : "Run analysis"}
          </Button>
        }
      >
        Website analysis
      </SectionTitle>

      <Card>
        {analyze.isPending ? (
          <div className="flex items-center gap-3 px-5 py-6">
            <Loader2 className="size-4 animate-spin text-accent" />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                Probing {origin.replace(/^https?:\/\//, "")}…
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Platform, store APIs, JSON-LD, bot protection and render mode —
                a few polite requests, usually under 15 seconds. No crawl is
                started.
              </p>
            </div>
          </div>
        ) : profile ? (
          <div>
            {/* P4 store-health pass — the pre-flight verdict: will a crawl of
                this store actually yield products? Flags the expensive dead
                ends (no-products / blocked / corporate) before worker hours
                burn. The flags are the human-readable "why". */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-5 py-3.5">
              <HealthChip
                verdict={profile.health.verdict}
                score={profile.health.score}
              />
              <p className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
                {profile.health.flags.length > 0
                  ? profile.health.flags.join(" · ")
                  : "Store-health pass — probe results only."}
              </p>
            </div>

            {/* Probe results grid. */}
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
              <Cell
                label="Platform"
                value={`${profile.platform.name} · ${profile.platform.kind}`}
              />
              <Cell
                label="API"
                value={
                  profile.api.shopifyProductsJson === "public" ||
                  profile.api.wooCommerce === "public" ||
                  profile.api.bigCommerce === "public" ||
                  profile.api.storefront === "public"
                    ? "public ✓"
                    : "none"
                }
              />
              <Cell
                label="Protection"
                value={
                  profile.protection.blocking
                    ? `${profile.protection.provider} · blocking`
                    : profile.protection.provider
                }
              />
              <Cell
                label="Rendering"
                value={`${profile.rendering.verdict} · ${profile.rendering.framework}`}
              />
              <Cell
                label="Sitemap"
                value={
                  profile.sitemap.found
                    ? `${profile.sitemap.urls.toLocaleString()} products`
                    : "not found"
                }
              />
              <Cell
                label="Probes"
                value={
                  probeSeconds != null
                    ? `${profile.requests} requests · ${probeSeconds}s`
                    : `${profile.requests} requests`
                }
              />
            </div>

            {/* External store links — a corporate site (haier.com) that links
                out to its real priced storefront (haiermall.pk). The crawl's
                discovery findings already suggest it; show it here too with
                a one-click "crawl instead" action. */}
            {profile.homepage.externalStoreLinks.length > 0 ? (
              <div className="border-t border-border bg-card px-5 py-3">
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <ScanSearch className="mt-px size-3.5 shrink-0 text-accent" />
                  <span className="leading-snug">
                    This site looks corporate — its links point to{" "}
                    <span className="font-medium text-foreground">
                      {profile.homepage.externalStoreLinks
                        .map((l) => l.host)
                        .join(", ")}
                    </span>
                    . The prices likely live there, not here.
                  </span>
                </p>
                {onCrawlInstead ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {profile.homepage.externalStoreLinks
                      .slice(0, 2)
                      .map((l) => (
                        <Button
                          key={l.host}
                          variant="outline"
                          size="sm"
                          className="h-7 font-mono text-[11px]"
                          onClick={() => onCrawlInstead(l.url)}
                        >
                          Crawl {l.host} instead
                        </Button>
                      ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Recommendation banner. */}
            <div className="border-t border-border bg-card px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <TierBadge tier={profile.recommendation.tier} />
                  <span className="truncate text-sm text-muted-foreground">
                    {TIER_NOTES[profile.recommendation.tier]}
                  </span>
                </div>{" "}
                {onApplyRecommendation && canApply ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onApplyRecommendation({ useBrowser: true })}
                  >
                    <BadgeCheck className="size-4" />
                    Enable auto JS rendering
                  </Button>
                ) : null}
              </div>
              {profile.protection.blocking ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
                  <ShieldAlert className="size-3.5 shrink-0" />
                  {profile.protection.evidence} — a proxy or manual handling may
                  be needed despite the recommendation.
                </p>
              ) : null}
              {canApply ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  This store's pages are client-rendered shells — enable auto JS
                  rendering for the next crawl so prices can be extracted.
                </p>
              ) : onApplyRecommendation ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Config already matches this recommendation — no changes
                  needed.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-5 py-6">
            <ScanSearch className="size-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Answers “how is this site built, and what's the optimal way to
              crawl it?” in a few polite requests — before you spend a 20-minute
              crawl finding out. No crawl is enqueued.
            </p>
          </div>
        )}

        {analyze.isError ? (
          <div className="border-t border-border px-5 py-4">
            <Alert variant="destructive">
              <ShieldAlert className="size-4" />
              <AlertTitle>Analysis failed</AlertTitle>
              <AlertDescription className="break-all font-mono text-xs">
                {analyze.error instanceof Error
                  ? analyze.error.message
                  : String(analyze.error)}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
