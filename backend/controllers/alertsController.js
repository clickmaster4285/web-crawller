/**
 * alertsController — Phase 4 alerts API (architecture §5.2).
 *
 * All routes require the `auth` middleware: read/dismiss state is per-user,
 * keyed by `req.user.userId` from the JWT.
 *
 *   GET  /api/data/alerts            ?type=&page=&limit= → paginated feed
 *   POST /api/data/alerts/read       { eventId }
 *   POST /api/data/alerts/read-all
 *   POST /api/data/alerts/dismiss    { eventId }
 */
const alertsService = require('../services/alertsService');

const fail = (res, error) => {
  console.error('[alerts] error:', error?.message ?? error);
  res.status(500).json({
    success: false,
    message: error?.message ?? 'Server error'
  });
};

async function list(req, res) {
  try {
    const data = await alertsService.listAlerts({
      userId: req.user.userId,
      type: req.query.type || 'all',
      page: req.query.page,
      limit: req.query.limit
    });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error);
  }
}

async function markRead(req, res) {
  try {
    const { eventId } = req.body ?? {};
    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: 'eventId is required'
      });
    }
    await alertsService.markRead(req.user.userId, eventId);
    res.json({ success: true, data: { eventId, read: true } });
  } catch (error) {
    fail(res, error);
  }
}

async function markAllRead(req, res) {
  try {
    const count = await alertsService.markAllRead(req.user.userId);
    res.json({ success: true, data: { read: count } });
  } catch (error) {
    fail(res, error);
  }
}

async function dismiss(req, res) {
  try {
    const { eventId } = req.body ?? {};
    if (!eventId) {
      return res.status(400).json({
        success: false,
        message: 'eventId is required'
      });
    }
    await alertsService.dismiss(req.user.userId, eventId);
    res.json({ success: true, data: { eventId, dismissed: true } });
  } catch (error) {
    fail(res, error);
  }
}

module.exports = { list, markRead, markAllRead, dismiss };
