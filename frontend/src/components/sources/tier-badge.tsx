import { Sparkles } from "lucide-react";

import type { CrawlTier } from "@/lib/crawl";

/**
 * Shared recommendation-tier badge (P2 — Website Intelligence Analyzer).
 * Used by the standalone analysis panel, the analyze-first crawl progress
 * panel, and the Active crawls cards, so the tier styling never drifts.
 * Tone: success for fast tiers, warning for browser-rendered, destructive
 * for WAF-blocked (manual).
 */
export function TierBadge({ tier }: { tier: CrawlTier }) {
  const tone =
    tier === "API-first" || tier === "sitemap-HTTP"
      ? "bg-success/10 text-success"
      : tier === "manual"
        ? "bg-destructive/10 text-destructive"
        : "bg-warning/10 text-warning";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}
    >
      <Sparkles className="size-3.5" />
      {tier}
    </span>
  );
}
