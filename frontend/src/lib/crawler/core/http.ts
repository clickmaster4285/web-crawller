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

import type { CrawlConfig } from "./types.ts";

const DEFAULT_USER_AGENT =
  "ParityBot/1.0 (+https://parity.app; competitive-intelligence demo crawler)";

/** Adaptive request throttle — see `core/politeness.ts` for the implementation. */
export interface RequestThrottle {
  wait(): Promise<void>;
  reportSuccess(): void;
  reportRateLimited(retryAfterMs?: number): void;
}

export interface HttpOptions {
  delayMs?: number;
  maxRetries?: number;
  /** Per-request timeout (ms). Default 30s — a stalled connection can't hang the crawl. */
  timeoutMs?: number;
  userAgent?: string;
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

  for (let attempt = 0; ; attempt++) {
    if (options.throttle) {
      await options.throttle.wait();
    } else {
      await sleep(delayMs);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt >= maxRetries) {
        throw new Error(`Network error for ${url}: ${String(error)}`);
      }
      await sleep(delayMs * (attempt + 1));
      continue;
    }

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
  return await response.text();
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
    ...extra,
  };
}
