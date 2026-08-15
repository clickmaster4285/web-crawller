import { createFileRoute } from "@tanstack/react-router";
import { FileSpreadsheet, FileText, FileDown } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { useReports } from "@/hooks/useData";

export const Route = createFileRoute("/_authenticated/reports/")({
  head: () => ({
    meta: [
      { title: "Reports — Parity" },
      {
        name: "description",
        content:
          "Daily, weekly, monthly, quarterly and annual competitive intelligence reports, exportable to Excel, CSV and PDF.",
      },
      { property: "og:title", content: "Reports — Parity" },
      {
        property: "og:description",
        content:
          "Scheduled competitive intelligence reports exportable to Excel, CSV and PDF.",
      },
    ],
  }),
  component: ReportsPage,
});

const contents = [
  "Price trends and volatility by category",
  "Competitor rankings and price index movement",
  "Category growth and assortment gaps",
  "Brand analysis with 90-day momentum",
  "Product additions, removals and reintroductions",
  "Inventory and availability changes",
];

function ReportsPage() {
  const { data: reports, isLoading, isError } = useReports();
  if (isError) return <ErrorState />;
  if (isLoading || !reports) return <LoadingState />;
  if (reports.length === 0) {
    return (
      <NoRealDataState
        title="No reports yet"
        description="Reports are compiled from real crawl snapshots by a report generator that isn't built yet. The raw data those reports would use is already being captured on the Sources page."
      />
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Reporting"
        title="Reports"
        description="Scheduled reports are compiled from crawl snapshots, so every figure is reproducible against the exact data captured at that time."
        actions={
          <>
            <Button variant="outline">
              <FileSpreadsheet className="size-4" /> Excel
            </Button>
            <Button variant="outline">
              <FileDown className="size-4" /> CSV
            </Button>
            <Button>
              <FileText className="size-4" /> PDF
            </Button>
          </>
        }
      />

      <div className="grid gap-8 px-6 py-8 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Report</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Pages</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.period}
                  </TableCell>
                  <TableCell className="numeric text-right">
                    {r.pages}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant={r.status === "Ready" ? "secondary" : "outline"}
                      className="font-normal"
                    >
                      {r.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="h-fit p-5">
          <h2 className="text-lg">Every report includes</h2>
          <ul className="mt-4 space-y-2.5">
            {contents.map((c) => (
              <li key={c} className="flex gap-2 text-sm text-muted-foreground">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-accent" />
                {c}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
