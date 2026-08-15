/**
 * P2 — Website Intelligence Analyzer.
 *
 * Answers "how is this site built, and what's the optimal way to crawl it?"
 * in a handful of polite requests and ~10 seconds, BEFORE a crawl starts.
 * The engine already executes the strategy order (API → sitemap → HTML →
 * browser render); the analyzer says it out loud so a store like
 * activefitness (JS shell + OMR) is understood in 10 seconds instead of
 * after a 20-minute failed crawl.
 *
 * Every probe REUSES an existing crawler function — this module adds zero
 * new network behaviour and zero changes to existing crawler code:
 *
 *   1. Platform + store-vs-corporate → `detectPlatform()` (robots.txt body
 *      + one homepage fetch) + `analyzeHomepage()`.
 *   2. Shopify products.json + GraphQL → fetch conventions + the
 *      `probeWooCommerceApi` 3-state outcome shape.
 *   3. JSON-LD presence → `extractJsonLdBlocks()` + `findProductNode()`.
 *   4. Bot protection → `fetchWithRetry()` + a header classifier
 *      (cf-ray/cloudflare, akamai-*, 429+retry-after, x-vercel CDN).
 *   5. Render mode → `needsBrowserRender()` (the SSR-vs-CSR-shell
 *      classifier from the Aug 2026 fix) + a framework marker classifier.
 *
 * Plus three signals that are free on every crawl: sitemap presence +
 * product ratio (`sitemapCandidates`/`fetchSitemapCandidate` +
 * `filterProductSitemapEntries`), robots status (`Politeness.load`) and the
 * homepage store-link analysis (`analyzeHomepage`).
 *
 * Phase 1 form factor: `tools/analyze.mjs` (Node 24 type-stripping, same
 * mechanism as the worker). Phase 2: the Sources store-profile UI.
 */

import { detectPlatform } from "./discover/platform.ts";
import { analyzeHomepage } from "./discover/homepage.ts";
import {
  fetchSitemapCandidate,
  sitemapCandidates,
} from "./discover/sitemap.ts";
import { filterProductSitemapEntries } from "./discover/index.ts";
import { hasJunkSegment } from "./discover/junk-segments.ts";
import { Politeness } from "./core/politeness.ts";
import {
  closeProxyAgent,
  fetchText,
  fetchWithRetry,
  needsBrowserRender,
  resolveUserAgent,
  type HttpOptions,
} from "./core/http.ts";
import { extractJsonLdBlocks, findProductNode } from "./extract/jsonld.ts";
import { probeWooCommerceApi } from "./adapters/woocommerce.ts";
import { probeBigCommerceApi } from "./adapters/bigcommerce.ts";
import { probeShopifyApi } from "./adapters/shopify-discover.ts";
import { isCrawlCancelled, type CrawlControl } from "./core/control.ts";
import type { RobotsStatus } from "./core/types.ts";

/** Outcome state of an API probe — mirrors the WooCommerce probe's 3 states. */
export type ApiProbeState = "public" | "auth-required" | "unavailable";

/** Bot-protection provider, when one can be identified from response headers. */
export type ProtectionProvider =
  "cloudflare" | "akamai" | "rate-limited" | "none" | "unknown";

/** How the page content reaches the browser. */
export type RenderVerdict = "ssr" | "csr-shell" | "ssg" | "unknown";

/** Client framework identified from HTML markers. */
export type Framework = "next" | "nuxt" | "gatsby" | "plain" | "unknown";

/** The recommended crawl strategy (mirrors how the engine already behaves). */
export type RecommendationTier =
  "API-first" | "sitemap-HTTP" | "sitemap-browser" | "HTML-BFS" | "manual";

