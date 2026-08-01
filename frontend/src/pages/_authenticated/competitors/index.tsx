import { createFileRoute } from "@tanstack/react-router";
import { Globe, RefreshCcw } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LoadingState,
  ErrorState,
  NoRealDataState,
} from "@/components/common/states";
import { useCompetitors } from "@/hooks/useData";

export const Route = createFileRoute("/_authenticated/competitors/")({
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
        content:
          "Monitor competitor stores, crawl schedules and catalogue movement in one place.",
      },
    ],
  }),
  component: CompetitorsPage,
});

const statusTone: Record<string, "secondary" | "destructive" | "outline"> = {
  active: "secondary",
  paused: "outline",
  error: "destructive",
};

function CompetitorsPage() {
  const { data: competitors, isLoading, isError } = useCompetitors();
  if (isError) return <ErrorState />;
  if (isLoading || !competitors) return <LoadingState />;
  if (competitors.length === 0) {
    return (
      <NoRealDataState
        title="No competitors crawled yet"
        description="Competitors are listed from real saved crawls — one per crawled origin. Run a crawl on the Sources page and the store will appear here automatically."
      />
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Sources"
        title="Competitors"
        description="Four stores under continuous observation. Each source is discovered through sitemaps, category crawling and structured product data, then normalised into the same schema as your own catalogue."
        actions={
          <>
            <Button variant="outline">
              <RefreshCcw className="size-4" /> Recrawl all
            </Button>
            <Button>
              <Globe className="size-4" /> Add competitor
            </Button>
          </>
        }
      />

      <div className="grid gap-px bg-border lg:grid-cols-4">
        {competitors.map((c) => (
          <div key={c.id} className="bg-card p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg leading-tight">{c.name}</h2>
                <p className="text-xs text-muted-foreground">{c.website}</p>
              </div>
              <Badge
                variant={statusTone[c.status]}
                className="font-normal capitalize"
              >
                {c.status}
              </Badge>
            </div>
            <dl className="mt-4 space-y-1.5 text-xs">
              {[
                ["Products", c.products.toLocaleString()],
                ["New today", `+${c.newToday}`],
                ["Price changes", c.priceChanges.toString()],
                ["Out of stock", c.outOfStock.toString()],
                ["Price index", c.avgPriceIndex.toString()],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="numeric">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <div className="px-6 py-8">
        <div className="border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead className="text-right">Last crawl</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {competitors.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.country}
                  </TableCell>
                  <TableCell className="numeric">{c.currency}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.language}
                  </TableCell>
                  <TableCell>{c.platform}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.industry}
                  </TableCell>
                  <TableCell>{c.frequency}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {c.lastCrawl}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
