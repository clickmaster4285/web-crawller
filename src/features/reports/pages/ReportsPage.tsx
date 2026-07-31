import { FileSpreadsheet, FileText, FileDown } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reports } from "@/data/mock";


const contents = [
  "Price trends and volatility by category",
  "Competitor rankings and price index movement",
  "Category growth and assortment gaps",
  "Brand analysis with 90-day momentum",
  "Product additions, removals and reintroductions",
  "Inventory and availability changes",
];

export function ReportsPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Reporting"
        title="ReportsPage"
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
        <div className="border border-border bg-card lg:col-span-2">
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
                  <TableCell className="text-muted-foreground">{r.period}</TableCell>
                  <TableCell className="numeric text-right">{r.pages}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={r.status === "Ready" ? "secondary" : "outline"} className="font-normal">
                      {r.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="h-fit border border-border bg-card p-5">
          <h2 className="text-lg">Every report includes</h2>
          <ul className="mt-4 space-y-2.5">
            {contents.map((c) => (
              <li key={c} className="flex gap-2 text-sm text-muted-foreground">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-accent" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
