/**
 * readPath — pure helpers for the Phase-5 store read-path endpoints
 * (architecture §6): keyset cursor encode/decode, regex escaping for `q=`
 * search, and bounded integer/date parsing.
 *
 * Kept framework-free so the pagination and input validation are unit-testable
 * without a database.
 */

/**
 * Encodes a keyset cursor as an opaque base64url string. The payload is
 * `<timestampMs>|<mongoId>` — enough to resume a `{ tsField: -1, _id: -1 }`
 * sort exactly (ties on the timestamp break on _id).
 */
function encodeCursor(tsMs, id) {
  return Buffer.from(`${tsMs}|${String(id)}`, 'utf8').toString('base64url');
}

/**
 * Decodes a keyset cursor back into `{ tsMs, id }`, or `null` for anything
 * malformed (garbage cursors just start the list over — never 500).
 */
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const tsMs = Number(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (!Number.isFinite(tsMs) || !/^[a-f0-9]{24}$/i.test(id)) return null;
    return { tsMs, id };
  } catch {
    return null;
  }
}

/**
 * Builds the Mongo filter that resumes a `{ tsField: -1, _id: -1 }` sort from
 * a decoded cursor, merged onto an existing filter object.
 */
function cursorFilter(cursor, tsField, base = {}) {
  const c = cursor ? decodeCursor(cursor) : null;
  if (!c) return base;
  return {
    ...base,
    $or: [
      { [tsField]: { $lt: new Date(c.tsMs) } },
      { [tsField]: new Date(c.tsMs), _id: { $lt: c.id } }
    ]
  };
}

/** Escapes a user query string so it's safe inside a RegExp. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clamps an integer query param into [min, max]; falls back to `fallback`. */
function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

/** Parses an ISO date query param; `null` when absent or invalid. */
function parseIsoDate(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validates + normalizes the `:key` route param (a normalized host like
 * `store.example.com`). Returns the lowercased key or `null` when invalid.
 *
 * Must accept exactly what `normalizeHost` writes — INCLUDING single-label
 * hosts (`localhost`, `intranet`), since the frontend can crawl a dev store
 * and the rows' `key` would be `localhost`. Protocol, path, port and
 * underscore labels are rejected.
 */
function parseStoreKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  // Host-shaped: one or more labels of alnum/hyphen, optionally dotted.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(key)) {
    return null;
  }
  return key;
}

module.exports = {
  encodeCursor,
  decodeCursor,
  cursorFilter,
  escapeRegex,
  clampInt,
  parseIsoDate,
  parseStoreKey
};
