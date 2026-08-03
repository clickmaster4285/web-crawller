const express = require("express");
const dataController = require("../controllers/dataController");
const crawlController = require("../controllers/crawlController");
const competitorController = require("../controllers/competitorController");
const myStoreController = require("../controllers/myStoreController");

const router = express.Router();

router.get("/workspace", dataController.workspace);
router.get("/my-store", myStoreController.getMyStore);
router.put("/my-store", myStoreController.setMyStore);
router.get("/analytics", dataController.analytics);
router.get("/competitors", dataController.competitors);
router.post("/competitors", competitorController.createCompetitor);
router.delete("/competitors/:id", competitorController.deleteCompetitor);
router.get("/matched-products", dataController.matchedProducts);
router.get("/pricing", dataController.pricing);
router.get("/catalogue", dataController.catalogue);
router.get("/insights", dataController.insights);
router.get("/alerts", dataController.alerts);
router.get("/reports", dataController.reports);

// Saved crawl results (persisted from the TanStack server after a crawl).
router.post("/crawl-results", crawlController.saveCrawlResult);
router.get("/crawl-results", crawlController.getCrawlResults);
router.delete("/crawl-results", crawlController.deleteCrawlResultsByOrigin);
router.delete("/crawl-results/:id", crawlController.deleteCrawlResult);

module.exports = router;
