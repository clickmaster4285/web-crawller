/**
 * Unified product discovery.
 *
 * Combines all available strategies into a single set of product URLs:
 *   1. Shopify collection page walks (if `collections` is set)
 *   2. Sitemap candidates — robots.txt-declared sitemaps first, then
 *      `/sitemap.xml` and `/sitemap_index.xml` (an HTML redirect to the
 *      homepage is detected and skipped, not counted as "0 URLs")
 *   3. HTML link-graph BFS from the site root (fallback)
 *
 * Each strategy contributes URLs; the union is deduped. Failures in any one
 * strategy don't block the others — they're recorded but the run continues.
 *
 * Besides the URL set, discovery produces a **verbose log** (what it did, in
 * order), a **homepage analysis** (store vs corporate, external store links)
 * and **findings** (human-readable notes/suggestions such as "this looks like
 * a corporate site — crawl its linked shop instead"). All of it flows into
 * `diagnostics` for the UI and persistence.
 */

import { discoverCollectionHandles } from "../adapters/shopify-discover.ts";
import { discoverByHtmlCrawl } from "./html-crawl.ts";
import { analyzeHomepage } from "./homepage.ts";
import { detectPlatform } from "./platform.ts";
import {
  fetchSitemapCandidate,
  sitemapCandidates,
  type DiscoveredUrl,
  type SitemapCandidateResult,
} from "./sitemap.ts";
import type {
  CrawlConfig,
  CrawlFinding,
  DiscoveryDiagnostics,
  DiscoveryProgress,
  RobotsInfo,
  RobotsSnapshot,
} from "../core/types.ts";
import type { HttpOptions } from "../core/http.ts";
import { httpOptions } from "../core/http.ts";

const DISCOVERY_MAX_PAGES = 60;
const DISCOVERY_MAX_DEPTH = 3;

export interface ProductDiscovery {
  /** Absolute product page URLs, deduped. */
  urls: string[];
  /** URLs that the sitemap paired with a lastmod value. */
  lastmod: Map<string, string>;
  /** Diagnostics from each strategy + the verbose log + findings. */
  diagnostics: DiscoveryDiagnostics;
}

/**
 * Discovers product URLs using all available strategies. Each strategy runs
 * in isolation; failures are captured in `diagnostics` rather than thrown.
 *
 * When `opts.isAllowed` (robots.txt gate) is provided, disallowed product
 * URLs are dropped from the returned set.
 */
