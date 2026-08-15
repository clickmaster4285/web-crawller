/**
 * HTTP layer for the crawler.
 *
 * - Sets a descriptive User-Agent.
 * - Waits before every request — `delayMs` statically, or an adaptive
 *   per-host throttle (step 5) when one is provided.
 * - Retries 429 (rate-limited) and 5xx with exponential backoff, honoring
 *   the Retry-After header when present, and reports outcomes to the
 *   throttle (slowdown on 429, speedup after success).
 *
 * Note: this module is intentionally dependency-free and uses the global
 * `fetch` so it can run from a plain Node script (type-stripped) or from
 * TanStack Start server functions later.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { CrawlConfig } from "./types.ts";

/**
 * Tier 2 — the fetch function used for PROXIED requests. Node's global fetch
 * is a DIFFERENT undici copy than the one this package installs, and it
 * rejects a `ProxyAgent` built from this copy with "invalid onRequestStart
 * method" (observed: undici 8.x ProxyAgent under Node 24's global fetch).
 * undici's own `fetch` + its own `ProxyAgent` from the same copy are always
 * compatible, so proxied requests bypass the global fetch entirely.
 */
const proxiedFetch = (
  url: string,
  init: RequestInit,
  agent: ProxyAgent,
): Promise<Response> =>
  undiciFetch(
    url,
    // The DOM RequestInit and undici's FetchInit share every field we pass
    // (headers/signal/body…) — only their FormData typings differ, so cast
    // at the boundary.
    { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1],
  ) as Promise<Response>;

const DEFAULT_USER_AGENT =
  "ParityBot/1.0 (+https://parity.app; competitive-intelligence demo crawler)";

/**
 * Browser-like UA for stores whose WAF rejects the ParityBot UA outright
 * (dawlance.com.pk 403s EVERY ParityBot request while a Chrome UA gets 200s
 * from the same IP — verified Aug 2026; same for prosportsae/athletix).
 * Opt-in per store via the crawl param `userAgent: "browser"`; the sentinel
 * resolves here so the constant lives in exactly one place (the engine's
 * HTTP layer). robots.txt parsing still runs for the browser UA token (it's
 * parsed per `user-agent` directive), so politeness is preserved.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Resolves a crawl's user-agent setting into the header value sent on every
 * request. The stored setting is either `"browser"` (the sentinel → the
 * Chrome UA above) or a raw UA string (future custom UAs); null/undefined
 * keeps the default ParityBot UA.
 */
export function resolveUserAgent(
  userAgent?: string | null,
): string | undefined {
  return userAgent === "browser" ? BROWSER_USER_AGENT : userAgent ?? undefined;
}

/**
 * Tier 2 — shared `ProxyAgent`s, one per proxy URL. Agents are cheap to
 * create but pooling them avoids re-establishing connections on every
 * request. Bounded: a crawl uses one proxy at a time, and a long-lived SSR
 * server can't accumulate more than a handful of gateway URLs — past that
 * the map is reset (re-creating an agent is cheap).
 */
const proxyAgents = new Map<string, ProxyAgent>();
const MAX_CACHED_PROXY_AGENTS = 16;

function proxyAgentFor(url: string): ProxyAgent | undefined {
  if (!url) return undefined;
  let agent = proxyAgents.get(url);
  if (!agent) {
    if (proxyAgents.size >= MAX_CACHED_PROXY_AGENTS) {
      // Evicted agents must be closed, not just dropped — an unclosed undici
      // dispatcher keeps its keep-alive sockets (and can delay process exit).
      for (const a of proxyAgents.values()) a.close().catch(() => {});
      proxyAgents.clear();
    }
    agent = new ProxyAgent(url);
    proxyAgents.set(url, agent);
  }
  return agent;
}

/**
 * Closes + forgets a cached proxy agent (e.g. after a crawl finishes) so its
 * keep-alive sockets can't leak across jobs or delay worker shutdown. undici
 * dispatchers must be closed to release their connections.
 */
export function closeProxyAgent(url: string): void {
  const agent = proxyAgents.get(url);
  if (agent) {
    proxyAgents.delete(url);
    agent.close().catch(() => {});
  }
}

