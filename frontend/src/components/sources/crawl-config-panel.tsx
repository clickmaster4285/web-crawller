import { Globe, TriangleAlert } from "lucide-react";

import { SectionTitle } from "@/components/cards/stat-card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { MaxPagesMode } from "@/utils/crawls";

/** Crawl configuration section — applies to the next crawl. */
export function CrawlConfigPanel({
  maxPagesMode,
  onMaxPagesModeChange,
  customMaxPages,
  onCustomMaxPagesChange,
  maxConcurrency,
  onMaxConcurrencyChange,
  crawlDelay,
  onCrawlDelayChange,
  productOnly,
  onProductOnlyChange,
  respectRobots,
  onRespectRobotsChange,
  storeSnapshots,
  onStoreSnapshotsChange,
  useBrowser,
  onUseBrowserChange,
  proxy,
  onProxyChange,
}: {
  maxPagesMode: MaxPagesMode;
  onMaxPagesModeChange: (mode: MaxPagesMode) => void;
  customMaxPages: string;
  onCustomMaxPagesChange: (value: string) => void;
  maxConcurrency: number;
  onMaxConcurrencyChange: (value: number) => void;
  crawlDelay: number;
  onCrawlDelayChange: (value: number) => void;
  productOnly: boolean;
  onProductOnlyChange: (value: boolean) => void;
  respectRobots: boolean;
  onRespectRobotsChange: (value: boolean) => void;
  storeSnapshots: boolean;
  onStoreSnapshotsChange: (value: boolean) => void;
  useBrowser: boolean;
  onUseBrowserChange: (value: boolean) => void;
  proxy: string;
  onProxyChange: (value: string) => void;
}) {
  return (
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
            onValueChange={(v) => onMaxPagesModeChange(v as MaxPagesMode)}
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
                onChange={(e) => onCustomMaxPagesChange(e.target.value)}
                placeholder="e.g. 5 or 10 for a quick test"
              />
              <p className="text-xs text-muted-foreground">
                Small caps like 5 or 10 are great for testing — the crawl stops
                after this many product pages. Leave empty for unlimited.
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
            onValueChange={(v) => onMaxConcurrencyChange(Number(v))}
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
            onValueChange={(v) => onCrawlDelayChange(Number(v))}
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
            onCheckedChange={onProductOnlyChange}
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
            onCheckedChange={onRespectRobotsChange}
          />
        </div>
        {!respectRobots ? (
          <Alert className="border-warning/50 [&>svg]:text-warning lg:col-span-2">
            <TriangleAlert className="size-4" />
            <AlertTitle>robots.txt disabled</AlertTitle>
            <AlertDescription>
              The crawler will ignore robots.txt disallow rules and crawl-delay.
              This can violate site terms and get your IP blocked — use only on
              sites you own.
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
            onCheckedChange={onStoreSnapshotsChange}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="browser">Auto-detect JS-rendered pages</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Renders only pages that need it (Nuxt/SPA shells) — content-rich
              stores stay on plain HTTP. Needs Chrome installed
            </p>
          </div>
          <Switch
            id="browser"
            checked={useBrowser}
            onCheckedChange={onUseBrowserChange}
          />
        </div>
        {useBrowser ? (
          <Alert className="border-accent/50 [&>svg]:text-accent lg:col-span-2">
            <Globe className="size-4" />
            <AlertTitle>Tier 1 — auto JS rendering on</AlertTitle>
            <AlertDescription>
              Recommended. Every page is checked automatically: only ones whose
              raw HTML is a client-rendered shell (bare mount + JS bundle,
              almost no links or structured data) are rendered in headless
              Chrome. Server-rendered product pages are never re-rendered, so
              regular stores keep crawling at full HTTP speed.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="lg:col-span-2">
          <Label htmlFor="proxy">Residential proxy (optional)</Label>
          <Input
            id="proxy"
            type="password"
            value={proxy}
            onChange={(e) => onProxyChange(e.target.value)}
            placeholder="http://user:pass@gate.provider.com:8000"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Tier 2 — routes every request through a rotating residential gateway
            (Oxylabs / Bright Data / Smartproxy) to fix IP blocks on stores that
            403 this machine. Credentials stay in your browser; the server never
            stores or logs them.
          </p>
        </div>
      </div>
    </section>
  );
}
