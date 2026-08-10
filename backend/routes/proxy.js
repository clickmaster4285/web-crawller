const express = require('express');
const proxyController = require('../controllers/proxyController');

const router = express.Router();

// POST /api/proxy/test — verify a Tier-2 residential proxy gateway and report
// the exit IP it would use. Body: { proxy, url? }.
router.post('/test', proxyController.testProxy);

module.exports = router;
