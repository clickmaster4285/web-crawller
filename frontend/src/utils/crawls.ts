import type { CrawlDiscovery } from "@/api";

/**
 * Ensures an origin input has an http(s) scheme (defaults to https) and is
 * otherwise untouched — the full URL, not the host.
 */
export function toOriginUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Normalizes an origin to a comparable host key (drops protocol + www). */
export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return origin
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "");
  }
}

/**
 * Prefills the Crawler page with a store origin before navigating to /sources
 * (persisted in localStorage, which the page reads on mount).
 */
export function prefillCrawlerOrigin(origin: string): void {
  try {
    window.localStorage.setItem(
      "parity.sources.origin",
      JSON.stringify(origin),
    );
    window.localStorage.setItem(
      "parity.sources.collections",
      JSON.stringify(""),
    );
  } catch {
    // Storage unavailable — the crawler page keeps its last values.
  }
}

/** Minimal product shape the diff needs (saved + live results both match). */
export interface DiffableProduct {
  url: string;
  price?: number;
}

export interface CrawlDiff<T extends DiffableProduct> {
  newProducts: T[];
  removedProducts: T[];
  priceChangedCount: number;
}

/**
 * Crawl kind of a normalized snapshot: "shallow" (sitemap-only check —
 * `full` is false, the run fetched only new pages) or "deep" (full
 * catalogue crawl — `full` is true). The legacy `type` field was replaced
 * by `Snapshot.full` on the D1 read path.
 */
export function snapshotType(snapshot: { full?: boolean }): "shallow" | "deep" {
  return snapshot.full === false ? "shallow" : "deep";
}

/** Max-pages select modes: presets, a free "Custom…" input, or unlimited. */
export type MaxPagesMode = "500" | "1000" | "5000" | "custom" | "unlimited";

/** Parses the Custom… input into a positive page cap (`null` when empty/invalid). */
export function parseCustomMaxPages(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Human-readable date for a crawl timestamp (e.g. "Aug 3, 2026, 2:05 PM"). */
export function formatCrawlDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Derives a store's product-URL pattern from a real crawled product URL. */
export function productUrlPattern(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    parts[parts.length - 1] = "{slug}";
    return `/${parts.join("/")}`;
  } catch {
    return url;
  }
}

/** robots.txt presence + declared crawl-delay (from a snapshot's discovery). */
export function robotsText(r: CrawlDiscovery["robots"] | undefined): string {
  if (!r) return "—";
  switch (r.status) {
    case "found":
      return r.crawlDelayMs != null
        ? `Present · ${(r.crawlDelayMs / 1000).toLocaleString()}s crawl-delay`
        : "Present, crawl allowed";
    case "absent":
      return "Not found (crawl allowed)";
    case "unreachable":
      return "Unreachable — allow-all fallback";
    case "skipped":
      return "Not checked (respect off)";
  }
}
