import type { ReactNode } from "react";
import { Store } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { SavedCrawl } from "@/lib/api";
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

/**
 * Compact store profile for the Crawler page — the platform, sitemap,
 * robots.txt, URL pattern, parse rate and product count detected from the
 * latest saved crawl of the domain being crawled. Renders an honest empty
 * state when that domain hasn't been crawled yet.
 */
export function StoreProfile({
  crawl,
  domain,
  headerAction,
}: {
  /** Newest saved snapshot for the domain being crawled (or undefined). */
  crawl: SavedCrawl | undefined;
  /** Normalized host of the domain entered in the crawler. */
  domain: string;
  /** Optional action rendered in the header row (e.g. a "View catalogue" link). */
  headerAction?: ReactNode;
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
        <ProfileCell
          label="Platform"
          value={d.platform?.platform ?? "Unknown"}
          title={d.platform?.signal}
        />
        <ProfileCell
          label="Sitemap"
          value={
            d.sitemap?.error
              ? "Not found"
              : `${(d.sitemap?.urls ?? 0).toLocaleString()} product URLs`
          }
        />
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
    </section>
  );
}
