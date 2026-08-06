/**
 * alertsService — the alerts engine (architecture §5.2, Phase 4).
 *
 * Subscribes to ProductEvent rows (computed ONCE at ingest) and maps them to
 * the UI's alert shape with zero recomputation on read:
 *
 *   added          → new_product   (low)
 *   removed        → removed       (high)
 *   price_changed  → price_drop / price_rise, with % + amount and severity
 *                    tiers by magnitude (>=15% high, >=5% medium, else low)
 *   stock_changed  → stock (back-in-stock low, out-of-stock medium)
 *
 * Read/dismiss state lives in per-user AlertState rows (one per event):
 * an event with no row is unread; markRead/markAllRead/dismiss upsert rows.
 */
const ProductEvent = require('../models/ProductEvent');
const AlertState = require('../models/AlertState');
const { normalizeHost } = require('../utils/identity');

/** Severity tiers for price movement magnitude (signed %, drop negative). */
const SEVERITY_HIGH_PCT = 15;
const SEVERITY_MED_PCT = 5;

/** Bulk-write slice (same budget as the ingest pipeline). */
const BATCH_SIZE = 5000;

/** Signed percent change old→new (null when uncomputable, e.g. old price 0). */
function pctChange(oldPrice, newPrice) {
  if (
    typeof oldPrice !== 'number' ||
    typeof newPrice !== 'number' ||
    oldPrice === 0 ||
    !Number.isFinite(oldPrice) ||
    !Number.isFinite(newPrice)
  ) {
    return null;
  }
  return ((newPrice - oldPrice) / Math.abs(oldPrice)) * 100;
}

function severityForPriceChange(pct) {
  const abs = Math.abs(pct ?? 0);
  if (abs >= SEVERITY_HIGH_PCT) return 'high';
  if (abs >= SEVERITY_MED_PCT) return 'medium';
  return 'low';
}

/**
 * Maps one ProductEvent doc to the UI alert shape. Returns null for events
 * that can't render (missing/unparseable price on a price_changed row).
 */
function mapEventToAlert(event) {
  const id = String(event._id);
  const key = event.key || normalizeHost(event.origin || '');
  const name = event.name || 'a product';
  const time =
    event.at instanceof Date ? event.at.toISOString() : String(event.at || '');
  const base = {
    id,
    competitor: key,
    time,
    storeUrl: event.origin || '',
    productUrl: event.url || '',
    priceChangePct: null,
    priceChangeAmount: null
  };

  switch (event.type) {
    case 'added':
      return {
        ...base,
        type: 'new_product',
        severity: 'low',
        title: `New product — ${name}`,
        detail: `${key} added ${name} to their catalogue.`
      };
    case 'removed':
      return {
        ...base,
        type: 'removed',
        severity: 'high',
        title: `Product removed — ${name}`,
        detail: `${name} is no longer listed at ${key}.`
      };
    case 'price_changed': {
      const oldPrice = event.old?.price;
      const newPrice = event.new?.price;
      if (
        typeof oldPrice !== 'number' ||
        typeof newPrice !== 'number' ||
        oldPrice === newPrice
      ) {
        return null;
      }
      const pct = pctChange(oldPrice, newPrice);
      const drop = newPrice < oldPrice;
      const absPct = pct == null ? null : Math.abs(pct);
      const change = newPrice - oldPrice;
      const pctText =
        absPct == null ? '' : ` (${drop ? '−' : '+'}${absPct.toFixed(1)}%)`;
      return {
        ...base,
        type: drop ? 'price_drop' : 'price_rise',
        severity: severityForPriceChange(pct),
        title: `${drop ? 'Price drop' : 'Price rise'} — ${name}`,
        detail: `${key} ${drop ? 'dropped' : 'raised'} ${name} from ${oldPrice.toFixed(
          2
        )} to ${newPrice.toFixed(2)}${pctText}.`,
        priceChangePct: pct,
        priceChangeAmount: change
      };
    }
    case 'stock_changed': {
      const wasAvailable = event.old?.available;
      const isAvailable = event.new?.available;
      if (typeof isAvailable !== 'boolean') return null;
      const restock = isAvailable === true;
      return {
        ...base,
        type: 'stock',
        severity: restock ? 'low' : 'medium',
        title: restock ? `Back in stock — ${name}` : `Out of stock — ${name}`,
        detail: `${name} ${restock ? 'is back in stock' : 'went out of stock'} at ${key}.`
      };
    }
    default:
      return null;
  }
}

