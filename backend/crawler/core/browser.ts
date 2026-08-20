/**
 * Tier 1 — Playwright browser rendering (JS-rendered stores).
 *
 * Renders a URL in headless Chromium and returns the fully-rendered DOM HTML,
 * so the discovery + extraction layers see the content that JS builds (Nuxt,
 * Next, Vue, React SPA shells) instead of an empty app mount.
 *
 * Lazy by design:
 *   - `playwright` is only ever required from inside a render call (via
 *     `createRequire`, the same pattern `checkpoint.ts` uses for
 *     better-sqlite3), so plain HTTP crawls never load it and it never
 *     reaches the client bundle.
 *   - No browser is downloaded by install. Launch prefers the system-installed
 *     Google Chrome (`channel: "chrome"`), then Microsoft Edge, then falls
 *     back to Playwright's bundled Chromium (requires `npx playwright install
 *     chromium`). This keeps the feature working on machines with Chrome
 *     already present.
 *
 * AUTO by default: the engine wires `renderWithBrowser` whenever
 * `config.useBrowser !== false`, and `core/http.ts` decides per page whether
 * rendering is genuinely needed (content-poor JS shells only). Only
 * `useBrowser: false` disables the module entirely.
 */

import { createRequire } from "node:module";
import type { Browser } from "playwright";

const require = createRequire(import.meta.url);

export interface BrowserRenderOptions {
  userAgent?: string;
  /** Per-page load timeout (ms). Default 45s. */
  timeoutMs?: number;
  /** Extra settle time after network idle (ms) for SPA hydration. Default 1500. */
  settleMs?: number;
  /**
   * Wait up to this long (ms) AFTER the settle for a price signal to appear
   * in the DOM. Some storefronts fetch prices via a late XHR that fires well
   * after networkidle (activefitnessstore.com's `get-price` call lands ~3s+
   * after idle, and its price node is blank until then) — without this poll
   * the render returns a shell with no price and extraction misses. Default
   * 4000ms. 0 disables (old behavior).
   */
  priceWaitMs?: number;
  /**
   * Tier 2 — residential proxy gateway URL. When set, the rendering context's
   * traffic exits through the proxy (Playwright context-level proxy), so a
   * WAF that blocks the machine's IP can't spare the JS-shell pages either.
   */
  proxy?: string;
}

/**
 * Splits a gateway URL (`http://user:pass@host:port`) into Playwright's
 * context-proxy shape: the server URL WITHOUT userinfo (Playwright can
 * mis-parse credentials embedded in the server string) plus explicit
 * username/password fields.
 */
