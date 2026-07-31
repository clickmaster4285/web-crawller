import { createFileRoute } from "@tanstack/react-router";

import { ProductsPage } from "@/features/products";

export const Route = createFileRoute("/_authenticated/products")({
  head: () => ({
    meta: [
      { title: "Matched products — Parity" },
      {
        name: "description",
        content:
          "Every product matched across your catalogue and competitor stores, with confidence scores, price gaps, stock and delivery comparison.",
      },
      { property: "og:title", content: "Matched products — Parity" },
      {
        property: "og:description",
        content: "Product-level price gaps, match confidence and availability across competitor stores.",
      },
    ],
  }),
  component: ProductsPage,
});
