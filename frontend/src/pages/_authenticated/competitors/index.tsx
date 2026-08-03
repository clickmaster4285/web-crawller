import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Play, Plus, Trash2 } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { AddCompetitorDialog } from "@/components/competitors/add-competitor-dialog";
import { CompareStores } from "@/components/competitors/compare-stores";
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
import { ErrorState, LoadingState } from "@/components/common/states";
import { useCompetitors } from "@/hooks/useData";
import { deleteCompetitor } from "@/lib/api";
import { prefillCrawlerOrigin } from "@/utils/crawls";
import type { Competitor } from "@/types";

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

const statusTone: Record<
  Competitor["status"],
  "secondary" | "destructive" | "outline"
> = {
  active: "secondary",
  paused: "outline",
  error: "destructive",
  pending: "outline",
};

function CompetitorsPage() {
  const { data: competitors, isLoading, isError } = useCompetitors();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => deleteCompetitor(id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["competitors"] }),
  });

  /** Prefills the crawler page with this competitor's origin and navigates. */
  const crawlNow = (c: Competitor) => {
    prefillCrawlerOrigin(c.origin);
    navigate({ to: "/sources" });
  };

  if (isError) return <ErrorState />;
  if (isLoading || !competitors) return <LoadingState />;

  const hasAny = competitors.length > 0;

  return (
    <div>
      <PageHeader
        eyebrow="Sources"
        title="Competitors"
        description="Stores you monitor — added manually or discovered from crawls. Add a store, crawl it to capture its catalogue, then compare any two stores side by side."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" /> Add competitor
          </Button>
        }
      />

      {!hasAny ? (
        <div className="mx-6 my-10 border border-dashed border-border bg-card p-10 text-center">
          <h2 className="font-display text-2xl">No competitors yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Add a store you want to monitor — it appears instantly — or run a
            crawl, and the store will be added automatically from its saved
            result.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> Add competitor
            </Button>
            <Button asChild variant="outline">
              <Link to="/sources">
                <Play className="size-4" /> Run a crawl
              </Link>
            </Button>
          </div>
        </div>
      ) : null}

      {hasAny ? (
        <div className="grid gap-px bg-border px-6 pt-8 lg:grid-cols-4">
          {competitors.map((c) => (
            <div key={c.id} className="bg-card p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-lg leading-tight">
                    <span className="truncate">{c.name}</span>
                    {c.isMine ? (
                      <Badge
                        variant="secondary"
                        className="shrink-0 border-primary/40 font-normal"
                      >
                        Your store
                      </Badge>
                    ) : null}
                  </h2>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.website}
                  </p>
                </div>
                <Badge
                  variant={statusTone[c.status]}
                  className="shrink-0 font-normal capitalize"
                >
                  {c.status}
                </Badge>
              </div>
              {c.status === "pending" ? (
                <div className="mt-4 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {c.isMine
                      ? "Crawl your store to compare its catalogue against competitors."
                      : "Not crawled yet — capture its catalogue to start monitoring."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => crawlNow(c)}
                  >
                    <Play className="size-3.5" /> Crawl now
                  </Button>
                </div>
              ) : (
                <dl className="mt-4 space-y-1.5 text-xs">
                  {[
                    ["Products", c.products.toLocaleString()],
                    ["Out of stock", c.outOfStock.toString()],
                    ["Price index", c.avgPriceIndex.toString()],
                    ["Last crawl", c.lastCrawl],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="numeric truncate">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {hasAny ? (
        <div className="px-6 py-8">
          <div className="border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Products</TableHead>
                  <TableHead className="text-right">Last crawl</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {competitors.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        {c.name}
                        {c.isMine ? (
                          <Badge
                            variant="secondary"
                            className="border-primary/40 font-normal"
                          >
                            Your store
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.platform}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={statusTone[c.status]}
                        className="font-normal capitalize"
                      >
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {c.products.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {c.lastCrawl}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => crawlNow(c)}
                        >
                          <Play className="size-3.5" /> Crawl
                        </Button>
                        {c.manual ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${c.name}`}
                            className="text-muted-foreground hover:text-destructive"
                            disabled={
                              remove.isPending && remove.variables === c.id
                            }
                            onClick={() => remove.mutate(c.id)}
                          >
                            {remove.isPending && remove.variables === c.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      <div className="px-6 pb-8">
        <CompareStores />
      </div>

      <AddCompetitorDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
