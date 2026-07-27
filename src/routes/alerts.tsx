import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, PackagePlus, PackageMinus, Boxes, Tag } from "lucide-react";

import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { alerts } from "@/lib/demo-data";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — Parity" },
      {
        name: "description",
        content:
          "Real-time alerts for competitor price drops, new launches, delistings, stock changes and promotions across every monitored store.",
      },
      { property: "og:title", content: "Alerts — Parity" },
      {
        property: "og:description",
        content: "Price drops, launches, delistings and stock changes as they happen.",
      },
    ],
  }),
  component: Alerts,
});

const icons = {
  price_drop: ArrowDown,
  price_rise: ArrowUp,
  new_product: PackagePlus,
  removed: PackageMinus,
  stock: Boxes,
  discount: Tag,
};

const channels = [
  { id: "email", label: "Email digest", detail: "Daily at 08:00 to admin@abc.com", on: true },
  { id: "inapp", label: "In-app notifications", detail: "Instant, all severities", on: true },
  { id: "webhook", label: "Webhook", detail: "POST to hooks.abc.com/parity", on: true },
  { id: "slack", label: "Slack", detail: "#pricing-war channel", on: false },
  { id: "teams", label: "Microsoft Teams", detail: "Not connected", on: false },
];

function Alerts() {
  return (
    <div>
      <PageHeader
        eyebrow="Monitoring"
        title="Alerts"
        description="Every snapshot diff produces events. Set thresholds per type so only material movement reaches your team."
      />

      <div className="grid gap-8 px-6 py-8 lg:grid-cols-3">
        <ul className="divide-y divide-border border border-border bg-card lg:col-span-2">
          {alerts.map((a) => {
            const Icon = icons[a.type];
            return (
              <li key={a.id} className="flex gap-4 p-5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-sm bg-secondary">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{a.title}</p>
                    <Badge
                      variant={a.severity === "high" ? "destructive" : "secondary"}
                      className="font-normal capitalize"
                    >
                      {a.severity}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{a.detail}</p>
                  <p className="label-caps mt-2">
                    {a.competitor} · {a.time}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="h-fit border border-border bg-card p-5">
          <h2 className="text-lg">Delivery channels</h2>
          <p className="mt-1 text-xs text-muted-foreground">Where alerts are sent when a rule fires.</p>
          <ul className="mt-5 space-y-5">
            {channels.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-4">
                <div>
                  <Label htmlFor={c.id} className="text-sm">
                    {c.label}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{c.detail}</p>
                </div>
                <Switch id={c.id} defaultChecked={c.on} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
