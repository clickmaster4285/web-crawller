import { createFileRoute } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { insights } from "@/data/mock";

export const Route = createFileRoute("/_authenticated/insights/")({
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

function InsightsPage() {
  return (
    <div>
      <PageHeader
        eyebrow="AI business intelligence"
        title="What today's data means"
        description="Each crawl snapshot is compared against history and across competitors, then summarised into decisions you can act on before the next scan."
        actions={
          <Button>
            <Sparkles className="size-4" /> Regenerate
          </Button>
        }
      />

      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="space-y-px bg-border">
          {insights.map((i, index) => (
            <article key={i.id} className="bg-card p-8">
              <div className="flex items-center gap-3">
                <span className="numeric text-xs text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <Badge variant="secondary" className="font-normal capitalize">
                  {i.category}
                </Badge>
              </div>
              <h2 className="mt-3 text-2xl leading-snug">{i.headline}</h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{i.body}</p>
              <p className="numeric rule-top mt-5 pt-3 text-xs text-accent">{i.impact}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