export async function discoverProducts(
  config: CrawlConfig,
  opts: HttpOptions = httpOptions(config),
  /** robots.txt snapshot already fetched by the politeness layer (no refetch). */
  robots?: RobotsSnapshot | null,
): Promise<ProductDiscovery> {
  const urlSet = new Set<string>();
  const lastmod = new Map<string, string>();
  const log: string[] = [];
  const findings: CrawlFinding[] = [];
  const robotsInfo: RobotsInfo = robots
    ? { status: robots.status, crawlDelayMs: robots.crawlDelayMs }
    : { status: "skipped", crawlDelayMs: null };

  const diagnostics: DiscoveryDiagnostics = {
    collections: [],
    sitemap: { urls: 0, lastmod: 0 },
    htmlCrawl: { urls: 0, pagesVisited: 0, truncated: false },
    platform: {
      platform: "Unknown",
      signal: "Not detected",
      kind: "unknown",
    },
    robots: robotsInfo,
    findings,
    log,
  };

  /** Emits a live progress tick with the current phase + step text. */
  const tick = (phase: DiscoveryProgress["phase"], step?: string) => {
    config.onDiscoveryProgress?.({
      phase,
      urlsFound: urlSet.size,
      sitemapUrls: diagnostics.sitemap.urls,
      htmlUrls: diagnostics.htmlCrawl.urls,
      htmlPagesVisited: diagnostics.htmlCrawl.pagesVisited,
      collectionHandles: diagnostics.collections.reduce(
        (n, c) => n + c.handles,
        0,
      ),
      platform: diagnostics.platform.platform,
      step,
      log: [...log],
    });
  };

  // ── 0. Platform detection + homepage analysis ────────────────────────
  let homepageHtml = "";
  try {
    const detection = await detectPlatform(config.origin, opts, robots?.body);
    homepageHtml = detection.homepageHtml;
    diagnostics.platform = {
      platform: detection.platform,
      signal: detection.signal,
      kind: detection.kind,
      cms: detection.cms,
      builder: detection.builder,
      seoPlugin: detection.seoPlugin,
      server: detection.server,
      generator: detection.generator,
    };
    log.push(
      `Platform: ${detection.platform} (${detection.kind}) — ${detection.signal}`,
    );
    if (detection.builder) log.push(`Built with ${detection.builder}`);
    if (detection.seoPlugin) log.push(`SEO plugin: ${detection.seoPlugin}`);
    if (detection.server) log.push(`Server stack: ${detection.server}`);
  } catch (error) {
    diagnostics.platform = {
      platform: "Unknown",
      signal: `Detection failed: ${String(error)}`,
      kind: "unknown",
    };
  }
  tick("sitemap", "Detecting platform and analyzing the homepage…");

  if (homepageHtml) {
    const home = analyzeHomepage(homepageHtml, config.origin);
    diagnostics.homepage = {
      productLinks: home.productLinks,
      categoryLinks: home.categoryLinks,
      looksLikeStore: home.looksLikeStore,
      externalStoreLinks: home.externalStoreLinks,
      note: home.note,
    };
    log.push(home.note);
    // Homepage evidence refines the platform kind: a corporate-looking site
    // whose homepage links to product pages is a store after all, and a
    // platform that looked like a store but shows no product links is
    // reported honestly as corporate/unknown. Only downgrade from a hard
    // robots-based store signal when the homepage clearly contradicts it.
    if (home.looksLikeStore && diagnostics.platform.kind !== "store") {
      diagnostics.platform = {
        ...diagnostics.platform,
        kind: "store",
      };
    } else if (!home.looksLikeStore && home.productLinks === 0) {
      diagnostics.platform = {
        ...diagnostics.platform,
        kind: diagnostics.platform.kind === "store" ? "unknown" : "corporate",
      };
    }
    if (home.looksLikeStore) {
      findings.push({
        level: "success",
        message: `The homepage links to ${home.productLinks} product pages — this is a store.`,
      });
    } else if (home.externalStoreLinks.length > 0) {
      findings.push({
        level: "info",
        message:
          "This looks like a corporate site. It links out to a store — crawl that domain instead.",
        action: {
          label: `Crawl ${home.externalStoreLinks[0].host}`,
          url: home.externalStoreLinks[0].url,
        },
      });
      log.push(
        `External store link found: ${home.externalStoreLinks[0].host}${home.externalStoreLinks[0].label ? ` ("${home.externalStoreLinks[0].label}")` : ""}`,
      );
    } else {
      findings.push({
        level: "warning",
        message:
          "No product links on the homepage — this site may not sell products directly.",
      });
    }
  }
  tick("sitemap", "Homepage analyzed.");

  // ── 1. Shopify collection handles → product URLs. ────────────────────
  if (config.collections?.length) {
    for (const collection of config.collections) {
      try {
        log.push(`Walking collection "${collection}"…`);
        const handles = await discoverCollectionHandles(
          config.origin,
          collection,
          opts,
        );
        for (const h of handles) {
          urlSet.add(`${config.origin}/products/${h}`);
        }
        diagnostics.collections.push({ collection, handles: handles.length });
        log.push(`Collection "${collection}": ${handles.length} products`);
      } catch (error) {
        diagnostics.collections.push({
          collection,
          handles: 0,
          error: String(error),
        });
        log.push(`Collection "${collection}" failed: ${String(error)}`);
      }
      tick("collections", `Collection "${collection}" done.`);
    }
  }

  // ── 2. Sitemap candidates — robots.txt first, then /sitemap.xml, /sitemap_index.xml ──
  const candidates = sitemapCandidates(config.origin, robots?.body);
  const candidateResults: SitemapCandidateResult[] = [];
  let sitemapAdded = 0;
  let lastmodCount = 0;
  let sitemapError: string | undefined;

  for (const candidate of candidates) {
    const result = await fetchSitemapCandidate(candidate, opts);
    candidateResults.push(result);
    if (result.status === "html") {
      log.push(
        `${candidate.url} answered with HTML (likely a redirect) — trying the next sitemap location.`,
      );
      continue;
    }
    if (result.status === "error") {
      log.push(`${candidate.url} failed: ${result.error}`);
      sitemapError = sitemapError ?? result.error;
      continue;
    }
    log.push(`${candidate.url} — ${result.urls} URLs total.`);
    try {
      const sitemapUrls = result.entries ?? [];
      // Product-only mode (default) skips blog/help/policy pages; off means
      // every sitemap URL is crawled (non-product pages usually fail parse).
      // Known product sitemaps (WordPress `wp-sitemap-posts-product-*`, Rank
      // Math `product-sitemap.xml`) are trusted wholesale — their URLs are
      // products even when the URL pattern looks nothing like `/product/`
      // (e.g. WooCommerce `/shop/<cat>/<slug>/` permalinks).
      const entries =
        config.productOnly === false || result.isProductSitemap
          ? sitemapUrls
          : filterProductSitemapEntries(sitemapUrls);
      result.productUrls = entries.length;
      for (const u of entries) {
        if (!urlSet.has(u.loc)) sitemapAdded++;
        urlSet.add(u.loc);
        if (u.lastmod) {
          lastmod.set(u.loc, u.lastmod);
          lastmodCount++;
        }
      }
      log.push(
        `${candidate.url} — ${result.productUrls} product URLs${result.productUrls === 0 ? " (no product pages in this sitemap)" : ""}.`,
      );
      if (result.productUrls > 0) break;
    } catch (error) {
      result.status = "error";
      result.error = String(error);
      sitemapError = sitemapError ?? result.error;
    }
    config.onDiscoveryProgress?.({
      phase: "sitemap",
      urlsFound: urlSet.size,
      sitemapUrls: sitemapAdded,
      htmlUrls: 0,
      htmlPagesVisited: 0,
      collectionHandles: diagnostics.collections.reduce(
        (n, c) => n + c.handles,
        0,
      ),
      step: `Reading ${candidate.url}`,
      log: [...log],
    });
  }

  diagnostics.sitemap = {
    urls: sitemapAdded,
    lastmod: lastmodCount,
    ...(sitemapError ? { error: sitemapError } : {}),
    candidates: candidateResults,
  };
  if (candidateResults.length === 0) {
    log.push("No sitemap locations to try.");
  } else if (sitemapAdded === 0) {
    findings.push({
      level: "warning",
      message:
        "No product URLs from sitemaps. If the sitemap redirected to the homepage, the crawler tried the robots.txt-declared and standard locations first.",
    });
  }
  tick("sitemap", "Sitemap discovery done.");

  // ── 3. HTML link-graph BFS from the site root. ───────────────────────
  try {
    log.push("HTML crawl: following category and product links from the root…");
    const html = await discoverByHtmlCrawl(config.origin, opts, {
      maxPages: DISCOVERY_MAX_PAGES,
      maxDepth: DISCOVERY_MAX_DEPTH,
      onPageVisited: (pagesVisited, productsFound) => {
        config.onDiscoveryProgress?.({
          phase: "htmlCrawl",
          urlsFound: urlSet.size + productsFound,
          sitemapUrls: diagnostics.sitemap.urls,
          htmlUrls: productsFound,
          htmlPagesVisited: pagesVisited,
          collectionHandles: diagnostics.collections.reduce(
            (n, c) => n + c.handles,
            0,
          ),
          step: `Visited ${pagesVisited} pages, ${productsFound} product URLs so far`,
          log: [...log],
        });
      },
    });
    for (const u of html.productUrls) urlSet.add(u);
    diagnostics.htmlCrawl = {
      urls: html.productUrls.length,
      pagesVisited: html.pagesVisited,
      truncated: html.truncated,
    };
    log.push(
      `HTML crawl: ${html.pagesVisited} pages visited, ${html.productUrls.length} product URLs found${html.truncated ? " (capped)" : ""}.`,
    );
  } catch (error) {
    diagnostics.htmlCrawl.error = String(error);
    log.push(`HTML crawl failed: ${String(error)}`);
  }

  // ── Wrap-up ──────────────────────────────────────────────────────────
  if (urlSet.size === 0) {
    findings.push({
      level: "warning",
      message:
        "No products discovered. This site may not expose a crawlable catalogue.",
    });
  } else {
    findings.push({
      level: "success",
      message: `Discovered ${urlSet.size} product URLs.`,
    });
  }
  config.onDiscoveryProgress?.({
    phase: "done",
    urlsFound: urlSet.size,
    sitemapUrls: diagnostics.sitemap.urls,
    htmlUrls: diagnostics.htmlCrawl.urls,
    htmlPagesVisited: diagnostics.htmlCrawl.pagesVisited,
    collectionHandles: diagnostics.collections.reduce(
      (n, c) => n + c.handles,
      0,
    ),
    platform: diagnostics.platform.platform,
    step: "Discovery complete.",
    log: [...log],
  });

  return {
    urls: [...urlSet].filter((u) => !opts.isAllowed || opts.isAllowed(u)),
    lastmod,
    diagnostics,
  };
}

/**
 * Filters a sitemap's URL set down to product-page entries. Used only for
 * generic sitemaps whose post type is unknown — known product sitemaps skip
 * this and are trusted wholesale.
 */
function filterProductSitemapEntries(urls: DiscoveredUrl[]): DiscoveredUrl[] {
  return urls.filter(
    (u) =>
      /\/products?\/[a-z0-9_-]+/i.test(u.loc) ||
      /\/dp\/[a-z0-9_-]+/i.test(u.loc) ||
      /\/item\/[a-z0-9_-]+/i.test(u.loc) ||
      // WooCommerce product base `/shop/` with a category-prefixed permalink
      // (`/shop/<cat>/<product>/`) — two or more segments after /shop/.
      /\/shop\/[a-z0-9_-]+\/[a-z0-9_-]+/i.test(u.loc),
  );
}

export { httpOptions };
export type { HttpOptions };
