import { createFileRoute } from "@tanstack/react-router";

import { PricingPage } from "@/features/pricing";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Price intelligence — Parity" },
      {
        name: "description",
        content:
          "Track every competitor price change: daily movement, volatility, lowest-ever prices and the products creating your biggest pricing gaps.",
      },
      { property: "og:title", content: "Price intelligence — Parity" },
      {
        property: "og:description",
        content: "Daily price movement, volatility and the widest pricing gaps in your matched catalogue.",
      },
    ],
  }),
  component: PricingPage,
});