/** What the analyzer learned about one website. */
export interface WebsiteProfile {
  origin: string;
  analyzedAt: string;
  /** Number of HTTP requests the probes made (polite, throttled). */
  requests: number;
  platform: {
    name: string;
    kind: "store" | "corporate" | "unknown";
    signal: string;
  };
  /** Server stack from response headers (e.g. "Apache · PHP 8.2.33"). */
  server: string | null;
  api: {
    shopifyProductsJson: ApiProbeState;
    graphql: ApiProbeState;
    wooCommerce: ApiProbeState;
    bigCommerce: ApiProbeState;
  };
  jsonLd: {
    blocks: number;
    productOnHomepage: boolean;
    productOnProductPage: boolean;
    hasPrice: boolean;
  };
  protection: {
    provider: ProtectionProvider;
    /** True when the WAF actually blocks automated requests (challenge/429). */
    blocking: boolean;
    evidence: string;
  };
  rendering: {
    verdict: RenderVerdict;
    framework: Framework;
  };
  sitemap: {
    found: boolean;
    urls: number;
    productSitemap: boolean;
    source: string | null;
    /** True when the walk was cut short by the request budget (not "no sitemap"). */
    budgetLimited: boolean;
  };
  robots: {
    status: RobotsStatus;
    crawlDelayMs: number | null;
  };
  homepage: {
    productLinks: number;
    looksLikeStore: boolean;
    note: string;
    /**
     * Out-links to other hosts that look like stores (max 5, deduped) — a
     * corporate site that links to its real shop (haier.com/pk →
     * haiermall.pk). "Crawl that domain instead — the prices live there."
     */
    externalStoreLinks: Array<{ url: string; host: string; label: string }>;
  };
  recommendation: {
    tier: RecommendationTier;
    notes: string[];
  };
}

export interface AnalyzeOptions {
  /** Polite delay between requests (ms). Default 750 — probes are gentle. */
  delayMs?: number;
  /** Custom User-Agent (defaults to the ParityBot UA). */
  userAgent?: string;
  /** Retries on 429/5xx (default 1 — a probe must fail fast, not hammer). */
  maxRetries?: number;
  /** Hard cap on the number of HTTP requests the analyzer may make. */
  requestBudget?: number;
  /** Tier 2 — residential proxy gateway URL (routes every probe request). */
  proxy?: string;
}

/** Normalizes a user-typed origin (adds https:// when scheme-less). */
function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return trimmed;
  }
}

// ── Pure classifiers (exported for tests / reuse) ────────────────────────

const FRAMEWORK_MARKERS: Array<[Framework, RegExp]> = [
  [
    "next",
    /__NEXT_DATA__|id=["']__next["']|\/_next\/|\/\.next\/|next\/static/i,
  ],
  ["nuxt", /__NUXT__|_nuxt\/|nuxt\.config|@nuxt/i],
  ["gatsby", /__gatsby|gatsby-|_gatsby|gatsby\.js/i],
];

/** Identifies the client framework from HTML markers (probe 5). */
export function classifyFramework(html: string): Framework {
  for (const [framework, re] of FRAMEWORK_MARKERS) {
    if (re.test(html)) return framework;
  }
  return "plain";
}

/** Combines `needsBrowserRender` with the framework marker (probe 5). */
export function classifyRendering(html: string): {
  verdict: RenderVerdict;
  framework: Framework;
} {
  const framework = classifyFramework(html);
  // The content-poor shell classifier from the Aug 2026 fix: when the raw
  // HTML is a bare mount + bundle with no price/link content, the page NEEDS
  // a browser render (the activefitness class). Everything else is readable
  // from the server HTML (ssr/ssg), no rendering cost.
  if (needsBrowserRender(html)) {
    return { verdict: "csr-shell", framework };
  }
  if (framework === "gatsby") return { verdict: "ssg", framework };
  if (framework !== "plain") return { verdict: "ssr", framework };
  // Plain HTML: if there's a script bundle at all, treat it as ssr unless it
  // renders client-side; without a bundle it's a static page (ssr by nature).
  return { verdict: "ssr", framework };
}

/**
 * Classifies bot protection from a homepage response (probe 4). The browser
 * challenge text ("Just a moment…") makes a Cloudflare CDN a *blocking* one —
 * a passive cf-ray CDN is not.
 */
export function classifyProtection(
  res: Response,
  html: string,
): { provider: ProtectionProvider; blocking: boolean; evidence: string } {
  const server = (res.headers.get("server") ?? "").toLowerCase();
  const cfRay = res.headers.get("cf-ray");
  const challenge =
    /just a moment|checking your browser|verify you are human|captcha|cf-chl/i.test(
      html.slice(0, 60_000),
    );
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    return {
      provider: "rate-limited",
      blocking: true,
      evidence: `HTTP 429${retryAfter ? ` (retry-after: ${retryAfter}s)` : ""}`,
    };
  }
  if (cfRay || server.includes("cloudflare")) {
    return {
      provider: "cloudflare",
      blocking: res.status >= 400 || challenge,
      evidence: challenge
        ? 'Cloudflare JS challenge ("Just a moment…")'
        : `Cloudflare CDN${res.status >= 400 ? ` · HTTP ${res.status}` : ""}`,
    };
  }
  const akamai = [
    "akamai-x-s",
    "akamai-x-stuck",
    "akamai-x-cache",
    "x-akamai-transformed",
  ].some((h) => res.headers.get(h));
  if (akamai || server.includes("akamai")) {
    return {
      provider: "akamai",
      blocking: res.status >= 400,
      evidence: `Akamai edge${res.status >= 400 ? ` · HTTP ${res.status}` : ""}`,
    };
  }
  if (res.headers.get("x-vercel-id") || res.headers.get("x-nf-request-id")) {
    return {
      provider: "none",
      blocking: false,
      evidence: "CDN (Vercel/Netlify) headers — no bot challenge",
    };
  }
  return {
    provider: "none",
    blocking: false,
    evidence: `no protection headers · HTTP ${res.status}`,
  };
}

