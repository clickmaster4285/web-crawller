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
import {
  discoverCollectionHandles,
  discoverShopifyProducts,
  probeShopifyApi,
} from "../adapters/shopify-discover.ts";
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
  robotsSitemaps,
  sitemapCandidates,
  sitemapMatchesLocale,
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
// The non-product URL classifier — shared single source of truth with the
// backend ingest guard and the tools/ scripts (never duplicate this list).
import {
  PRODUCT_BASE_RE,
  hasJunkSegment,
  pathSegments,
} from "./junk-segments.ts";

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
        const shop = home.externalStoreLinks[0];
        findings.push({
          level: "info",
          message: `This looks like a corporate site — it publishes no prices here. It links out to ${shop.host}; crawl that domain instead, the prices live there.`,
          action: {
            label: `Crawl ${shop.host}`,
            url: shop.url,
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
  // `config.locale` (optional region token, P4 — GCC stores publish a
  // separate sitemap set per country: activefitness `/om/sitemaps/…`,
  // lifetimefitness `sitemap_om.xml`) filters robots.txt-declared candidates
  // to the matching region, so a crawl walks ONE country's catalogue (~4×
  // less work, one currency) instead of every region. The default
  // `/sitemap.xml` + `/sitemap_index.xml` candidates are never filtered.
  const locale = config.locale?.trim() || undefined;
  const candidates = sitemapCandidates(config.origin, robots?.body, locale);
  const candidateResults: SitemapCandidateResult[] = [];
  let sitemapAdded = 0;
  let lastmodCount = 0;
  let sitemapError: string | undefined;
  // Whether the locale filter dropped ANY robots-declared sitemap (and how
  // many matched) — surfaced as a finding so a 0-product run explains
  // itself instead of reading as a broken crawl.
  let localeMatchedRobots = true;
  if (locale) {
    const robotsUrls = robotsSitemaps(robots?.body);
    const matched = robotsUrls.filter((u) => sitemapMatchesLocale(u, locale));
    localeMatchedRobots = matched.length > 0;
    const dropped = robotsUrls.length - matched.length;
    if (dropped > 0) {
      log.push(
        `Locale filter: keeping only "${locale}" sitemaps — ${dropped} other-region sitemap(s) skipped.`,
      );
    }
  }
  // Total URLs stripped by the junk-segment filter across all sitemap
  // candidates — surfaced as a finding after the loop (the live log line is
  // per-candidate and scrolls by; the finding is the persistent, prominent
  // count shown in "What the crawler found" / the store profile).
  let junkFilteredTotal = 0;

  for (const candidate of candidates) {
    await waitForControl(config.control);
    const result = await fetchSitemapCandidate(
      candidate,
      opts,
      config.control,
      locale,
    );
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
      //
      // Every source — trusted or not — is first stripped of unambiguous
      // junk segments at ANY path depth (blog/legal/collection pages). The
      // first-segment-only blocklist below can't see them behind a locale
      // prefix (`/uae-en/privacy-policy`, `/uae-en/blog/…`), and even a
      // "product sitemap" can list such pages (urbanfitnesscart.com: 5,477
      // of 5,508 sitemap URLs passed the old filter, including ~390 junk).
      const cleaned = sitemapUrls.filter((u) => !hasJunkSegment(u.loc));
      if (cleaned.length < sitemapUrls.length) {
        const dropped = sitemapUrls.length - cleaned.length;
        junkFilteredTotal += dropped;
        log.push(
          `Junk-segment filter: ${dropped} URLs dropped (blog/policy/collection pages) — ${cleaned.length} kept.`,
        );
      }
      const entries =
        config.productOnly === false || result.isProductSitemap
          ? cleaned
          : filterProductSitemapEntries(cleaned);
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
  // The locale filter matched NONE of the store's robots-declared sitemaps
  // (it may not publish per-country sitemaps, or uses a token this region
  // isn't). The default candidates still run — but a 0-product result then
  // means the filter is the likely reason, so say so up front.
  if (locale && !localeMatchedRobots) {
    findings.push({
      level: "warning",
      message: `Region "${locale}" matched none of this store's sitemaps — crawling the default locations instead (which may redirect or list every region).`,
    });
  }
  if (candidateResults.length === 0) {
    log.push("No sitemap locations to try.");
  } else if (sitemapAdded === 0) {
    findings.push({
      level: "warning",
      message:
        "No product URLs from sitemaps. If the sitemap redirected to the homepage, the crawler tried the robots.txt-declared and standard locations first.",
    });
  }
  // Prominent junk-filter count (mirrors the productUrlPattern finding):
  // how many blog/policy/collection pages the junk-segment filter stripped
  // from the sitemap before crawling, so a run that discovered 5,117 of
  // 5,508 URLs explains itself instead of quietly fetching fewer.
  if (junkFilteredTotal > 0) {
    findings.push({
      level: "info",
      message: `Junk-segment filter: ${junkFilteredTotal.toLocaleString()} blog/policy/collection pages filtered out of the sitemap — only product pages were crawled.`,
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

  // ── 2.7 Shopify public products.json (Tier 3). ───────────────────────
  // The per-product Shopify JSON probe (`/products/{handle}.json`) already
  // lives in the fetch loop — this block gives discovery the URL SET it needs
  // when the sitemap can't (blocked, missing, or junk-heavy). Any store that
  // could be Shopify is probed with one polite request; a public catalogue is
  // walked and its product URLs added to the set. This is the escape hatch
  // for the WAF-blocked-sitemap class (athletix.ae: `/sitemap.xml` 429'd
  // while `/products.json?limit=250` paged cleanly — the shop crawled to
  // zero while its full catalogue sat behind a public API). Skipped in
  // shallow mode (platform detection is skipped too, and probes cost
  // requests a 1-request check must not make).
  //
  // Gating mirrors the analyzer's `looksShopify` rule: detection says
  // Shopify, detection is unknown/plain (products.json is a cheap universal
  // Shopify sniff), or the homepage carries cdn.shopify.com assets (the
  // fingerprint that survives a robots-based misdetection — Shopify's
  // default robots.txt lists bare /cart + /checkout, which the WooCommerce
  // heuristic used to match first).
  if (!shallow) {
    const platformName = diagnostics.platform.platform.toLowerCase();
    const looksShopify =
      homepageHtml.includes("cdn.shopify.com") ||
      platformName === "shopify" ||
      platformName === "unknown" ||
      platformName === "plain";
    if (looksShopify) {
      log.push("Shopify API: probing /products.json…");
      const probe = await probeShopifyApi(config.origin, opts);
      if (probe.status === "public") {
        const shopify = await discoverShopifyProducts(
          config.origin,
          opts,
          config.control,
        );
        let shopifyAdded = 0;
        for (const u of shopify.urls) {
          if (!urlSet.has(u)) shopifyAdded++;
          urlSet.add(u);
        }
        diagnostics.shopifyApi = {
          status: "public",
          urls: shopifyAdded,
        };
        log.push(
          `Shopify API: ${shopify.urls.length} products ` +
            `(${shopify.truncated ? "capped" : "full catalogue"}) — ` +
            `${shopifyAdded} new URLs`,
        );
        findings.push({
          level: "success",
          message: `Shopify products.json is public — ${shopify.urls.length} products found via /products.json.`,
        });
      } else if (probe.status === "auth-required") {
        diagnostics.shopifyApi = {
          status: "auth-required",
          urls: 0,
          message: probe.message,
        };
        log.push(
          `Shopify API requires credentials (${probe.message}) — continuing with sitemap/HTML.`,
        );
      } else {
        diagnostics.shopifyApi = {
          status: "unavailable",
          urls: 0,
          message: probe.message,
        };
        log.push(
          `Shopify API unavailable (${probe.message}) — continuing with sitemap/HTML.`,
        );
      }
      tick("sitemap", "Shopify API probe done.");
    }
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

  // ── 3.6 Product URL pattern filter ──────────────────────────────────
  // Optional per-crawl regex (config.productUrlPattern): when set, only
  // discovered URLs matching it are kept. This is the escape hatch for
  // stores whose sitemap mixes real product URLs with blog/brand/category
  // pages under the SAME path tree — the flat-taxonomy heuristic can't tell
  // a blog post from a product there (activefitnessstore.com: product URLs
  // end in an EAN/SKU `…-bs-4067898979432` / `…-tf-1575` while blog posts
  // end in a word `…/10-ramadan-health-and-fitness-tips`). An invalid regex
  // is ignored with a warning — the crawl proceeds unfiltered.
  if (config.productUrlPattern) {
    let pattern: RegExp | null = null;
    try {
      pattern = new RegExp(config.productUrlPattern, "i");
    } catch {
      findings.push({
        level: "warning",
        message: `Product URL pattern "${config.productUrlPattern}" is not a valid regex — crawled every discovered URL.`,
      });
      log.push(
        `Product URL pattern ignored (invalid regex): ${config.productUrlPattern}`,
      );
    }
    if (pattern) {
      const before = urlSet.size;
      for (const u of [...urlSet]) {
        if (!pattern.test(u)) urlSet.delete(u);
      }
      log.push(
        `Product URL pattern filter: ${before} URLs, kept ${urlSet.size} matching "${config.productUrlPattern}".`,
      );
      if (before - urlSet.size > 0) {
        findings.push({
          level: "info",
          message: `Product URL pattern kept ${urlSet.size} of ${before} discovered URLs (${before - urlSet.size} filtered out).`,
        });
      }
    }
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
  let productBaseCount = 0;
  for (const u of urls) {
    const seg = pathSegments(u.loc);
    segments.set(u.loc, seg);
    if (seg.length === 1) sections.add(seg[0]);
    for (let i = 1; i < seg.length; i++) {
      prefixes.add(`/${seg.slice(0, i).join("/")}`);
    }
    if (PRODUCT_BASE_RE.test(u.loc)) productBaseCount++;
  }
  // When a store keeps the bulk of its catalogue under an explicit
  // `/product(s)/` base, the base IS the catalogue: blog/legal/collection
  // pages that slipped into a mixed sitemap (locale-prefixed stores —
  // urbanfitnesscart.com mixes 5,117 `/uae-en/product/` URLs with ~390 junk
  // pages) must not ride along. Require a firm 60%+ majority so a store that
  // ALSO sells real products at flat URLs (`/category/<product>`, verified
  // landing-page-free) doesn't lose them — a 50/50 split must never drop
  // half the catalogue. Known tradeoff (accepted for urbanfitness, 93%
  // base): a base-dominant store's flat URLs are landing pages, not products.
  const baseDominant =
    productBaseCount > 0 && productBaseCount > urls.length * 0.6;
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
    // GCC retailer SEO landing pages — per-product-type × city slugs ending
    // in "-in-<place>" (treadmills-in-al-qusais, yoga-strap-in-abu-dhabi).
    // These are category×location pages, NOT products: a whole sitemap can be
    // built from them (lifetimefitnessstore — 37,264 of its 39,427 classified
    // URLs were landing pages that extracted nothing; the crawl burned ~14k
    // requests fetching them). The explicit product-base patterns above
    // always win; this guards only the heuristic flat rule. Aug 2026.
    if (/-in-[a-z0-9-]+$/i.test(seg[seg.length - 1] ?? "")) {
      return false;
    }
    // Non-base URL in a base-dominant sitemap = junk (blog/category page).
    if (baseDominant) return false;
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
