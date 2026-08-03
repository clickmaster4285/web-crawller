/**
 * Competitor controller — create/delete manually-added competitors.
 *
 * Listing is served by `GET /api/data/competitors` (dataController), which
 * merges these manual entries with the origins derived from saved crawls.
 */

const mongoose = require('mongoose');
const Competitor = require('../models/Competitor');

/** A readable name derived from an origin host (used when the name is blank). */
function nameFromOrigin(origin) {
  try {
    return new URL(origin).hostname
      .replace(/^www\./, '')
      .split('.')[0]
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return origin;
  }
}

const createCompetitor = async (req, res) => {
  try {
    const { name, origin, notes } = req.body || {};
    const normalized = String(origin || '').trim();
    if (!/^https?:\/\/\S+$/i.test(normalized)) {
      return res.status(400).json({
        success: false,
        message: 'Origin must be a valid http(s) URL'
      });
    }
    const doc = await Competitor.create({
      name: String(name || '').trim() || nameFromOrigin(normalized),
      origin: normalized,
      notes: String(notes || '')
    });
    console.log(`➕ Added competitor: ${doc.name} (${doc.origin})`);
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This store is already added as a competitor'
      });
    }
    console.error('Create competitor error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const deleteCompetitor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid competitor id'
      });
    }
    const doc = await Competitor.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Competitor not found'
      });
    }
    console.log(`🗑️ Removed competitor: ${doc.name} (${doc.origin})`);
    res.json({ success: true, data: { deleted: true, id, name: doc.name } });
  } catch (error) {
    console.error('Delete competitor error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { createCompetitor, deleteCompetitor };
