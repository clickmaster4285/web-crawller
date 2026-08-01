/**
 * SQLite-backed checkpoint store.
 *
 * One row per (origin, url) tracking:
 *   - etag, lastmod (from response headers / sitemap)
 *   - status, last_fetched_at, last_status_code
 *   - product_json (the parsed CrawledProduct, serialized)
 *
 * Used for:
 *   - Resume on crash — restart the script, pick up where it left off.
 *   - Skip unchanged — if etag/lastmod match the previous response, skip
 *     the parse and reuse the cached product_json.
 *
 * Native module: only safe to import from Node. The crawl script loads the
 * module at runtime via `createRequire`; the app never imports the crawler,
 * so `better-sqlite3` never reaches the TanStack Start client bundle.
 * Importing this module outside Node fails (it pulls `node:fs`/`node:module`).
 *
 * Schema is created lazily on first `open()`.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { CrawledProduct } from "./types.ts";

export interface CheckpointRow {
  origin: string;
  url: string;
  etag: string | null;
  lastmod: string | null;
  statusCode: number | null;
  status: "fetched" | "failed";
  productJson: string | null;
  lastFetchedAt: string;
}

export interface CheckpointStore {
  shouldFetch(input: {
    origin: string;
    url: string;
    etag?: string;
    lastmod?: string;
  }): boolean;
  recordFetch(row: CheckpointRow): void;
  recordFailure(origin: string, url: string): void;
  getCachedProduct(origin: string, url: string): CrawledProduct | null;
  close(): void;
}

/**
 * Opens (or creates) a SQLite checkpoint DB at `dbPath`. Pass `":memory:"`
 * for a transient store (used by tests).
 */
export function openCheckpointStore(dbPath: string): CheckpointStore {
  // Lazy require so the module is importable from non-Node environments
  // (the app's client bundle pulls types only; the script loads this at
  // runtime).
  // `require` is a local createRequire binding, so no-require-imports (which
  // only flags the global require) never fires here.
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      origin          TEXT NOT NULL,
      url             TEXT NOT NULL,
      etag            TEXT,
      lastmod         TEXT,
      status_code     INTEGER,
      status          TEXT NOT NULL,
      product_json    TEXT,
      last_fetched_at TEXT NOT NULL,
      PRIMARY KEY (origin, url)
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_origin ON checkpoints(origin);
  `);

  const stmtShouldFetch = db.prepare<
    [string, string],
    { etag: string | null; lastmod: string | null; status: string }
  >(`
    SELECT etag, lastmod, status FROM checkpoints
    WHERE origin = ? AND url = ?
  `);
  const stmtUpsert = db.prepare(`
    INSERT INTO checkpoints (origin, url, etag, lastmod, status_code, status, product_json, last_fetched_at)
    VALUES (@origin, @url, @etag, @lastmod, @statusCode, @status, @productJson, @lastFetchedAt)
    ON CONFLICT(origin, url) DO UPDATE SET
      etag            = excluded.etag,
      lastmod         = excluded.lastmod,
      status_code     = excluded.status_code,
      status          = excluded.status,
      product_json    = excluded.product_json,
      last_fetched_at = excluded.last_fetched_at
  `);
  const stmtSelectProduct = db.prepare<
    [string, string],
    { product_json: string | null }
  >(`
    SELECT product_json FROM checkpoints WHERE origin = ? AND url = ?
  `);
  // Failure upsert deliberately does NOT touch etag/lastmod/product_json so a
  // transient failure can't destroy a previously-good cached product — the
  // next run retries (`shouldFetch` returns true for `failed`) and only a
  // successful refetch replaces the cache.
  const stmtFailure = db.prepare(`
    INSERT INTO checkpoints (origin, url, status, last_fetched_at)
    VALUES (@origin, @url, 'failed', @lastFetchedAt)
    ON CONFLICT(origin, url) DO UPDATE SET
      status          = excluded.status,
      last_fetched_at = excluded.last_fetched_at
  `);

  return {
    shouldFetch({ origin, url, etag, lastmod }) {
      const row = stmtShouldFetch.get(origin, url);
      if (!row || row.status === "failed") return true;
      if (etag && row.etag === etag) return false;
      if (lastmod && row.lastmod === lastmod) return false;
      return true;
    },
    recordFetch(row) {
      stmtUpsert.run({
        origin: row.origin,
        url: row.url,
        etag: row.etag,
        lastmod: row.lastmod,
        statusCode: row.statusCode,
        status: row.status,
        productJson: row.productJson,
        lastFetchedAt: row.lastFetchedAt,
      });
    },
    recordFailure(origin, url) {
      stmtFailure.run({
        origin,
        url,
        lastFetchedAt: new Date().toISOString(),
      });
    },
    // May return last-known-good data even for a row whose latest attempt
    // failed — the engine only calls this after shouldFetch() says skip,
    // which never happens for "failed" rows.
    getCachedProduct(origin, url) {
      const row = stmtSelectProduct.get(origin, url);
      if (!row?.product_json) return null;
      try {
        return JSON.parse(row.product_json) as CrawledProduct;
      } catch {
        return null;
      }
    },
    close() {
      db.close();
    },
  };
}
