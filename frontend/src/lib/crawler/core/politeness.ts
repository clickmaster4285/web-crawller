/**
 * Politeness layer (step 5): robots.txt + per-host adaptive throttle.
 *
 * - `parseRobotsTxt`: turns a robots.txt body into an allow/deny predicate
 *   and a Crawl-delay (seconds → ms) using `robots-parser`.
 * - `AdaptiveThrottle`: per-host delay that slows down after 429s (also
 *   honoring Retry-After) and decays back to the baseline after successes.
 * - `Politeness`: facade that loads robots.txt once per origin and exposes
 *   the throttle. `runCrawl` wires it into every HTTP request via
 *   `HttpOptions.throttle` / `HttpOptions.isAllowed`.
 *
 * Note: no TypeScript parameter properties (Node's strip-only type-stripping
 * rejects them) — fields are declared explicitly.
 *
 * Tradeoff: the throttle's `wait()` is per-caller, not a global rate limiter.
 * With per-host concurrency > 1 (default 2), two callers can overlap within
 * one delay window, so a robots `Crawl-delay` is treated as a per-request
 * courtesy baseline rather than strict inter-request spacing — the 429
 * backstop (adaptive throttle + Retry-After) is the real enforcement.
 */

import { fetchWithRetry, sleep } from "./http.ts";
import type { RequestThrottle } from "./http.ts";
import type { RobotsStatus } from "./types.ts";
import robotsParser from "robots-parser";

const USER_AGENT_TOKEN = "ParityBot";
const DEFAULT_MAX_DELAY_MS = 60_000;
const ROBOTS_TIMEOUT_MS = 15_000;

export interface ParsedRobots {
  /** Whether robots.txt permits fetching `url`. Absent rules ⇒ true. */
  isAllowed: (url: string) => boolean;
  /** Crawl-delay declared for our user-agent, in ms (`null` = none). */
  crawlDelayMs: number | null;
}

/** Parses a robots.txt body for the given user-agent token. */
export function parseRobotsTxt(
  body: string,
  baseUrl: string,
  agentToken: string,
): ParsedRobots {
  const robots = robotsParser(baseUrl, body);
  const rawDelay = robots.getCrawlDelay(agentToken);
  return {
    isAllowed: (url) => robots.isAllowed(url, agentToken) !== false,
    crawlDelayMs:
      typeof rawDelay === "number" && rawDelay > 0 ? rawDelay * 1000 : null,
  };
}

/**
 * Per-host adaptive throttle. `wait()` delays each request; successes decay
 * the delay back to the baseline ("speed up after warmup"), 429s raise it
 * ("slow down on rate limit"). Satisfies `RequestThrottle`.
 */
export class AdaptiveThrottle implements RequestThrottle {
  private delayMs: number;
  private consecutiveRateLimits = 0;
  private readonly baselineDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(baselineDelayMs: number, maxDelayMs = DEFAULT_MAX_DELAY_MS) {
    this.baselineDelayMs = baselineDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.delayMs = Math.max(baselineDelayMs, 0);
  }

  wait(): Promise<void> {
    return sleep(this.delayMs);
  }

  reportSuccess(): void {
    this.consecutiveRateLimits = Math.max(0, this.consecutiveRateLimits - 1);
    if (this.delayMs > this.baselineDelayMs) {
      this.delayMs = Math.max(
        this.baselineDelayMs,
        Math.round(this.delayMs * 0.8),
      );
    }
  }

  reportRateLimited(retryAfterMs?: number): void {
    this.consecutiveRateLimits++;
    const growth =
      this.baselineDelayMs * 2 ** Math.min(this.consecutiveRateLimits, 5);
    this.delayMs = Math.min(
      this.maxDelayMs,
      Math.max(this.delayMs, retryAfterMs ?? growth),
    );
  }

  get currentDelayMs(): number {
    return this.delayMs;
  }
}

/**
 * Per-origin politeness: robots.txt (fetched once) + the adaptive throttle.
 * Implements `RequestThrottle` so it can be handed straight to the HTTP layer.
 */
export class Politeness implements RequestThrottle {
  private readonly robots: ParsedRobots | null;
  private readonly throttle: AdaptiveThrottle;
  /** Raw robots.txt body ("" when absent/unreachable) — reused by platform detection. */
  readonly robotsBody: string;
  /** robots.txt fetch outcome — "found" (2xx + parsed), "absent" (non-2xx),
   * "unreachable" (network/429), or "skipped" (respectRobots off). */
  readonly robotsStatus: RobotsStatus;
  /** Declared Crawl-delay in ms (`null` when none / not found / skipped). */
  readonly robotsCrawlDelayMs: number | null;

  private constructor(
    robots: ParsedRobots | null,
    throttle: AdaptiveThrottle,
    robotsBody: string,
    robotsStatus: RobotsStatus,
    robotsCrawlDelayMs: number | null,
  ) {
    this.robots = robots;
    this.throttle = throttle;
    this.robotsBody = robotsBody;
    this.robotsStatus = robotsStatus;
    this.robotsCrawlDelayMs = robotsCrawlDelayMs;
  }

  /**
   * Loads politeness for an origin: fetches `/robots.txt` once (one request,
   * no throttle yet) and builds the adaptive throttle. An unreachable or
   * rate-limited robots.txt degrades to permissive (allow everything).
   */
  static async load(
    origin: string,
    options: {
      userAgent?: string;
      delayMs?: number;
      maxDelayMs?: number;
      /** When false, skip robots.txt entirely (no disallow gate, no crawl-delay). */
      respectRobots?: boolean;
    } = {},
  ): Promise<Politeness> {
    const baseDelay = options.delayMs ?? 1000;
    let robots: ParsedRobots | null = null;
    let robotsBody = "";
    let robotsStatus: RobotsStatus =
      options.respectRobots === false ? "skipped" : "absent";
    let robotsCrawlDelayMs: number | null = null;
    if (options.respectRobots !== false) {
      try {
        const response = await fetchWithRetry(`${origin}/robots.txt`, {
          delayMs: baseDelay,
          maxRetries: 1,
          timeoutMs: ROBOTS_TIMEOUT_MS,
          userAgent: options.userAgent,
        });
        if (response.status >= 200 && response.status < 300) {
          robotsBody = await response.text();
          robots = parseRobotsTxt(
            robotsBody,
            `${origin}/robots.txt`,
            USER_AGENT_TOKEN,
          );
          robotsStatus = "found";
          robotsCrawlDelayMs = robots.crawlDelayMs;
        }
      } catch {
        // 429 / network error fetching robots.txt → stay permissive; the
        // adaptive throttle will handle the rate limiting anyway.
        robotsStatus = "unreachable";
      }
    }
    const baseline = Math.max(baseDelay, robots?.crawlDelayMs ?? 0);
    return new Politeness(
      robots,
      new AdaptiveThrottle(
        baseline,
        options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      ),
      robotsBody,
      robotsStatus,
      robotsCrawlDelayMs,
    );
  }

  /** True when robots.txt allows fetching this URL (allow-all when absent). */
  isUrlAllowed(url: string): boolean {
    return this.robots ? this.robots.isAllowed(url) : true;
  }

  wait(): Promise<void> {
    return this.throttle.wait();
  }

  reportSuccess(): void {
    this.throttle.reportSuccess();
  }

  reportRateLimited(retryAfterMs?: number): void {
    this.throttle.reportRateLimited(retryAfterMs);
  }

  get currentDelayMs(): number {
    return this.throttle.currentDelayMs;
  }
}
