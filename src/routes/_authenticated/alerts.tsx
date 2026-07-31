import { createFileRoute } from "@tanstack/react-router";

import { AlertsPage } from "@/features/alerts";

export const Route = createFileRoute("/_authenticated/alerts")({
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
  component: AlertsPage,
});
