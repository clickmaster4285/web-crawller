import { createFileRoute } from "@tanstack/react-router";

import { CompetitorsPage } from "@/features/competitors";

export const Route = createFileRoute("/competitors")({
  head: () => ({
    meta: [
      { title: "Competitors — Parity" },
      {
        name: "description",
        content:
          "Every competitor store you monitor: platform, crawl frequency, catalogue size, price index and last crawl status.",
      },
      { property: "og:title", content: "Competitors — Parity" },
      {
        property: "og:description",
        content: "Monitor competitor stores, crawl schedules and catalogue movement in one place.",
      },
    ],
  }),
  component: CompetitorsPage,
});