function playwrightProxy(url: string): {
  server: string;
  username?: string;
  password?: string;
} {
  const u = new URL(url);
  return {
    server: `${u.protocol}//${u.host}`,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

/** Reused across renders within the process — launch is the expensive part. */
let lazyBrowser: Promise<Browser> | null = null;

/** Lazy-requires playwright; throws a helpful message when it's missing. */
function loadPlaywright(): typeof import("playwright") {
  try {
    return require("playwright") as typeof import("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed — run `npm i playwright` to enable browser rendering.",
    );
  }
}

/** Launches Chromium, preferring system Chrome/Edge, then bundled Chromium. */
async function launchBrowser(): Promise<Browser> {
  const pw = loadPlaywright();
  let lastError: unknown;
  // `--disable-quic` forces TCP instead of HTTP/3 (UDP): on networks that
  // block UDP, Chrome can otherwise stall forever on the QUIC attempt even
  // though the site is reachable over TCP.
  const args = ["--disable-quic"];
  for (const extra of [
    { channel: "chrome" as const, args },
    { channel: "msedge" as const, args },
    { args },
  ]) {
    try {
      return await pw.chromium.launch({ headless: true, ...extra });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "Browser rendering unavailable — Chrome was not found. Install Chrome, or run `npx playwright install chromium` to download Playwright's bundled browser. " +
      `(${lastError instanceof Error ? lastError.message : String(lastError)})`,
  );
}

/**
 * Races `p` against a hard timeout so a misbehaving navigation can never
 * hang a crawl (Playwright's own navigation timeout has been observed not to
 * fire on some sites — this is the enforcement).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

/** Shared browser instance; a failed launch resets so a retry can recover. */
function getBrowser(): Promise<Browser> {
  if (!lazyBrowser) {
    lazyBrowser = launchBrowser().catch((error) => {
      lazyBrowser = null;
      throw error;
    });
  }
  return lazyBrowser;
}

/**
 * Closes the shared browser, if one was launched. Call after a crawl finishes
 * so the Chromium process doesn't keep the Node process (or a crawl job)
 * alive. Safe to call when nothing was ever launched.
 */
export async function closeBrowser(): Promise<void> {
  if (!lazyBrowser) return;
  const pending = lazyBrowser;
  lazyBrowser = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // Launch may have failed — nothing to close.
  }
}

/** Renders `url` in a fresh incognito context and returns the DOM HTML. */
export async function renderWithBrowser(
  url: string,
  options: BrowserRenderOptions = {},
): Promise<string> {
  const browser = await getBrowser();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const context = await browser.newContext({
    userAgent: options.userAgent,
    viewport: { width: 1366, height: 900 },
    // Tier 2: render from the proxy when one is configured — the HTTP layer
    // already exits through it, the browser must too or a WAF would only
    // block the rendered (JS-shell) pages.
    ...(options.proxy ? { proxy: playwrightProxy(options.proxy) } : {}),
  });
  try {
    const page = await context.newPage();
    // "commit" resolves as soon as the main response is received — far more
    // reliable than domcontentloaded for sites that never settle the load
    // event. Hydration time is covered by the settle buffer below. Every step
    // is raced against a hard cap so a bad navigation can't hang the crawl.
    await withTimeout(
      page.goto(url, {
        waitUntil: "commit",
        timeout: Math.min(timeoutMs, 20_000),
      }),
      Math.min(timeoutMs, 25_000),
      "page.navigate",
    );
    try {
      await withTimeout(
        page.waitForLoadState("domcontentloaded", { timeout: 10_000 }),
        12_000,
        "domcontentloaded",
      );
    } catch {
      // Proceed with what's rendered.
    }
    try {
      await withTimeout(
        page.waitForLoadState("networkidle", { timeout: 8_000 }),
        10_000,
        "networkidle",
      );
    } catch {
      // Sites with persistent connections (websockets, analytics) never idle.
    }
    await page.waitForTimeout(options.settleMs ?? 1500);
    // Late-price wait (Aug 2026): poll the DOM for a price-ish signal so a
    // storefront whose prices load via a post-idle XHR actually extracts.
    // The signals mirror the extractor chain's own patterns (price selectors
    // would be store-specific; these are the universal ones). Cheap: a
    // querySelector poll, no navigation. Breaks the instant a signal appears
    // so fast stores pay nothing.
    const priceWaitMs = options.priceWaitMs ?? 4000;
    if (priceWaitMs > 0) {
      const deadline = Date.now() + priceWaitMs;
      let sawPrice = false;
      while (Date.now() < deadline && !sawPrice) {
        sawPrice = await withTimeout(
          page.evaluate(() => {
            // Runs in the BROWSER (the crawler's tsconfig has no DOM lib, so
            // the globals are reached via the globalThis escape hatch; the
            // document shape is declared structurally).
            type PageDoc = {
              body?: { innerText?: string } | null;
              querySelector?: (sel: string) => unknown;
            };
            const doc = (globalThis as unknown as { document?: PageDoc })
              .document;
            const text = doc?.body?.innerText ?? "";
            // Mirror the extractor chain's own price patterns (core
            // http.ts needsBrowserRender / extract/html-heuristics.ts): ISO
            // currency codes + symbols followed by a number. OMR/AED/SAR/
            // QAR/KWD/BHD are the GCC codes activefitnessstore renders as
            // `TOTAL PRICE <span> OMR 1,545</span>`.
            return (
              /(?:AED|OMR|SAR|QAR|KWD|BHD|USD|EUR|GBP|JPY|INR|PKR|EGP|CNY|د\.إ|£|\$|€|¥)\s*[\d,.]+/.test(text) ||
              (doc?.querySelector?.(
                '[itemprop="price"], .price, .product-price, [class*="price"], [data-testid*="price"]',
              ) != null)
            );
          }),
          2000,
          "price-poll",
        );
        if (!sawPrice) await page.waitForTimeout(400);
      }
    }
    return await withTimeout(page.content(), 10_000, "page.content");
  } finally {
    await context.close().catch(() => {});
  }
}
