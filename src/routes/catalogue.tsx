import { createFileRoute } from "@tanstack/react-router";

import { CataloguePage } from "@/features/catalogue";

export const Route = createFileRoute("/catalogue")({
  head: () => ({
    meta: [
      { title: "Catalogue gaps — Parity" },
      {
        name: "description",
        content:
          "See which categories and brands competitors cover and you don't, ranked by gap size and competitor growth rate.",
      },
      { property: "og:title", content: "Catalogue gaps — Parity" },
      {
        property: "og:description",
        content: "Category and brand coverage gaps between your catalogue and the market.",
      },
    ],
  }),
  component: CataloguePage,
});