/** Adaptive request throttle — see `core/politeness.ts` for the implementation. */
export interface RequestThrottle {
  wait(): Promise<void>;
  reportSuccess(): void;
  reportRateLimited(retryAfterMs?: number): void;
}

/**
 * Stored HTTP validators from the last successful fetch (Product.httpState) —
 * sent as conditional headers so an unchanged page answers `304 Not Modified`
 * instead of a full 200 + body (cheap revalidation, architecture §3.1).
 */
export interface ConditionalRequest {
  /** ETag from the last fetch — sent as `If-None-Match`. */
  etag?: string | null;
  /** Last-Modified ms (from the sitemap or the last response) — sent as `If-Modified-Since`. */
  lastmod?: number | null;
}

export interface HttpOptions {
  delayMs?: number;
  maxRetries?: number;
  /** Per-request timeout (ms). Default 30s — a stalled connection can't hang the crawl. */
  timeoutMs?: number;
  userAgent?: string;
  /**
   * Stored validators for a conditional revalidation: when set, the request
   * carries `If-None-Match` / `If-Modified-Since` and an unchanged resource
   * answers `304` (returned as-is — the caller decides what to do with it).
   */
  conditional?: ConditionalRequest;
  /**
   * Adaptive per-host throttle (step 5). When set, replaces the static
   * `delayMs` sleep before each request and receives 429/success reports.
   */
  throttle?: RequestThrottle;
  /**
   * Robots.txt gate (step 5). Callers use it to skip URLs that robots.txt
   * disallows before fetching them.
   */
  isAllowed?: (url: string) => boolean;
  /**
   * Tier 1 — Playwright fallback (opt-in per crawl). When set, `fetchText`
   * re-renders HTML pages that look like a client-side JS shell (Nuxt/Next/
   * Vue/React app mounts, near-empty server HTML) and returns the rendered
   * DOM instead, so discovery + extraction see the real content. Sitemap
   * XML and JSON responses are never re-rendered.
   */
  renderWithBrowser?: (url: string) => Promise<string>;
  /**
   * Structured run-log emit (Phase 5 observability) — forwarded from
   * CrawlConfig.onLog so HTTP-level warnings (rate limits, retries) land on
   * the job's capped progress.log alongside the engine's lifecycle lines.
   */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /**
   * Tier 2 — rotating residential proxy gateway URL (opt-in per crawl). When
   * set, every request goes through undici's `ProxyAgent` (provider-side IP
   * rotation). Same retries / backoff / throttle as direct fetches.
   */
  proxy?: string;
  /**
   * Debug instrumentation — called once per actual HTTP request made through
   * this options object (every attempt, success or retried failure). The
   * worker uses it to surface a live request count on the crawl job.
   */
  onRequest?: () => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHeaders(userAgent?: string): Record<string, string> {
  return {
    "user-agent": userAgent ?? DEFAULT_USER_AGENT,
    accept: "application/json, text/html, application/xml, */*",
  };
}

/**
 * Strips a proxy gateway URL (and its credentials) out of an error message.
 * Proxy-connection failures can embed the gateway host/port in the cause
 * text, and failure strings are persisted in crawl results + shown in the
 * UI — the proxy URL (especially its credentials) must never leak there.
 *
 * Single source of truth for proxy redaction: the crawler's HTTP layer, the
 * backend proxy-test controller and the worker's boundary net all reuse it.
 */
export function sanitizeProxyFromMessage(
  error: unknown,
  proxy: string | undefined,
): string {
  let message = error instanceof Error ? error.message : String(error);
  if (proxy) {
    // Both the full URL and the credential-stripped form (a cause may print
    // either the raw URL or a redacted host) are replaced.
    const withoutCreds = proxy.replace(/\/\/[^@/]*@/, "//[redacted]@");
    message = message
      .split(proxy)
      .join("[proxy]")
      .split(withoutCreds)
      .join("[proxy]");
  }
  return message;
}

/**
 * Fetch `url`, waiting `delayMs` first and retrying transient failures.
 * Throws after exhausting retries.
 */
export async function fetchWithRetry(
  url: string,
  options: HttpOptions = {},
): Promise<Response> {
  const delayMs = options.delayMs ?? 1000;
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const headers = makeHeaders(options.userAgent);
  // Conditional revalidation: an unchanged resource answers 304 (no body) —
  // the cheapest possible "still the same" signal for resume state.
  if (options.conditional?.etag) {
    headers["if-none-match"] = options.conditional.etag;
  }
  if (options.conditional?.lastmod) {
    headers["if-modified-since"] = new Date(
      options.conditional.lastmod,
    ).toUTCString();
  }

  for (let attempt = 0; ; attempt++) {
    if (options.throttle) {
      await options.throttle.wait();
    } else {
      await sleep(delayMs);
    }

    let response: Response;
    try {
      // Tier 2: route through the residential proxy when configured. Proxied
      // requests use undici's own fetch (same copy as the ProxyAgent) — see
      // `proxiedFetch` above; direct requests keep the global fetch.
      const proxy = options.proxy ? proxyAgentFor(options.proxy) : undefined;
      response = proxy
        ? await proxiedFetch(
            url,
            { headers, signal: AbortSignal.timeout(timeoutMs) },
            proxy,
          )
        : await fetch(url, {
            headers,
            signal: AbortSignal.timeout(timeoutMs),
          });
    } catch (error) {
      // Count the attempt even when it failed — it was a real request.
      options.onRequest?.();
      if (attempt >= maxRetries) {
        throw new Error(
          `Network error for ${url}: ${sanitizeProxyFromMessage(error, options.proxy)}`,
        );
      }
      await sleep(delayMs * (attempt + 1));
      continue;
    }
    options.onRequest?.();

    if (
      response.status !== 429 &&
      (response.status < 500 || response.status > 599)
    ) {
      options.throttle?.reportSuccess();
      return response;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (response.status === 429) {
      options.throttle?.reportRateLimited(retryAfterMs);
      options.onLog?.(
        "warn",
        `HTTP 429 rate-limited for ${url}${retryAfterMs ? ` — Retry-After ${Math.round(retryAfterMs / 1000)}s` : ""}${attempt >= maxRetries ? " — giving up after " + (maxRetries + 1) + " attempts" : ` (attempt ${attempt + 1}/${maxRetries + 1})`}`
      );
      // With a throttle present it owns the 429 wait — the next loop-top
      // wait() sleeps the elevated, Retry-After-aware delay. Skipping the
      // explicit backoff avoids paying Retry-After twice.
      if (options.throttle) {
        if (attempt >= maxRetries) {
          throw new Error(
            `HTTP 429 for ${url} after ${maxRetries + 1} attempts`,
          );
        }
        continue;
      }
    }

    const backoff = retryAfterMs ?? delayMs * 2 ** (attempt + 1);
    if (attempt >= maxRetries) {
      throw new Error(
        `HTTP ${response.status} for ${url} after ${maxRetries + 1} attempts`,
      );
    }
    await sleep(backoff);
  }
}

/** Reads the `retry-after` header (seconds or HTTP date). */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return Math.max(0, ms - Date.now());
  return undefined;
}

export async function fetchJson(
  url: string,
  options: HttpOptions = {},
): Promise<unknown> {
  const response = await fetchWithRetry(url, options);
  return await response.json();
}

export async function fetchText(
  url: string,
  options: HttpOptions = {},
): Promise<string> {
  return (await fetchHtmlWithStatus(url, options)).body;
}

/** A fetched page with the response status + etag (needed by the fetch loop). */
export interface FetchedHtml {
  status: number;
  etag: string | null;
  body: string;
}

/**
 * Fetches an HTML page AND applies the Tier 1 auto-render decision — the
 * status/etag variant of `fetchText`, so callers that must see the response
 * (the per-product fetch loop: 304 handling, etag persistence) get rendering
 * too. Without this, a JS-shell page goes to the extractor raw and yields
 * "No product data found" — Aug 2026, the product fetch loop called
 * `fetchWithRetry` directly and auto JS rendering silently never ran for
 * products (only discovery used fetchText), so every Next.js store crawled
 * to zero prices regardless of the WAF.
 */
export async function fetchHtmlWithStatus(
  url: string,
  options: HttpOptions = {},
): Promise<FetchedHtml> {
  const response = await fetchWithRetry(url, options);
  const body = await response.text();
  // Tier 1 (Playwright) auto fallback: when the renderer is available and the
  // server HTML looks like a client-rendered shell, render it in a browser and
  // use the hydrated DOM. A renderer failure keeps the raw HTML — the crawl
  // reports it honestly.
  if (
    options.renderWithBrowser &&
    isProbablyHtml(body) &&
    needsBrowserRender(body)
  ) {
    try {
      return {
        status: response.status,
        etag: response.headers.get("etag"),
        body: await options.renderWithBrowser(url),
      };
    } catch {
      // Fall through with the raw HTML.
    }
  }
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    body,
  };
}

