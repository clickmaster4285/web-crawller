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

import {
  discoverBigCommerceProducts,
  probeBigCommerceApi,
} from "../adapters/bigcommerce.ts";
import { discoverCollectionHandles } from "../adapters/shopify-discover.ts";
import {
  discoverWooCommerceProducts,
  probeWooCommerceApi,
} from "../adapters/woocommerce.ts";
import { discoverByHtmlCrawl } from "./html-crawl.ts";
import { checkCancelled, waitForControl } from "../core/control.ts";
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

/**
 * Top-level path segments that are never product pages — blog/legal/account
 * sections and archive bases (`shop`, `product-category`, `tag`…) whose
 * children are lists, not products. Used by the flat `<category>/<slug>`
 * rule so it doesn't classify `/blog/<post>` or `/shop/<category>` as
 * products.
 */
const NON_PRODUCT_SECTION_RE =
  /^(blog|news|about|about-us|contact|help|faq|faqs|help-center|support|policy|privacy|terms|terms-and-conditions|shipping|shipping-details|returns|return-policy|payment|payment-options|warranty|warranty-returns|careers|account|cart|wishlist|login|register|search|page|pages|tag|tags|category|categories|author|authors|archives|shop|product-category|collections|catalog|catalogue|brand|brands|manufacturer|vendor|articles|posts|guides|tutorials|reviews|resources|events|team|services|solutions|downloads|docs|documentation|knowledge-base)$/i;

/** Lowercased path segments of a URL (`/computing/dell-x` → ["computing", "dell-x"]). */
function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname
      .split("/")
      .filter(Boolean)
      .map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

export interface ProductDiscovery {
  /** Absolute product page URLs, deduped. */
  urls: string[];
  /** URLs that the sitemap paired with a lastmod value. */
  lastmod: Map<string, string>;
  /**
   * URL → product id from the BigCommerce Storefront API walk (when the API
   * was public), so the fetch loop can pull structured JSON by id for exactly
   * the URLs discovery found. Empty for every other platform.
   */
  productIds: Map<string, number>;
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
  const shallow = config.mode === "shallow";
  const urlSet = new Set<string>();
  const lastmod = new Map<string, string>();
  const productIds = new Map<string, number>();
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

  // Cooperative control: a cancel lands even during the platform-detection
  // / homepage step (single requests, checked before and after the block).
  checkCancelled(config.control);

  // ── 0. Platform detection + homepage analysis ────────────────────────
  // Skipped entirely in shallow mode: a sitemap-only check must cost ~1
  // request, and detection/homepage analysis would add 2+ more. The
  // diagnostics honestly report "Unknown" with a note in the log.
  let homepageHtml = "";
  if (shallow) {
    log.push(
      "Shallow check: skipping platform detection and homepage analysis to keep the request count at ~1.",
    );
  } else {
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
  } // end non-shallow platform/homepage block

