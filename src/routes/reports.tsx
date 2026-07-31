import { createFileRoute } from "@tanstack/react-router";

import { ReportsPage } from "@/features/reports";

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Reports — Parity" },
      {
        name: "description",
        content:
          "Daily, weekly, monthly, quarterly and annual competitive intelligence reports, exportable to Excel, CSV and PDF.",
      },
      { property: "og:title", content: "Reports — Parity" },
      {
        property: "og:description",
        content: "Scheduled competitive intelligence reports exportable to Excel, CSV and PDF.",
      },
    ],
  }),
  component: ReportsPage,
});