/** Mongo filter for a UI alert-type filter ('' / 'all' = no filter). */
function eventTypeFilter(type) {
  switch (type) {
    case 'new_product':
      return { type: 'added' };
    case 'removed':
      return { type: 'removed' };
    case 'stock':
      return { type: 'stock_changed' };
    case 'price_drop':
      return { type: 'price_changed', $expr: { $lt: ['$new.price', '$old.price'] } };
    case 'price_rise':
      return { type: 'price_changed', $expr: { $gt: ['$new.price', '$old.price'] } };
    default:
      return {};
  }
}

/**
 * Lists alerts (newest first) with per-user read/dismissed flags.
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.type] UI alert-type filter (''/'all' = all).
 * @param {number} [params.page]  1-based page.
 * @param {number} [params.limit] Page size (clamped 1–100).
 * @returns {Promise<{alerts: Array, total: number, unreadCount: number,
 *          page: number, limit: number}>}
 */
async function listAlerts({ userId, type, page = 1, limit = 25 }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const filter = eventTypeFilter(type);
  // Dismissed alerts never appear in the feed (their state rows persist so a
  // dismissed event stays gone even after the user marks everything read).
  const dismissed = await AlertState.find({
    userId,
    dismissedAt: { $ne: null }
  })
    .select('eventId')
    .lean();
  if (dismissed.length > 0) {
    filter._id = { $nin: dismissed.map((s) => s.eventId) };
  }
  const skip = (safePage - 1) * safeLimit;

  const [events, total, totalAll, seen] = await Promise.all([
    ProductEvent.find(filter)
      .sort({ at: -1, _id: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    ProductEvent.countDocuments(filter),
    ProductEvent.countDocuments({}),
    AlertState.countDocuments({ userId })
  ]);

  const states = events.length
    ? await AlertState.find({
        userId,
        eventId: { $in: events.map((e) => e._id) }
      })
        .select('eventId readAt dismissedAt')
        .lean()
    : [];
  const stateByEvent = new Map(
    states.map((s) => [String(s.eventId), s])
  );

  const alerts = [];
  for (const ev of events) {
    const alert = mapEventToAlert(ev);
    if (!alert) continue;
    const st = stateByEvent.get(alert.id);
    alert.read = !!(st && (st.readAt || st.dismissedAt));
    alert.dismissed = !!st?.dismissedAt;
    alerts.push(alert);
  }

  return {
    alerts,
    total,
    // Unread = total events − events the user has seen (read or dismissed).
    // AlertState rows expire just after their events (model header), so the
    // two sides stay in sync; clamped against any transient drift.
    unreadCount: Math.max(0, totalAll - seen),
    // Any ProductEvent at all (ignoring filters/dismissals) — the UI uses it
    // to distinguish "no crawls yet" from "everything dismissed/filtered".
    hasAnyEvents: totalAll > 0,
    page: safePage,
    limit: safeLimit
  };
}

/** Marks one alert read (upsert — also covers a dismissed row). */
async function markRead(userId, eventId) {
  await AlertState.updateOne(
    { userId, eventId },
    { $set: { readAt: new Date() } },
    { upsert: true }
  );
}

/**
 * Marks every current event read (streamed bulk upserts — never materializes
 * the full 90-day id set, so a 100k-event backlog stays cheap). Dismissed
 * events get read rows too — harmless, they're excluded from the feed.
 */
async function markAllRead(userId) {
  const cursor = ProductEvent.find({}).select('_id').lean().cursor();
  const now = new Date();
  let ops = [];
  let count = 0;
  for await (const e of cursor) {
    ops.push({
      updateOne: {
        filter: { userId, eventId: e._id },
        update: {
          $set: { readAt: now },
          $setOnInsert: { dismissedAt: null }
        },
        upsert: true
      }
    });
    count++;
    if (ops.length >= BATCH_SIZE) {
      await AlertState.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }
  if (ops.length > 0) await AlertState.bulkWrite(ops, { ordered: false });
  return count;
}

/** Dismisses one alert (it stops appearing in the list). */
async function dismiss(userId, eventId) {
  await AlertState.updateOne(
    { userId, eventId },
    { $set: { dismissedAt: new Date(), readAt: new Date() } },
    { upsert: true }
  );
}

module.exports = {
  mapEventToAlert,
  listAlerts,
  markRead,
  markAllRead,
  dismiss,
  pctChange,
  severityForPriceChange
};