/** True when a body is HTML (not sitemap XML / JSON). */
function isProbablyHtml(body: string): boolean {
  const head = body.slice(0, 1024).trimStart().toLowerCase();
  if (head.startsWith("<?xml")) return false;
  if (head.startsWith("<urlset") || head.startsWith("<sitemapindex")) {
    return false;
  }
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<!DOCTYPE") ||
    body.includes("<head")
  );
}

/**
 * Auto mode decision — true when server HTML looks like a client-rendered
 * shell that genuinely needs JS to show its content. The check is deliberately
 * CONTENT-POOR ONLY: rendering is expensive (headless Chromium, 1-5s/page), so
 * a page is only ever re-rendered when its raw HTML can't stand alone — a JS
 * shell with no server-side price/links. Content-rich pages (server-rendered
 * product pages with JSON-LD product offers, og:price, itemprop="price" or a
 * normal link density) are NEVER rendered, so auto mode costs nothing on
 * regular stores.
 *
 * Aug 2026 lesson (activefitnessstore.com): og:title is NOT a price signal —
 * Next.js shells ship og tags while loading prices via JS, and App Router
 * shells mount a bare <div> + spinner (no `id="__next"`). A page is only
 * trusted as "content-rich" when the server HTML actually carries a price;
 * a bundle + spinner body is a shell and gets rendered.
 */
