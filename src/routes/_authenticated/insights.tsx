import { createFileRoute } from "@tanstack/react-router";

import { InsightsPage } from "@/features/insights";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({
    meta: [
      { title: "AI insights — Parity" },
      {
        name: "description",
        content:
          "Plain-English business insights generated from every crawl: pricing exposure, assortment gaps, brand momentum and supply signals.",
      },
      { property: "og:title", content: "AI insights — Parity" },
      {
        property: "og:description",
        content: "AI-written summaries of pricing exposure, assortment gaps and brand momentum.",
      },
    ],
  }),
  component: InsightsPage,
});
