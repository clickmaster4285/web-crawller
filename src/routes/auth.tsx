import { createFileRoute } from "@tanstack/react-router";

import { AuthPage } from "@/features/auth/pages/AuthPage";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Parity" },
      {
        name: "description",
        content:
          "Sign in to your Parity workspace to track competitor prices, catalogue gaps and stock changes from live crawls.",
      },
      { property: "og:title", content: "Sign in — Parity" },
      {
        property: "og:description",
        content: "Access your private competitive intelligence workspace.",
      },
    ],
  }),
  component: AuthPage,
});