  // ── 1. Shopify collection handles → product URLs. ────────────────────
  // Shallow checks are sitemap-only — collection walks add requests per page.
  if (!shallow && config.collections?.length) {
    for (const collection of config.collections) {
      await waitForControl(config.control);
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
    await waitForControl(config.control);
    const result = await fetchSitemapCandidate(candidate, opts, config.control);
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

  // ── 2.5 WooCommerce native REST API (Tier 3). ────────────────────────
  // For stores that are (or could be) WooCommerce, probe /wp-json/wc/v3.
  // A public API is the highest-fidelity product source — walk it for URLs
  // and let the fetch loop parse structured JSON (SKU/GTIN/stock) instead
  // of HTML. Auth-required APIs are the common case (consumer-key only);
  // that's recorded honestly and the crawl continues via sitemap/HTML.
  // Skipped in shallow mode (platform detection is skipped too, so the
  // platform would read "Unknown" — and probes would cost extra requests).
  if (
    !shallow &&
    (diagnostics.platform.platform === "WooCommerce" ||
      diagnostics.platform.platform === "WordPress")
  ) {
    log.push("WooCommerce API: probing /wp-json/wc/v3/products…");
    const probe = await probeWooCommerceApi(config.origin, opts);
    if (probe.status === "public") {
      const woo = await discoverWooCommerceProducts(
        config.origin,
        opts,
        undefined,
        config.control,
      );
      let wooAdded = 0;
      for (const u of woo.urls) {
        if (!urlSet.has(u)) wooAdded++;
        urlSet.add(u);
      }
      diagnostics.wooCommerce = {
        status: "public",
        total: woo.total ?? probe.total,
        urls: wooAdded,
      };
      log.push(
        `WooCommerce API: ${woo.urls.length} products ` +
          `(${woo.truncated ? "capped" : `${woo.total ?? "?"} total`}) — ` +
          `${wooAdded} new URLs`,
      );
      findings.push({
        level: "success",
        message: `WooCommerce REST API is public — ${woo.urls.length} products found via /wp-json/wc/v3.`,
      });
    } else if (probe.status === "auth-required") {
      diagnostics.wooCommerce = {
        status: "auth-required",
        total: null,
        urls: 0,
        message: probe.message,
      };
      log.push(
        `WooCommerce API requires credentials (${probe.message}) — continuing with sitemap/HTML.`,
      );
      findings.push({
        level: "info",
        message:
          "WooCommerce REST API needs consumer credentials — products come from sitemap/HTML instead.",
      });
    } else {
      diagnostics.wooCommerce = {
        status: "unavailable",
        total: null,
        urls: 0,
        message: probe.message,
      };
      log.push(
        `WooCommerce API unavailable (${probe.message}) — continuing with sitemap/HTML.`,
      );
    }
    tick("sitemap", "WooCommerce API probe done.");
  }

  // ── 2.6 BigCommerce Storefront API (Tier 3). ────────────────────────
  // For stores detected as BigCommerce, probe /api/storefront/catalog/products.
  // A public API is the highest-fidelity product source — walk it for URLs
  // (remembering URL → id so the fetch loop pulls structured JSON) and record
  // the outcome honestly when the API is unavailable or credential-gated.
  // Skipped in shallow mode (see WooCommerce above).
  if (!shallow && diagnostics.platform.platform === "BigCommerce") {
    log.push("BigCommerce API: probing /api/storefront/catalog/products…");
    const probe = await probeBigCommerceApi(config.origin, opts);
    if (probe.status === "public") {
      const bc = await discoverBigCommerceProducts(
        config.origin,
        opts,
        undefined,
        config.control,
      );
      let bcAdded = 0;
      for (const u of bc.urls) {
        if (!urlSet.has(u)) bcAdded++;
        urlSet.add(u);
      }
      for (const [u, id] of bc.byUrl) productIds.set(u, id);
      diagnostics.bigCommerce = {
        status: "public",
        total: bc.total ?? probe.total,
        urls: bcAdded,
      };
      log.push(
        `BigCommerce API: ${bc.urls.length} products ` +
          `(${bc.truncated ? "capped" : `${bc.total ?? "?"} total`}) — ` +
          `${bcAdded} new URLs`,
      );
      findings.push({
        level: "success",
        message: `BigCommerce Storefront API is public — ${bc.urls.length} products found via /api/storefront/catalog/products.`,
      });
    } else if (probe.status === "auth-required") {
      diagnostics.bigCommerce = {
        status: "auth-required",
        total: null,
        urls: 0,
        message: probe.message,
      };
      log.push(
        `BigCommerce API requires credentials (${probe.message}) — continuing with sitemap/HTML.`,
      );
      findings.push({
        level: "info",
        message:
          "BigCommerce Storefront API needs credentials — products come from sitemap/HTML instead.",
      });
    } else {
      diagnostics.bigCommerce = {
        status: "unavailable",
        total: null,
        urls: 0,
        message: probe.message,
      };
      log.push(
        `BigCommerce API unavailable (${probe.message}) — continuing with sitemap/HTML.`,
      );
    }
    tick("sitemap", "BigCommerce API probe done.");
  }

  // ── 3. HTML link-graph BFS from the site root. ───────────────────────
  // Shallow mode never BFS-crawls the site — the sitemap is the catalogue.
  if (shallow) {
    log.push(
      "Shallow check: skipping the HTML link-graph crawl — sitemap only.",
    );
  } else {
    try {
      log.push(
        "HTML crawl: following category and product links from the root…",
      );
      const html = await discoverByHtmlCrawl(config.origin, opts, {
        maxPages: DISCOVERY_MAX_PAGES,
        maxDepth: DISCOVERY_MAX_DEPTH,
        control: config.control,
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
  } // end non-shallow html-crawl block

  // ── 3.5 Shallow filter: keep only URLs the store doesn't already sell. ──
  // The worker passes the Product collection's URLs as `knownUrls`, so a
  // shallow check (sitemap-only) returns exactly the NEW products — the
  // fetch loop below downloads only those pages, never the whole catalogue.
  if (shallow && config.knownUrls && config.knownUrls.size > 0) {
    const before = urlSet.size;
    for (const u of [...urlSet]) {
      if (config.knownUrls.has(u)) urlSet.delete(u);
    }
    log.push(
      `Shallow check: ${before} sitemap URLs, ${before - urlSet.size} already known, ${urlSet.size} new.`,
    );
  }

  // ── Wrap-up ──────────────────────────────────────────────────────────
  if (urlSet.size === 0) {
    // Shallow: "no NEW products" is only a success when a sitemap actually
    // resolved and the only reason there's nothing to fetch is that every
    // URL was already known. A missing/errored/empty sitemap discovered
    // NOTHING — that's a warning (the "No product URLs from sitemaps"
    // finding above already fires in that case), not a clean bill of health.
    findings.push(
      shallow && diagnostics.sitemap.urls > 0
        ? {
            level: "success",
            message:
              "No new products since the last crawl — nothing to fetch (≈1 request).",
          }
        : {
            level: "warning",
            message: shallow
              ? "Shallow check found no sitemap product URLs — nothing to compare against."
              : "No products discovered. This site may not expose a crawlable catalogue.",
          },
    );
  } else {
    findings.push({
      level: "success",
      message: shallow
        ? `Shallow check found ${urlSet.size} new product(s) to fetch.`
        : `Discovered ${urlSet.size} product URLs.`,
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
    productIds,
    diagnostics,
  };
}

/**
 * Filters a sitemap's URL set down to product-page entries. Used only for
 * generic sitemaps whose post type is unknown — known product sitemaps skip
 * this and are trusted wholesale.
 *
 * Recognized product patterns:
 *   - `/products/<slug>` (Shopify, BigCommerce, most stores)
 *   - `/dp/<id>`, `/item/<slug>` (Amazon-style)
 *   - WooCommerce `/shop/<cat>/<product>/` (category-prefixed permalinks)
 *   - **Flat `<category>/<slug>` / nested tree taxonomies** (e.g.
 *     techmen.com.pk's `/computing/dell-latitude-7300-…` or
 *     `/apple-products/accessories/macbook/<slug>`): a URL whose first
 *     segment is a standalone section page in this sitemap, is not a known
 *     non-product section (blog/legal/account/archive bases), and is a
 *     **leaf** of the sitemap tree — nothing nests under it. The sitemap
 *     cross-reference plus blocklist keeps `/blog/<post>`, static pages and
 *     `/shop/<cat>` archives out while trusting real category→product
 *     trees wholesale.
 *
 * Known tradeoffs (deliberate): products are only trusted when their
 * section page is itself listed in the sitemap (coverage gap when category
 * pages aren't); and on non-store sites with unblocklisted top-level
 * sections (e.g. a blog's `/deals/…`), content leaves are accepted and fail
 * extraction cleanly — recorded as failures, never corrupting the catalogue.
 */
export function filterProductSitemapEntries(
  urls: DiscoveredUrl[],
): DiscoveredUrl[] {
  // Path segments per URL, computed once (the filter reads each twice).
  const segments = new Map<string, string[]>();
  // First segments that appear as standalone URLs — real section/category
  // pages, so deeper children can be trusted as products.
  const sections = new Set<string>();
  // Every URL that is a strict prefix of another URL — a section page, not
  // a product (techmen.com.pk nests products several levels deep:
  // `/apple-products/accessories/macbook/<slug>`, so `…/macbook` with
  // children must not be treated as a product itself).
  const prefixes = new Set<string>();
  for (const u of urls) {
    const seg = pathSegments(u.loc);
    segments.set(u.loc, seg);
    if (seg.length === 1) sections.add(seg[0]);
    for (let i = 1; i < seg.length; i++) {
      prefixes.add(`/${seg.slice(0, i).join("/")}`);
    }
  }
  return urls.filter((u) => {
    if (
      /\/products?\/[a-z0-9_-]+/i.test(u.loc) ||
      /\/dp\/[a-z0-9_-]+/i.test(u.loc) ||
      /\/item\/[a-z0-9_-]+/i.test(u.loc) ||
      // WooCommerce product base `/shop/` with a category-prefixed permalink
      // (`/shop/<cat>/<product>/`) — two or more segments after /shop/.
      /\/shop\/[a-z0-9_-]+\/[a-z0-9_-]+/i.test(u.loc)
    ) {
      return true;
    }
    const seg = segments.get(u.loc) ?? [];
    return (
      seg.length >= 2 &&
      !NON_PRODUCT_SECTION_RE.test(seg[0]) &&
      sections.has(seg[0]) &&
      // Leaf: nothing nests under this URL in the sitemap.
      !prefixes.has(`/${seg.join("/")}`)
    );
  });
}

export { httpOptions };
export type { HttpOptions };
