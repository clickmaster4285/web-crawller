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

import { ProxyAgent } from "undici";
import type { CrawlConfig } from "./types.ts";

const DEFAULT_USER_AGENT =
  "ParityBot/1.0 (+https://parity.app; competitive-intelligence demo crawler)";

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
    if (proxyAgents.size >= MAX_CACHED_PROXY_AGENTS) proxyAgents.clear();
    agent = new ProxyAgent(url);
    proxyAgents.set(url, agent);
  }
  return agent;
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
      const proxy = options.proxy ? proxyAgentFor(options.proxy) : undefined;
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        // Tier 2: route through the residential proxy when configured.
        ...(proxy ? { dispatcher: proxy } : {}),
      });
    } catch (error) {
      // Count the attempt even when it failed — it was a real request.
      options.onRequest?.();
      if (attempt >= maxRetries) {
        throw new Error(`Network error for ${url}: ${String(error)}`);
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
  const response = await fetchWithRetry(url, options);
  const body = await response.text();
  // Tier 1 (Playwright) fallback: when enabled and the server HTML looks like
  // a JS shell, render it in a browser and use the hydrated DOM. A renderer
  // failure keeps the raw HTML — the crawl reports it honestly.
  if (
    options.renderWithBrowser &&
    isProbablyHtml(body) &&
    looksLikeJsShell(body)
  ) {
    try {
      return await options.renderWithBrowser(url);
    } catch {
      return body;
    }
  }
  return body;
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
 * True when server HTML looks like a client-rendered shell that needs JS:
 * an app-mount element (`#__nuxt`, `#__next`, `#root`, `#app`…) paired with a
 * JS bundle, or a page with almost no links and no structured data (a shell
 * or a bot-block page).
 */
function looksLikeJsShell(body: string): boolean {
  const head = body.slice(0, 200_000);
  if (
    /id=["']?(__nuxt|__next|__gatsby|root|app|app-root)["']?/i.test(head) &&
    /<script[^>]+src=[^>]*(\.mjs|\.js)/i.test(head)
  ) {
    return true;
  }
  if (
    (body.match(/<a\s/g)?.length ?? 0) < 5 &&
    !/application\/ld\+json|og:title|itemprop=/i.test(head)
  ) {
    return true;
  }
  return false;
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
    ...extra,
  };
}
