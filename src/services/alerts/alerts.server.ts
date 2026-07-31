import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient<any, "public", any>;

export type AlertInput = {
  workspace_id: string;
  competitor_id: string | null;
  product_id: string | null;
  type: "price_drop" | "price_rise" | "stock" | "new_product" | "removed";
  title: string;
  detail: string;
  severity: "low" | "medium" | "high";
};

type Rule = { type: string; enabled: boolean; threshold_pct: number; categories: string[] };

export async function loadAlertRules(admin: Admin, workspaceId: string) {
  const { data } = await admin
    .from("alert_rules")
    .select("type, enabled, threshold_pct, categories")
    .eq("workspace_id", workspaceId);
  return (data ?? []) as Rule[];
}

export function ruleFor(rules: Rule[], type: string): Rule | null {
  return rules.find((r) => r.type === type) ?? null;
}

function categoryAllowed(rule: Rule | null, category: string | null) {
  if (!rule || rule.categories.length === 0) return true;
  if (!category) return false;
  return rule.categories.some((c) => c.toLowerCase() === category.toLowerCase());
}

/** Compare a freshly scraped product against its stored state and produce alerts. */
export function evaluateProductChange(args: {
  rules: Rule[];
  workspaceId: string;
  competitorId: string | null;
  competitorName: string;
  productId: string;
  name: string;
  category: string | null;
  previousPrice: number | null;
  previousStock: string | null;
  price: number | null;
  stock: string;
  isNew: boolean;
  currency: string;
}): AlertInput[] {
  const alerts: AlertInput[] = [];
  const base = {
    workspace_id: args.workspaceId,
    competitor_id: args.competitorId,
    product_id: args.productId,
  };
  const money = (value: number | null) =>
    value === null ? "—" : `${args.currency === "GBP" ? "£" : ""}${value.toFixed(2)}`;

  if (args.isNew) {
    const rule = ruleFor(args.rules, "new_product");
    if (rule?.enabled && categoryAllowed(rule, args.category)) {
      alerts.push({
        ...base,
        type: "new_product",
        title: `${args.competitorName} launched ${args.name}`,
        detail: `New product listed at ${money(args.price)}${args.category ? ` in ${args.category}` : ""}.`,
        severity: "medium",
      });
    }
    return alerts;
  }

  if (args.previousPrice !== null && args.price !== null && args.previousPrice !== args.price) {
    const changePct = ((args.price - args.previousPrice) / args.previousPrice) * 100;
    const type = changePct < 0 ? "price_drop" : "price_rise";
    const rule = ruleFor(args.rules, type);
    if (
      rule?.enabled &&
      categoryAllowed(rule, args.category) &&
      Math.abs(changePct) >= Number(rule.threshold_pct ?? 0)
    ) {
      alerts.push({
        ...base,
        type,
        title: `${args.competitorName} ${changePct < 0 ? "dropped" : "raised"} ${args.name} by ${Math.abs(changePct).toFixed(1)}%`,
        detail: `${money(args.previousPrice)} → ${money(args.price)}.`,
        severity: Math.abs(changePct) >= 10 ? "high" : "medium",
      });
    }
  }

  if (args.previousStock && args.previousStock !== args.stock) {
    const rule = ruleFor(args.rules, "stock");
    if (rule?.enabled && categoryAllowed(rule, args.category)) {
      const readable = args.stock.replace(/_/g, " ");
      alerts.push({
        ...base,
        type: "stock",
        title: `${args.name} is now ${readable} at ${args.competitorName}`,
        detail: `Availability changed from ${args.previousStock.replace(/_/g, " ")} to ${readable}.`,
        severity: args.stock === "out_of_stock" ? "high" : "low",
      });
    }
  }

  return alerts;
}

export function evaluateRemoval(args: {
  rules: Rule[];
  workspaceId: string;
  competitorId: string | null;
  competitorName: string;
  productId: string;
  name: string;
  category: string | null;
}): AlertInput[] {
  const rule = ruleFor(args.rules, "removed");
  if (!rule?.enabled || !categoryAllowed(rule, args.category)) return [];
  return [
    {
      workspace_id: args.workspaceId,
      competitor_id: args.competitorId,
      product_id: args.productId,
      type: "removed",
      title: `${args.competitorName} removed ${args.name}`,
      detail: "The product is no longer listed in the latest crawl.",
      severity: "low",
    },
  ];
}

export async function saveAlerts(admin: Admin, alerts: AlertInput[]) {
  if (alerts.length === 0) return;
  const { error } = await admin.from("alerts").insert(alerts);
  if (error) console.error("Failed to save alerts:", error.message);
}
