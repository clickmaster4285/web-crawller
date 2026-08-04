import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Download, Search } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LoadingState,
  ErrorState,
  NoRealDataState,
} from "@/components/common/states";
import { useMatchedProducts } from "@/hooks/useData";
import { usePagination } from "@/hooks/usePagination";
import { PaginationBar } from "@/components/common/pagination";
import { gbp } from "@/utils/formatCurrency";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/products/")({
  head: () => ({
    meta: [
      { title: "Matched products — Parity" },
      {
        name: "description",
        content:
          "Every product matched across your catalogue and competitor stores, with confidence scores and price gaps.",
      },
      { property: "og:title", content: "Matched products — Parity" },
      {
        property: "og:description",
        content:
          "Product-level price gaps, match confidence and availability across competitor stores.",
      },
    ],
  }),
  component: ProductsPage,
});

type Filter = "all" | "cheaper" | "missing" | "low-confidence";

function ProductsPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const { data: matchedProducts, isLoading, isError } = useMatchedProducts();

  const rows = useMemo(() => {
    return (matchedProducts ?? []).filter((p) => {
      const matchesQuery =
        !query ||
        [p.name, p.brand, p.category, p.sku, p.gtin]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase());
      if (!matchesQuery) return false;
      if (filter === "cheaper")
        return p.yourPrice !== null && p.competitorPrice < p.yourPrice;
      if (filter === "missing") return p.yourPrice === null;
      if (filter === "low-confidence") return p.confidence < 90;
      return true;
    });
  }, [query, filter, matchedProducts]);

  const pager = usePagination(rows, 50);

  if (isError) return <ErrorState />;
  if (isLoading || !matchedProducts) return <LoadingState />;
  if (matchedProducts.length === 0) {
    return (
      <NoRealDataState
        title="No matched products yet"
        description="Matched products need the matching layer (GTIN > SKU > slug > fuzzy) plus your own catalogue. Crawled competitor products already exist on the Sources page and will flow here once matching is connected."
      />
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Matching engine"
        title="Matched products"
        description="Matches are resolved in priority order — GTIN, UPC, EAN, MPN, manufacturer SKU, brand plus model, then AI similarity. Anything below 80% confidence is queued for manual review."
        actions={
          <Button variant="outline">
            <Download className="size-4" /> Export CSV
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, brand, SKU or GTIN"
            className="pl-9"
          />
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="cheaper">They're cheaper</TabsTrigger>
            <TabsTrigger value="missing">You don't sell</TabsTrigger>
            <TabsTrigger value="low-confidence">Needs review</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} products
        </span>
      </div>

      <div className="px-6 py-8">
        <div className="border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[280px]">Product</TableHead>
                <TableHead>Match</TableHead>
                <TableHead className="text-right">You</TableHead>
                <TableHead className="text-right">Competitor</TableHead>
                <TableHead className="text-right">Gap</TableHead>
                <TableHead className="text-right">24h</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pager.pageItems.map((p) => {
                const gap =
                  p.yourPrice === null ? null : p.competitorPrice - p.yourPrice;
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <p className="font-medium leading-snug">{p.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {p.brand} · {p.category} · GTIN {p.gtin}
                      </p>
                    </TableCell>
                    <TableCell className="w-40">
                      <p className="text-xs">{p.matchMethod}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <Progress value={p.confidence} className="h-1" />
                        <span className="numeric text-[11px] text-muted-foreground">
                          {p.confidence}%
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {p.competitor}
                      </p>
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {p.yourPrice === null ? (
                        <span className="text-xs text-muted-foreground">
                          Not stocked
                        </span>
                      ) : (
                        gbp(p.yourPrice)
                      )}
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {gbp(p.competitorPrice)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "numeric text-right",
                        gap !== null && gap < 0 && "text-destructive",
                        gap !== null && gap > 0 && "text-success",
                      )}
                    >
                      {gap === null ? "—" : `${gap > 0 ? "+" : ""}${gbp(gap)}`}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "numeric text-right text-xs",
                        p.priceChange24h < 0 && "text-destructive",
                        p.priceChange24h > 0 && "text-success",
                      )}
                    >
                      {p.priceChange24h === 0
                        ? "—"
                        : `${p.priceChange24h > 0 ? "+" : ""}${gbp(p.priceChange24h)}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationBar
            page={pager.page}
            totalPages={pager.totalPages}
            total={pager.total}
            pageSize={pager.pageSize}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
          />
        </div>
      </div>
    </div>
  );
}
