// Purge junk-segment rows from EVERY store (blog/policy/collection/landing
// pages that slipped in before the discovery+ingest fixes). Same classifier
// as the crawler's hasJunkSegment — imported from the SINGLE source of truth
// (frontend/src/lib/crawler/discover/junk-segments.ts) so this tool can never
// drift from the crawler/ingest guard. Dry-run by default; --apply to commit.
const path = require("path");
const { pathToFileURL } = require("url");
const { createRequire } = require("module");
const req = createRequire(path.join(process.cwd(), "backend", "x.js"));
req("dotenv").config({ path: path.join(process.cwd(), ".env") });

const APPLY = process.argv.includes("--apply");

const junkModuleUrl = pathToFileURL(
  path.join(process.cwd(), "../frontend/src/lib/crawler/discover/junk-segments.ts")
).href;

(async () => {
  const { hasJunkSegment } = await import(junkModuleUrl);
  const mongoose = req("mongoose");
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const origins = await db.collection("products").distinct("origin");
  const allJunk = [];
  for (const origin of origins) {
    const rows = await db
      .collection("products")
      .find({ origin, lastSeenAt: { $gt: new Date(0) } })
      .limit(50000)
      .toArray();
    for (const p of rows) {
      if (hasJunkSegment(p.url)) allJunk.push({ origin, p });
    }
  }
  const host = (o) => String(o).split("/")[2] || o;
  console.log("total junk-segment rows:", allJunk.length);
  for (const { origin, p } of allJunk.slice(0, 20))
    console.log("  ", host(origin).padEnd(24), "|", String(p.name || "").slice(0, 40).padEnd(42), "|", String(p.url || "").slice(0, 65));

  if (!APPLY) {
    console.log("\nDRY-RUN — pass --apply to soft-delete these rows.");
    await mongoose.disconnect();
    return;
  }
  const ids = allJunk.map(({ p }) => p._id);
  const res = await db.collection("products").updateMany(
    { _id: { $in: ids } },
    { $set: { available: false, lastSeenAt: new Date(0) } }
  );
  console.log("\nAPPLIED: soft-deleted", res.modifiedCount, "junk rows across all stores.");
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
