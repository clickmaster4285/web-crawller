import { CalendarClock, Globe, Loader2, Play, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CrawlFrequency } from "@/lib/crawl";
import { normalizeOrigin } from "@/utils/crawls";

/**
 * A recent store for one-click re-runs — built from the lightweight crawl
 * summaries (`?meta=1`), so this panel never downloads full catalogues.
 */
export interface RecentCrawl {
  _id: string;
  origin: string;
  collections?: string[];
  productCount: number;
}

/** The "Start a crawl" card — domain, collections, recent stores and the
 * Run crawl / Quick check / Schedule actions. */
export function CrawlSetupPanel({
  crawlOrigin,
  onOriginChange,
  collections,
  onCollectionsChange,
  recentDomains,
  onPickRecent,
  frequency,
  onFrequencyChange,
  onRunCrawl,
  onRunQuickCheck,
  onSchedule,
  running,
  pendingDeep,
  pendingShallow,
  startPending,
  schedulePending,
}: {
  crawlOrigin: string;
  onOriginChange: (value: string) => void;
  collections: string;
  onCollectionsChange: (value: string) => void;
  recentDomains: RecentCrawl[];
  onPickRecent: (crawl: RecentCrawl) => void;
  frequency: CrawlFrequency;
  onFrequencyChange: (value: CrawlFrequency) => void;
  onRunCrawl: () => void;
  onRunQuickCheck: () => void;
  onSchedule: () => void;
  running: boolean;
  pendingDeep: boolean;
  pendingShallow: boolean;
  startPending: boolean;
  schedulePending: boolean;
}) {
  const canStart = !startPending && !running && crawlOrigin.trim().length > 0;

  return (
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
            onChange={(e) => onOriginChange(e.target.value)}
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
            onChange={(e) => onCollectionsChange(e.target.value)}
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
                  onClick={() => onPickRecent(c)}
                  className="group flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted"
                >
                  <Globe className="size-3 text-muted-foreground group-hover:text-primary" />
                  <span className="font-mono">{normalizeOrigin(c.origin)}</span>
                  <span className="text-muted-foreground">
                    · {c.productCount} products
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            size="lg"
            onClick={onRunCrawl}
            disabled={!canStart}
            title="Analyzes the store first (a few polite probes, ~5–15s), then starts the crawl with the recommended strategy — API, sitemap or HTML links, browser rendering as needed."
          >
            {pendingDeep || running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {pendingDeep ? "Analyzing…" : running ? "Crawling…" : "Run crawl"}
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={onRunQuickCheck}
            disabled={!canStart}
            title="Sitemap-only check — fetches only new product pages (~1 request when nothing changed). The stored catalogue is never touched."
          >
            {pendingShallow ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Zap className="size-4" />
            )}
            {pendingShallow ? "Checking…" : "Quick check"}
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={frequency}
              onValueChange={(v) => onFrequencyChange(v as CrawlFrequency)}
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
              onClick={onSchedule}
              disabled={schedulePending || !crawlOrigin.trim()}
            >
              <CalendarClock className="size-4" />
              Schedule recurring
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Run crawl probes the store first (a few polite requests, ~5–15s) and
          starts with the recommended strategy — you'll see the analysis on the
          progress panel. Quick check runs a sitemap-only crawl — it fetches
          just the new product pages (≈1 request when nothing changed).
          Recurring crawls run automatically via the scheduler (schedules
          persist on the server, so they survive restarts). Re-scheduling an
          origin replaces its existing schedule.
        </p>
      </div>
    </section>
  );
}
