import { createFileRoute } from "@tanstack/react-router";

import { DashboardPage } from "@/features/dashboard";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Overview — Parity Competitive Intelligence" },
      {
        name: "description",
        content:
          "Live overview of monitored products, competitor price movements, catalogue gaps and stock changes across your market.",
      },
      { property: "og:title", content: "Overview — Parity Competitive Intelligence" },
      {
        property: "og:description",
        content: "Live overview of monitored products, competitor price movements, catalogue gaps and stock changes across your market.",
      },
    ],
  }),
  component: DashboardPage,
});
