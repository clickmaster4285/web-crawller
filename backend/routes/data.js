const express = require("express");
const dataController = require("../controllers/dataController");
const crawlController = require("../controllers/crawlController");

const router = express.Router();

router.get("/workspace", dataController.workspace);
router.get("/analytics", dataController.analytics);
router.get("/competitors", dataController.competitors);
router.get("/matched-products", dataController.matchedProducts);
router.get("/pricing", dataController.pricing);
router.get("/catalogue", dataController.catalogue);
router.get("/insights", dataController.insights);
router.get("/alerts", dataController.alerts);
router.get("/reports", dataController.reports);

// Saved crawl results (persisted from the TanStack server after a crawl).
router.post("/crawl-results", crawlController.saveCrawlResult);
router.get("/crawl-results", crawlController.getCrawlResults);

module.exports = router;
