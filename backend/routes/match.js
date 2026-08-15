const express = require('express');
const matchController = require('../controllers/matchController');
const auth = require('../middleware/auth');

const router = express.Router();

// Phase 5 — JWT-protected (product matching reads crawl data).
router.use(auth);

// GET /api/match?origin=<encoded competitor origin>&page=&limit=
router.get('/', matchController.matchesForCompetitor);

module.exports = router;
