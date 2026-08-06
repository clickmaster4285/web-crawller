/**
 * Cooperative crawl control — pause / resume / cancel.
 *
 * The worker (or any caller) shares a `CrawlControl` object with the engine.
 * The engine checks it between units of work (each product URL, each sitemap
 * child, each HTML BFS page) so a running crawl responds to pause/cancel
 * without ever being interrupted mid-request.
 *
 * - `pause` — the engine finishes the in-flight request, then waits until the
 *   action clears (resume) or turns into `cancel`.
 * - `cancel` — the engine throws `CrawlCancelledError`, which unwinds the
 *   crawl cleanly. The worker treats it as a cancellation, not a failure: no
 *   result is persisted and the job is marked `cancelled`.
 *
 * While paused, the caller keeps the job alive (the worker's heartbeat timer
 * keeps running) and is responsible for surfacing the state to the user.
 */

export type CrawlControlAction = "pause" | "cancel";

/** Mutable control handle — the engine reads `action`, the caller writes it. */
export interface CrawlControl {
  action: CrawlControlAction | null;
  /** Poll interval while paused (ms). Default 500. */
  intervalMs?: number;
}

/** Thrown when a crawl is cancelled between units of work. */
export class CrawlCancelledError extends Error {
  constructor() {
    super("Crawl cancelled");
    this.name = "CrawlCancelledError";
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True for anything that unwound the crawl as a cancellation (not a failure). */
export function isCrawlCancelled(error: unknown): boolean {
  return (
    error instanceof CrawlCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "CrawlCancelledError")
  );
}

/** Throws CrawlCancelledError when the control requests cancel. */
export function checkCancelled(control?: CrawlControl): void {
  if (control?.action === "cancel") throw new CrawlCancelledError();
}

/**
 * Cooperative check point: cancels when requested, and while paused waits
 * until the caller resumes (or cancels). Safe to call with no control — a
 * no-op for plain script crawls.
 */
export async function waitForControl(control?: CrawlControl): Promise<void> {
  if (!control) return;
  checkCancelled(control);
  while (control.action === "pause") {
    await sleep(control.intervalMs ?? 500);
    checkCancelled(control);
  }
}