/** True when a JSON-LD node (or its offers) carries a real price. */
function nodeHasPrice(node: Record<string, unknown>): boolean {
  const price = node["price"];
  if (typeof price === "number" && price > 0) return true;
  if (typeof price === "string") {
    const n = Number(price.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return true;
  }
  const offers = node["offers"];
  if (Array.isArray(offers)) {
    return offers.some(
      (o) =>
        o != null &&
        typeof o === "object" &&
        nodeHasPrice(o as Record<string, unknown>),
    );
  }
  if (offers != null && typeof offers === "object") {
    return nodeHasPrice(offers as Record<string, unknown>);
  }
  return false;
}

/** True when a JSON-LD document contains a priced Product node. */
function jsonLdHasPricedProduct(doc: unknown): boolean {
  const node = findProductNode(doc);
  return node != null && nodeHasPrice(node);
}

/**
 * Builds the recommendation from the probed profile. Mirrors the engine's
 * own strategy order (API → sitemap → HTML → browser) plus the WAF truth:
 *
 *   1. API-first — a public store API is the highest-fidelity source and
 *      sidesteps HTML extraction entirely (even behind a WAF).
 *   2. manual — a blocking WAF (challenge/429) needs a residential proxy +
 *      slower concurrency, or the store is skipped honestly.
 *   3. HTML-BFS — no usable sitemap → the link-graph crawl fallback.
 *   4. sitemap-browser — JS shell detected → crawl with `useBrowser: true`.
 *   5. sitemap-HTTP — content-rich pages + product sitemap → plain HTTP.
 */
export function recommend(
  p: Pick<
    WebsiteProfile,
    "api" | "protection" | "sitemap" | "rendering" | "platform"
  >,
): { tier: RecommendationTier; notes: string[] } {
  const notes: string[] = [];
  const apiPublic =
    p.api.shopifyProductsJson === "public" ||
    p.api.wooCommerce === "public" ||
    p.api.bigCommerce === "public";

  if (apiPublic) {
    notes.push(
      "Public store API detected — structured product JSON beats HTML extraction (full SKU/GTIN/stock, fewer requests).",
    );
    return { tier: "API-first", notes };
  }
  if (p.protection.blocking) {
    notes.push(
      `${p.protection.evidence} — this WAF blocks automated requests from this machine.`,
    );
    notes.push(
      "Use a Tier-2 residential proxy with reduced concurrency and a higher delay, or skip the store.",
    );
    return { tier: "manual", notes };
  }
  if (!p.sitemap.found || p.sitemap.urls === 0) {
    notes.push(
      "No usable sitemap — the engine falls back to the HTML link-graph BFS from the homepage.",
    );
    return { tier: "HTML-BFS", notes };
  }
  if (p.rendering.verdict === "csr-shell") {
    notes.push(
      "Pages are client-rendered shells — crawl with auto JS rendering ON (useBrowser: true) so prices can be extracted.",
    );
    return { tier: "sitemap-browser", notes };
  }
  notes.push(
    "Product sitemap + server-rendered content-rich pages — plain HTTP at full speed, no rendering cost.",
  );
  return { tier: "sitemap-HTTP", notes };
}

// ── The probes ───────────────────────────────────────────────────────────

/** Probe 2b — the Storefront GraphQL endpoint (token-gated by default). */
async function probeShopifyGraphql(
  origin: string,
  opts: HttpOptions,
): Promise<ApiProbeState> {
  const url = `${origin}/api/2024-01/graphql.json`;
  if (opts.isAllowed && !opts.isAllowed(url)) return "unavailable";
  try {
    const res = await fetchWithRetry(url, opts);
    if (res.status === 401 || res.status === 403) return "auth-required";
    if (res.ok) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = (await res.json().catch(() => null)) as {
          data?: unknown;
        } | null;
        return body && body.data != null ? "public" : "auth-required";
      }
    }
  } catch {
    // Network / rate-limit — unavailable.
  }
  return "unavailable";
} /** Sitemap probe — first usable candidate, product-filtered counts. */
async function probeSitemap(
  origin: string,
  opts: HttpOptions,
  robotsBody: string,
  control: CrawlControl & { budgetExhausted?: boolean },
): Promise<WebsiteProfile["sitemap"] & { firstProductUrl: string | null }> {
  for (const candidate of sitemapCandidates(origin, robotsBody)) {
    let result;
    try {
      result = await fetchSitemapCandidate(candidate, opts, control);
    } catch (error) {
      // Budget exhaustion inside the index walk — report "budget-limited",
      // never a silent "not found" (a huge index is a real store signal).
      if (isCrawlCancelled(error)) {
        return {
          found: false,
          urls: 0,
          productSitemap: false,
          source: candidate.url,
          firstProductUrl: null,
          budgetLimited: true,
        };
      }
      continue;
    }
    if (
      result.status !== "ok" ||
      !result.entries ||
      result.entries.length === 0
    ) {
      continue;
    }
    const cleaned = result.entries.filter((u) => !hasJunkSegment(u.loc));
    const productEntries = result.isProductSitemap
      ? cleaned
      : filterProductSitemapEntries(cleaned);
    const ratio =
      cleaned.length > 0 ? productEntries.length / cleaned.length : 0;
    return {
      found: true,
      urls: productEntries.length,
      productSitemap: result.isProductSitemap === true || ratio > 0.5,
      source: candidate.url,
      firstProductUrl: productEntries[0]?.loc ?? null,
      budgetLimited: false,
    };
  }
  return {
    found: false,
    urls: 0,
    productSitemap: false,
    source: null,
    firstProductUrl: null,
    budgetLimited: false,
  };
}

