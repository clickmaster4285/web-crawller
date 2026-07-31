import { createFileRoute } from "@tanstack/react-router";

import { SourcesPage } from "@/features/settings";

export const Route = createFileRoute("/sources")({
  head: () => ({
    meta: [
      { title: "Sources & crawling — Parity" },
      {
        name: "description",
        content:
          "Connect your store, verify ownership, and configure discovery, crawl frequency, page limits and robots.txt behaviour.",
      },
      { property: "og:title", content: "Sources & crawling — Parity" },
      {
        property: "og:description",
        content: "Connect and verify your store, then configure crawl frequency and discovery rules.",
      },
    ],
  }),
  component: SourcesPage,
});
