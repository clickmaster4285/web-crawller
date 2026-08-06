/**
 * AlertState — per-user read/dismiss state for the alerts feed (Phase 4).
 *
 * One row per (user, ProductEvent): `readAt` set when the user opened the
 * alert, `dismissedAt` when they dismissed it. An event with NO row is
 * unread (read and dismiss both count as seen, so "unread" = total events −
 * rows for the user).
 *
 * Rows expire ~5 days AFTER their event's TTL (EVENT_TTL_SECONDS + 5 days,
 * keyed on createdAt, which is always >= the event's `at`) so a state row can
 * never outlive its event by much — unread counts stay consistent without
 * ever counting an event that is gone.
 */
const mongoose = require('mongoose');

// Events expire EVENT_TTL_SECONDS after `at`; a state row is created at read
// time (>= event `at`), so expiring 5 days later guarantees the event goes
// first and the count never drifts.
const STATE_TTL_SECONDS = 90 * 24 * 60 * 60 + 5 * 24 * 60 * 60;

const alertStateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User id is required']
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductEvent',
      required: [true, 'Event id is required']
    },
    readAt: { type: Date, default: null },
    dismissedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// One state row per (user, event) — upserts target this index.
alertStateSchema.index({ userId: 1, eventId: 1 }, { unique: true });
// "Seen" count per user (unread = total events − seen).
alertStateSchema.index({ userId: 1, createdAt: -1 });
// TTL: state rows expire after their events (see header).
alertStateSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: STATE_TTL_SECONDS }
);

const AlertState = mongoose.model('AlertState', alertStateSchema);
AlertState.STATE_TTL_SECONDS = STATE_TTL_SECONDS;

module.exports = AlertState;
