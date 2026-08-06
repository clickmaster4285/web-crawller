const express = require("express");
const dataController = require("../controllers/dataController");
const crawlController = require("../controllers/crawlController");
const competitorController = require("../controllers/competitorController");
const myStoreController = require("../controllers/myStoreController");
const alertsController = require("../controllers/alertsController");
const auth = require("../middleware/auth");

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
router.get("/reports", dataController.reports);

// Phase 4 — alerts feed + per-user read/dismiss state (auth-protected).
router.get("/alerts", auth, alertsController.list);
router.post("/alerts/read", auth, alertsController.markRead);
router.post("/alerts/read-all", auth, alertsController.markAllRead);
router.post("/alerts/dismiss", auth, alertsController.dismiss);

// Saved crawl results (persisted from the TanStack server after a crawl).
router.post("/crawl-results", crawlController.saveCrawlResult);
router.get("/crawl-results", crawlController.getCrawlResults);
router.delete("/crawl-results", crawlController.deleteCrawlResultsByOrigin);
router.delete("/crawl-results/:id", crawlController.deleteCrawlResult);

module.exports = router;
