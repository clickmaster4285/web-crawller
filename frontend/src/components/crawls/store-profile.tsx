import type { ReactNode } from "react";
import {
  ArrowUpRight,
  CircleCheck,
  Home,
  Link2,
  Store,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SavedCrawl } from "@/api";
import { formatCrawlDate, productUrlPattern, robotsText } from "@/utils/crawls";
import { cn } from "@/lib/utils";

function ProfileCell({
  label,
  value,
  title,
  mono = false,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="label-caps truncate">{label}</p>
      <p
        title={title}
        className={cn(
          "mt-1.5 truncate",
          mono ? "font-mono text-xs" : "text-sm font-medium",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** Platform kind badge — store / corporate site / unknown. */
function PlatformKindBadge({
  kind,
}: {
  kind: "store" | "corporate" | "unknown" | undefined;
}) {
  if (!kind || kind === "unknown") return null;
  return (
    <Badge
      variant={kind === "store" ? "secondary" : "outline"}
      className="ml-1.5 align-middle font-normal"
      title={
        kind === "store"
          ? "This site sells products directly"
          : "Marketing/brochure site — products may live elsewhere"
      }
    >
      {kind === "store" ? "Store" : "Corporate site"}
    </Badge>
  );
}

/**
 * Compact store profile for the Crawler page — the platform, sitemap,
 * robots.txt, URL pattern, parse rate and product count detected from the
 * latest saved crawl of the domain being crawled. Surfaces the verbose
 * discovery analysis (platform kind, homepage signals, sitemap candidates,
 * findings/suggestions). Renders an honest empty state when that domain
 * hasn't been crawled yet.
 */
export function StoreProfile({
  crawl,
  domain,
  headerAction,
  onSuggestionClick,
  lastShallow,
}: {
  /** Newest saved snapshot for the domain being crawled (or undefined). */
  crawl: SavedCrawl | undefined;
  /** Normalized host of the domain entered in the crawler. */
  domain: string;
  /** Optional action rendered in the header row (e.g. a "View catalogue" link). */
  headerAction?: ReactNode;
  /** Called when the user clicks a suggestion action (e.g. crawl the linked store). */
  onSuggestionClick?: (url: string) => void;
  /** Newest shallow (sitemap-only) snapshot — rendered as a "last quick check" strip. */
  lastShallow?: SavedCrawl;
}) {
  const d = crawl?.discovery;
  const parseRate =
    crawl && crawl.stats.fetched > 0
      ? Math.round((crawl.products.length / crawl.stats.fetched) * 100)
      : null;

  if (!crawl || !d) {
    return (
      <section className="border border-dashed border-border bg-card px-5 py-4">
        <div className="flex items-center gap-3">
          <Store className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-display text-base">Store profile</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {domain
                ? `No detection data for ${domain} yet — run a crawl to detect its platform, sitemap and robots.txt.`
                : "Enter a store domain to see its detected profile."}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const platform = d.platform?.platform ?? "Unknown";
  const platformTitle = [
    d.platform?.signal,
    d.platform?.builder && `Built with ${d.platform.builder}`,
    d.platform?.seoPlugin && `SEO: ${d.platform.seoPlugin}`,
    d.platform?.server && `Server: ${d.platform.server}`,
    d.platform?.generator && `Generator: ${d.platform.generator}`,
  ]
    .filter(Boolean)
    .join(" · ");

  // Sitemap analysis — the candidate outcomes explain why products were/were
  // not found (e.g. /sitemap.xml redirected, product sitemap present or not).
  const sitemapCells = (d.sitemap.candidates ?? []).filter(
    (c) => c.status !== "error" || c.urls > 0,
  );
  const sitemapSummary =
    sitemapCells.length > 0
      ? sitemapCells
          .map((c) => {
            const name = c.url.split("/").pop() ?? c.url;
            if (c.status === "html") return `${name} redirected to a page`;
            if (c.status === "error") return `${name} error`;
            return c.productUrls > 0
              ? `${name}: ${c.productUrls.toLocaleString()} products`
              : `${name}: no products`;
          })
          .join(" · ")
      : d.sitemap?.error
        ? "Not found"
        : `${(d.sitemap?.urls ?? 0).toLocaleString()} product URLs`;

  const homepage = d.homepage;

  return (
    <section className="border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Store className="size-4 shrink-0 text-muted-foreground" />
          <h3 className="font-display text-lg">Store profile</h3>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {domain}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-normal">
            Last crawled {formatCrawlDate(crawl.updatedAt)}
          </Badge>
          {headerAction}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        <ProfileCell label="Platform" value={platform} title={platformTitle} />
        <ProfileCell label="Sitemap" value={sitemapSummary} />
        <ProfileCell label="robots.txt" value={robotsText(d.robots)} />
        <ProfileCell
          label="URL pattern"
          value={
            crawl.products[0] ? productUrlPattern(crawl.products[0].url) : "—"
          }
          mono
        />
        <ProfileCell
          label="Parse rate"
          value={parseRate != null ? `${parseRate}%` : "—"}
        />
        <ProfileCell
          label="Products"
          value={crawl.products.length.toLocaleString()}
        />
      </div>

      {/* Platform kind + homepage analysis row. */}
      {d.platform?.kind || homepage ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
          {d.platform?.kind ? (
            <span className="inline-flex items-center gap-1.5">
              <Store className="size-3.5" />
              Detected as
              <PlatformKindBadge kind={d.platform.kind} />
              <span className="sr-only">{platformTitle}</span>
            </span>
          ) : null}
          {homepage ? (
            <span
              className="inline-flex min-w-0 items-center gap-1.5"
              title={`${homepage.productLinks} product links · ${homepage.categoryLinks} category links on the homepage`}
            >
              <Home className="size-3.5 shrink-0" />
              <span className="truncate">
                {homepage.looksLikeStore
                  ? `${homepage.productLinks} product link${homepage.productLinks === 1 ? "" : "s"} on the homepage`
                  : homepage.externalStoreLinks.length > 0
                    ? "Corporate site — no product links"
                    : "No product links on the homepage"}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Last quick check (shallow sitemap-only run) — when it ran and what
          it found. Shallow discovery filters the sitemap down to URLs the
          store doesn't already sell, so `stats.discovered` IS the new-product
          count — and it's uncapped, unlike `products.length` (which `maxPages`
          can truncate). Zero new products reads as "nothing changed". */}
      {lastShallow ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-5 py-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Zap className="size-3.5 text-amber-500" />
            Last quick check{" "}
            <time
              dateTime={lastShallow.updatedAt}
              className="font-normal text-muted-foreground"
            >
              {formatCrawlDate(lastShallow.updatedAt)}
            </time>
          </span>
          {lastShallow.stats.discovered > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <CircleCheck className="size-3.5 text-success" />
              {lastShallow.stats.discovered.toLocaleString()} new product
              {lastShallow.stats.discovered === 1 ? "" : "s"} found
            </span>
          ) : (
            <span className="text-muted-foreground">
              No new products since the last crawl
            </span>
          )}
        </div>
      ) : null}

      {/* Verbose findings / suggestions (external store links, corporate-site notes). */}
      {d.findings && d.findings.length > 0 ? (
        <ul className="space-y-1.5 border-t border-border px-5 py-3">
          {d.findings.map((f, i) => (
            <li
              key={`${f.message}-${i}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs"
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
                  onClick={() => onSuggestionClick?.(f.action!.url)}
                >
                  <Link2 className="size-3" />
                  {f.action.label}
                  <ArrowUpRight className="size-3" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