// ── The entry point ──────────────────────────────────────────────────────

/**
 * Runs the 5 probes against `origin` and returns the WebsiteProfile. Polite
 * by construction: one shared throttle + robots gate + a hard request budget.
 *
 * Tier 2 proxy cleanup: when the analysis ran through a residential proxy,
 * the gateway's keep-alive sockets are closed when the probes finish — the
 * analyzer runs in the long-lived API process (POST /api/analyze and the
 * analyze-first enqueue path), so an unclosed agent would leak across
 * requests. The crawl path closes it in runCrawl; the analyzer must match.
 */
export async function analyzeWebsite(
  origin: string,
  options: AnalyzeOptions = {},
): Promise<WebsiteProfile> {
  try {
    return await runProbes(origin, options);
  } finally {
    if (options.proxy) closeProxyAgent(options.proxy);
  }
}

/** The probe pipeline — wrapped by `analyzeWebsite` for proxy cleanup. */
async function runProbes(
  origin: string,
  options: AnalyzeOptions = {},
): Promise<WebsiteProfile> {
  const base = normalizeOrigin(origin);
  const budget = options.requestBudget ?? 20;
  const analyzedAt = new Date().toISOString();

  // Cooperative budget: flips to "cancel" when the request budget is spent.
  // The sitemap walk checks it between index children; everything else is a
  // single request that the onRequest hook counts first.
  const control: CrawlControl & { budgetExhausted?: boolean } = {
    action: null,
  };
  let requests = 0;
  const onRequest = () => {
    requests++;
    if (requests >= budget) {
      control.action = "cancel";
      control.budgetExhausted = true;
    }
  };

  // robots.txt + adaptive throttle + robots gate — one request, everything
  // below shares it (the analyzer is as polite as the crawler). The `"browser"`
  // sentinel resolves to the Chrome UA so a WAF that 403s ParityBot (dawlance)
  // can be analyzed the same way it would be crawled.
  const userAgent = resolveUserAgent(options.userAgent);
  const politeness = await Politeness.load(base, {
    userAgent,
    delayMs: options.delayMs ?? 750,
    proxy: options.proxy,
    onRequest,
  });

  const opts: HttpOptions = {
    delayMs: options.delayMs ?? 750,
    maxRetries: options.maxRetries ?? 1,
    userAgent,
    throttle: politeness,
    isAllowed: (url) => politeness.isUrlAllowed(url),
    proxy: options.proxy,
    onRequest,
  };

  // ── Probe 1: platform + store-vs-corporate (robots body is free) ──
  const detection = await detectPlatform(base, opts, politeness.robotsBody);
  const home = analyzeHomepage(detection.homepageHtml, base);
  const kind =
    home.looksLikeStore && detection.kind !== "store"
      ? "store"
      : detection.kind;

  // ── Probe 4: protection needs the homepage response HEADERS (detectPlatform
  //     only returns the body). One polite extra fetch for the header probe.
  //     Probes 3/5 keep detectPlatform's homepage HTML — the copy fetched
  //     BEFORE any WAF challenge could have been served. ──
  const homepageHtml = detection.homepageHtml;
  let protection: WebsiteProfile["protection"] = {
    provider: "unknown",
    blocking: false,
    evidence: "homepage fetch failed",
  };
  if (!control.budgetExhausted) {
    try {
      const res = await fetchWithRetry(`${base}/`, opts);
      const classified = classifyProtection(res, await res.text());
      protection = {
        provider: classified.provider,
        blocking: classified.blocking,
        evidence: classified.evidence,
      };
    } catch {
      // Keep the unknown fallback; robots status may still hint at a block.
    }
  }

  // ── Probe 5: render mode + framework (on the pre-challenge homepage HTML) ──
  const rendering = classifyRendering(homepageHtml);

  // ── Sitemap probe (free signal: robots body is already fetched) ──
  const sitemap = await probeSitemap(
    base,
    opts,
    politeness.robotsBody,
    control,
  );

  // ── Probe 2: API probes — Shopify for any store, Woo/BigCommerce only
  //     when the platform detection points that way (saves requests). ──
  let shopifyProductsJson: ApiProbeState = "unavailable";
  let graphql: ApiProbeState = "unavailable";
  let wooCommerce: ApiProbeState = "unavailable";
  let bigCommerce: ApiProbeState = "unavailable";
  const platformName = detection.platform.toLowerCase();

  if (!control.budgetExhausted) {
    // Probe Shopify when detection says Shopify, when the platform is
    // unknown (products.json is a cheap universal Shopify sniff), or when
    // the homepage carries cdn.shopify.com assets — the fingerprint survives
    // a robots-based misdetection (marshalfitness: Shopify's default
    // robots.txt has bare /cart + /checkout, which the WooCommerce heuristic
    // used to match first).
    const looksShopify =
      homepageHtml.includes("cdn.shopify.com") ||
      platformName === "shopify" ||
      platformName === "unknown" ||
      platformName === "plain";
    if (looksShopify) {
      shopifyProductsJson = (await probeShopifyApi(base, opts)).status;
      if (shopifyProductsJson !== "public" && !control.budgetExhausted) {
        graphql = await probeShopifyGraphql(base, opts);
      }
    }
    if (
      (platformName === "woocommerce" || platformName === "wordpress") &&
      !control.budgetExhausted
    ) {
      const probe = await probeWooCommerceApi(base, opts);
      wooCommerce = probe.status;
    }
    if (platformName === "bigcommerce" && !control.budgetExhausted) {
      const probe = await probeBigCommerceApi(base, opts);
      bigCommerce = probe.status;
    }
  }

  // ── Probe 3: JSON-LD on the homepage + one product page. ──
  const homepageBlocks = extractJsonLdBlocks(homepageHtml);
  const productOnHomepage = homepageBlocks.some(
    (b) => findProductNode(b) != null,
  );
  let productOnProductPage = false;
  let hasPrice = homepageBlocks.some(jsonLdHasPricedProduct);

  let productUrl = sitemap.firstProductUrl;
  // No sitemap product URL, but products.json is public — use its first
  // product as the JSON-LD sample page.
  if (
    !productUrl &&
    shopifyProductsJson === "public" &&
    !control.budgetExhausted
  ) {
    try {
      const res = await fetchWithRetry(`${base}/products.json?limit=1`, opts);
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          products?: Array<{ handle?: string }>;
        } | null;
        const first = body?.products?.[0];
        if (first?.handle) {
          productUrl = `${base}/products/${first.handle}`;
        }
      }
    } catch {
      // Non-fatal — report homepage JSON-LD only.
    }
  }

  let blocks = homepageBlocks.length;
  if (productUrl && !control.budgetExhausted) {
    try {
      const productHtml = await fetchText(productUrl, opts);
      blocks += extractJsonLdBlocks(productHtml).length;
      productOnProductPage = extractJsonLdBlocks(productHtml).some(
        (b) => findProductNode(b) != null,
      );
      if (!hasPrice) {
        hasPrice = extractJsonLdBlocks(productHtml).some(
          jsonLdHasPricedProduct,
        );
      }
    } catch {
      // Product page unreachable — homepage JSON-LD is the answer.
    }
  }

  const profile: WebsiteProfile = {
    origin: base,
    analyzedAt,
    requests,
    platform: { name: detection.platform, kind, signal: detection.signal },
    server: detection.server ?? null,
    api: { shopifyProductsJson, graphql, wooCommerce, bigCommerce },
    jsonLd: {
      blocks,
      productOnHomepage,
      productOnProductPage,
      hasPrice,
    },
    protection,
    rendering,
    sitemap: {
      found: sitemap.found,
      urls: sitemap.urls,
      productSitemap: sitemap.productSitemap,
      source: sitemap.source,
      budgetLimited: sitemap.budgetLimited,
    },
    robots: {
      status: politeness.robotsStatus,
      crawlDelayMs: politeness.robotsCrawlDelayMs,
    },
    homepage: {
      productLinks: home.productLinks,
      looksLikeStore: home.looksLikeStore,
      note: home.note,
      externalStoreLinks: home.externalStoreLinks,
    },
    // Recommendation derives from the probed view only (filled below).
    recommendation: {
      tier: "sitemap-HTTP",
      notes: [],
    },
  };

  // The recommendation is a pure function of the probed profile — computed
  // after the object exists so it can read itself (no circular init).
  profile.recommendation = recommend({
    api: profile.api,
    protection: profile.protection,
    sitemap: profile.sitemap,
    rendering: profile.rendering,
    platform: profile.platform,
  });

  return profile;
}
