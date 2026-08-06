/**
 * matchController — Phase 3 persisted-match read path (architecture §6).
 *
 *   GET /api/match?origin=<encoded competitor origin>&page=1&limit=25
 *
 * Returns paginated `ProductMatch` rows joined with the latest prices from
 * `Product`, plus the "only they sell" count — no recomputation on page load
 * (rows are written incrementally by the post-crawl pipeline).
 *
 * The competitor is passed as a query param (not a path param) because an
 * origin URL contains slashes that path params can't carry cleanly.
 */
const matchService = require('../services/matchService');

const matchesForCompetitor = async (req, res) => {
  try {
    const origin = String(req.query.origin ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(origin)) {
      return res.status(400).json({
        success: false,
        message: 'A valid http(s) competitor origin is required (?origin=…)'
      });
    }
    const page = Math.max(1, Math.round(Number(req.query.page ?? 1)));
    const limit = Math.min(100, Math.max(1, Math.round(Number(req.query.limit ?? 25))));
    const data = await matchService.matchesForCompetitor(origin, { page, limit });
    if (!data) {
      // No my-store set yet — the page renders its honest empty state.
      return res.json({ success: true, data: null });
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get matches error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { matchesForCompetitor };
