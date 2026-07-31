import type { SupabaseClient } from "@supabase/supabase-js";

import { discoverProductUrls, scrapeProducts } from "./firecrawl.server";
import {
  evaluateProductChange,
  evaluateRemoval,
  loadAlertRules,
  saveAlerts,
  type AlertInput,
} from "../alerts/alerts.server";

type Admin = SupabaseClient<any, "public", any>;

export type CrawlTarget = {
  workspaceId: string;
  competitorId: string | null;
  competitorName: string;
  website: string;
  maxPages: number;
  currency: string;
  trigger: "manual" | "scheduled";
};

export type CrawlResult = {
  runId: string;
  status: "success" | "failed";
  pagesCrawled: number;
  productsFound: number;
  productsChanged: number;
  alertsCreated: number;
  error?: string;
};

/** Crawl one store, persist products + price snapshots, and raise alerts for changes. */
export async function runCrawl(admin: Admin, target: CrawlTarget): Promise<CrawlResult> {
  const { data: run, error: runError } = await admin
    .from("crawl_runs")
    .insert({
      workspace_id: target.workspaceId,
      competitor_id: target.competitorId,
      status: "running",
      trigger: target.trigger,
    })
    .select("id")
    .single();

  if (runError || !run) throw new Error(runError?.message ?? "Could not start crawl");
  const runId = run.id as string;

  try {
    const maxPages = Math.min(Math.max(target.maxPages, 1), 40);
    const urls = await discoverProductUrls(target.website, maxPages);
    const scraped = await scrapeProducts(urls);

    const rules = await loadAlertRules(admin, target.workspaceId);

    const existingQuery = admin
      .from("products")
      .select("id, url, name, price, stock, category, is_active")
      .eq("workspace_id", target.workspaceId);
    const { data: existingRows } = target.competitorId
      ? await existingQuery.eq("competitor_id", target.competitorId)
      : await existingQuery.is("competitor_id", null);

    const existing = new Map<string, any>();
    for (const row of existingRows ?? []) if (row.url) existing.set(row.url, row);

    const alerts: AlertInput[] = [];
    const snapshots: Array<Record<string, unknown>> = [];
    const seenUrls = new Set<string>();
    let changed = 0;

    for (const product of scraped) {
      seenUrls.add(product.url);
      const prior = existing.get(product.url);
      const payload = {
        workspace_id: target.workspaceId,
        competitor_id: target.competitorId,
        name: product.name,
        brand: product.brand,
        category: product.category,
        sku: product.sku,
        gtin: product.gtin,
        url: product.url,
        image_url: product.imageUrl,
        currency: product.currency ?? target.currency,
        price: product.price,
        stock: product.stock,
        last_seen_at: new Date().toISOString(),
        is_active: true,
      };

      let productId: string | null = null;
      if (prior) {
        const { data } = await admin
          .from("products")
          .update(payload)
          .eq("id", prior.id)
          .select("id")
          .single();
        productId = data?.id ?? prior.id;
      } else {
        const { data } = await admin.from("products").insert(payload).select("id").single();
        productId = data?.id ?? null;
      }
      if (!productId) continue;

      snapshots.push({
        workspace_id: target.workspaceId,
        product_id: productId,
        price: product.price,
        stock: product.stock,
      });

      const priorPrice = prior?.price === null || prior?.price === undefined ? null : Number(prior.price);
      if (!prior || priorPrice !== product.price || prior.stock !== product.stock) changed += 1;

      alerts.push(
        ...evaluateProductChange({
          rules,
          workspaceId: target.workspaceId,
          competitorId: target.competitorId,
          competitorName: target.competitorName,
          productId,
          name: product.name,
          category: product.category,
          previousPrice: priorPrice,
          previousStock: prior?.stock ?? null,
          price: product.price,
          stock: product.stock,
          isNew: !prior,
          currency: target.currency,
        }),
      );
    }

    if (snapshots.length > 0) await admin.from("price_snapshots").insert(snapshots);

    // Products that disappeared from the listing
    for (const [url, row] of existing) {
      if (seenUrls.has(url) || row.is_active === false) continue;
      await admin.from("products").update({ is_active: false }).eq("id", row.id);
      alerts.push(
        ...evaluateRemoval({
          rules,
          workspaceId: target.workspaceId,
          competitorId: target.competitorId,
          competitorName: target.competitorName,
          productId: row.id,
          name: row.name,
          category: row.category,
        }),
      );
    }

    await saveAlerts(admin, alerts);

    await admin
      .from("crawl_runs")
      .update({
        status: "success",
        pages_crawled: urls.length,
        products_found: scraped.length,
        products_changed: changed,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    if (target.competitorId) {
      await admin
        .from("competitors")
        .update({ last_crawl_at: new Date().toISOString() })
        .eq("id", target.competitorId);
    } else {
      await admin
        .from("workspaces")
        .update({ last_scan_at: new Date().toISOString() })
        .eq("id", target.workspaceId);
    }

    return {
      runId,
      status: "success",
      pagesCrawled: urls.length,
      productsFound: scraped.length,
      productsChanged: changed,
      alertsCreated: alerts.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown crawl error";
    await admin
      .from("crawl_runs")
      .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    return {
      runId,
      status: "failed",
      pagesCrawled: 0,
      productsFound: 0,
      productsChanged: 0,
      alertsCreated: 0,
      error: message,
    };
  }
}