export function needsBrowserRender(body: string): boolean {
  const head = body.slice(0, 200_000);
  const linkCount = body.match(/<a\s/g)?.length ?? 0;
  // A REAL price signal in the server HTML — JSON-LD Product offer, og:price,
  // or itemprop="price" — means extraction works without a browser. og:title
  // alone is NOT enough (see the note above). A sensible link count also
  // means the server HTML carries real content.
  const hasPriceSignal =
    (/application\/ld\+json/i.test(head) &&
      /"@type"\s*:\s*"Product"/i.test(head) &&
      /"price"/i.test(head)) ||
    /og:price(?::amount)?\s*[:=]/i.test(head) ||
    /itemprop=["']?price["']?/i.test(head);
  if (hasPriceSignal || linkCount >= 10) {
    return false;
  }
  // A genuine shell: a JS bundle with either an app-mount element
  // (`#__nuxt`/`#__next`/`#root`…) or a loading-spinner body (Next.js App
  // Router shells mount a bare <div> + spinner with no id — that IS the
  // shell signal). Both paired with a bundle.
  const hasBundle = /<script[^>]+src=[^>]*(\.mjs|\.js)/i.test(head);
  if (!hasBundle) return false;
  return (
    /id=["']?(__nuxt|__next|__gatsby|root|app|app-root)["']?/i.test(head) ||
    /ant-spin|spinner|loader|aria-busy=["']?true/i.test(head)
  );
}

/** Derives crawl-scoped HTTP options from a CrawlConfig, plus overrides. */
export function httpOptions(
  config: Partial<CrawlConfig>,
  extra?: Partial<HttpOptions>,
): HttpOptions {
  return {
    delayMs: config.delayMs ?? 1000,
    maxRetries: config.maxRetries ?? 3,
    userAgent: config.userAgent,
    proxy: config.proxy,
    onLog: config.onLog,
    ...extra,
  };
}
