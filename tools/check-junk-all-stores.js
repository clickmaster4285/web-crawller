// Run the junk classifier across every store: which catalogues still hold
// non-product rows (blog/policy/collection/category pages) right now?
// Classifier imported from the SINGLE source of truth — the crawler's
// junk-segments module — so this check can never drift from the crawler.
const path = require("path");
const { pathToFileURL } = require("url");
const { createRequire } = require("module");
const req = createRequire(path.join(process.cwd(), "backend", "x.js"));
req("dotenv").config({ path: path.join(process.cwd(), ".env") });

const junkModuleUrl = pathToFileURL(
  path.join(process.cwd(), "../frontend/src/lib/crawler/discover/junk-segments.ts")
).href;

(async () => {
  const {
    PRODUCT_BASE_RE,
    hasJunkSegment,
    isProductUrl
  } = await import(junkModuleUrl);
  const mongoose = req("mongoose");
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const origins = await db.collection("products").distinct("origin");
  console.log("=== junk-segment rows per store (active catalogue) ===");
  for (const origin of origins.sort()) {
    const rows = await db
      .collection("products")
      .find({ origin, lastSeenAt: { $gt: new Date(0) } })
      .limit(50000)
      .toArray();
    const baseCount = rows.filter((p) => PRODUCT_BASE_RE.test(p.url || "")).length;
    const baseDominant = baseCount > 0 && baseCount > rows.length * 0.6;
    const junk = rows.filter((p) => hasJunkSegment(p.url));
    // Non-base rows in base-dominant stores = landing pages (the urbanfitness class)
    const landing = baseDominant
      ? rows.filter((p) => !hasJunkSegment(p.url) && !isProductUrl(p.url) && !(p.gtin || p.sku))
      : [];
    const host = String(origin || "").split("/")[2] || origin;
    const flag =
      junk.length === 0 && landing.length === 0 ? "✅ clean" : "⚠️  has junk";
    console.log(
      `  ${flag}  ${host.padEnd(24)} active=${String(rows.length).padEnd(6)} baseDominant=${String(baseDominant).padEnd(5)} junkSeg=${String(junk.length).padEnd(4)} landingPages=${String(landing.length).padEnd(4)}`
    );
    if (junk.length > 0) {
      for (const j of junk.slice(0, 3))
        console.log("        junk:", String(j.name || "").slice(0, 45).padEnd(47), "|", String(j.url || "").slice(0, 70));
    }
    if (landing.length > 0) {
      for (const l of landing.slice(0, 3))
        console.log("        landing:", String(l.name || "").slice(0, 45).padEnd(47), "|", String(l.url || "").slice(0, 70));
    }
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
