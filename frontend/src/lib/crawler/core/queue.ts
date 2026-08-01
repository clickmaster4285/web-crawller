/**
 * Bounded-concurrency primitives (step 5).
 *
 * - `Semaphore`: classic counting semaphore.
 * - `HostLimiter`: per-host semaphores so a crawl never hammers a single
 *   host with more than `maxPerHost` concurrent requests.
 * - `runWithConcurrency`: processes an array with a sliding window of
 *   `limit` in-flight workers.
 *
 * All primitives are dependency-free and safe under plain Node. Note: no
 * TypeScript parameter properties (Node's strip-only type-stripping rejects
 * them) — fields are declared explicitly.
 */

/** Default max concurrent requests per host. */
export const DEFAULT_MAX_PER_HOST = 2;

/** Counting semaphore. `acquire()` waits until a permit is free. */
export class Semaphore {
  private permits: number;
  private waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (permits < 0) throw new Error("Semaphore permits must be >= 0");
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

/** Bounded concurrency per host. Hosts never share capacity. */
export class HostLimiter {
  private semaphores = new Map<string, Semaphore>();
  private readonly maxPerHost: number;

  constructor(maxPerHost = DEFAULT_MAX_PER_HOST) {
    this.maxPerHost = maxPerHost;
  }

  acquire(host: string): Promise<void> {
    let semaphore = this.semaphores.get(host);
    if (!semaphore) {
      semaphore = new Semaphore(this.maxPerHost);
      this.semaphores.set(host, semaphore);
    }
    return semaphore.acquire();
  }

  release(host: string): void {
    this.semaphores.get(host)?.release();
  }
}

/**
 * Runs `worker` over `items` with at most `limit` in-flight at once.
 * Workers are expected to be self-contained (they may mutate shared state —
 * JS is single-threaded, so the only interleaving happens between awaits).
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (limit <= 0 || items.length === 0) return;
  let nextIndex = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async () => {
        for (;;) {
          const index = nextIndex++;
          if (index >= items.length) return;
          await worker(items[index]);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

/** Extracts the host (authority) from a URL; falls back to the raw string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
