const express = require('express');
const matchController = require('../controllers/matchController');

const router = express.Router();

// GET /api/match?origin=<encoded competitor origin>&page=&limit=
router.get('/', matchController.matchesForCompetitor);

module.exports = router;
