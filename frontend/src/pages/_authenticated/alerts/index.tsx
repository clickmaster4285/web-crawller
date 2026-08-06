import { createFileRoute, Link } from "@tanstack/react-router";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Boxes,
  CheckCheck,
  ExternalLink,
  Inbox,
  PackageMinus,
  PackagePlus,
  X,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { PaginationBar } from "@/components/common/pagination";
import {
  ErrorState,
  LoadingState,
  NoRealDataState,
} from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  dismissAlert,
  getAlertsData,
  markAlertRead,
  markAllAlertsRead,
  queryKeys,
} from "@/api";
import { cn } from "@/lib/utils";
import { formatCrawlDate } from "@/utils/crawls";
import { formatPrice } from "@/utils/format";
import type { AlertItem, AlertType, AlertsData } from "@/types";

export const Route = createFileRoute("/_authenticated/alerts/")({
  head: () => ({
    meta: [
      { title: "Alerts — Parity" },
      {
        name: "description",
        content:
          "Real-time alerts for competitor price drops, new launches, delistings, stock changes and promotions across every monitored store.",
      },
      { property: "og:title", content: "Alerts — Parity" },
      {
        property: "og:description",
        content:
          "Price drops, launches, delistings and stock changes as they happen.",
      },
    ],
  }),
  component: AlertsPage,
});

const icons: Record<AlertType, LucideIcon> = {
  price_drop: ArrowDown,
  price_rise: ArrowUp,
  new_product: PackagePlus,
  removed: PackageMinus,
  stock: Boxes,
};

const FILTERS: Array<{ id: AlertType | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "price_drop", label: "Price drops" },
  { id: "price_rise", label: "Price rises" },
  { id: "new_product", label: "New products" },
  { id: "removed", label: "Removed" },
  { id: "stock", label: "Stock" },
];

const PAGE_SIZE = 25;

function AlertsPage() {
  const queryClient = useQueryClient();
  const [type, setType] = useState<AlertType | "all">("all");
  const [page, setPage] = useState(1);

  // Server-side paginated feed (Phase 4 — derived from ProductEvent rows).
  // `keepPreviousData` keeps the old page rendered while the next one loads.
  const query = useQuery({
    queryKey: [...queryKeys.alerts, { type, page }],
    queryFn: () => getAlertsData({ type, page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  // Every mutation refreshes the feed (and the header unread count). The
  // optimistic updates below apply instantly; the refetch reconciles.
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.alerts });

  const readMutation = useMutation({
    mutationFn: markAlertRead,
    onSuccess: refresh,
  });
  const dismissMutation = useMutation({
    mutationFn: dismissAlert,
    onSuccess: refresh,
  });
  const readAllMutation = useMutation({
    mutationFn: markAllAlertsRead,
    onSuccess: refresh,
  });

  const patchAlerts = (fn: (data: AlertsData) => AlertsData) => {
    queryClient.setQueriesData<AlertsData>(
      { queryKey: queryKeys.alerts },
      (old) => (old ? fn(old) : old),
    );
  };

  const markRead = (id: string) => {
    patchAlerts((d) => ({
      ...d,
      unreadCount: Math.max(
        0,
        d.unreadCount - (d.alerts.some((a) => a.id === id && !a.read) ? 1 : 0),
      ),
      alerts: d.alerts.map((a) => (a.id === id ? { ...a, read: true } : a)),
    }));
    readMutation.mutate(id);
  };

  const dismiss = (id: string) => {
    const alert = query.data?.alerts.find((a) => a.id === id);
    patchAlerts((d) => ({
      ...d,
      total: Math.max(0, d.total - 1),
      unreadCount: Math.max(0, d.unreadCount - (alert && !alert.read ? 1 : 0)),
      alerts: d.alerts.filter((a) => a.id !== id),
    }));
    dismissMutation.mutate(id);
  };

  const markAllRead = () => {
    patchAlerts((d) => ({
      ...d,
      unreadCount: 0,
      alerts: d.alerts.map((a) => ({ ...a, read: true })),
    }));
    readAllMutation.mutate();
  };

  const data = query.data;
  if (query.isError) return <ErrorState />;
  if (query.isLoading || !data) return <LoadingState />;

  // No crawls have ever produced events — honest "build it" empty state.
  if (!data.hasAnyEvents) {
    return (
      <NoRealDataState
        title="No alerts yet"
        description="Alerts are generated from crawl snapshot diffs — price drops, new products, removals and stock changes. Run a crawl on any store and its next diff will start producing alerts here."
      />
    );
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const filteredEmpty = type !== "all" && data.alerts.length === 0;

  return (
    <div>
      <PageHeader
        eyebrow="Monitoring"
        title="Alerts"
        description="Every snapshot diff produces events — price moves with % and amount, new and removed products, and stock changes."
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant={data.unreadCount > 0 ? "destructive" : "secondary"}
              className="gap-1.5 font-normal"
            >
              <Bell className="size-3" />
              {data.unreadCount.toLocaleString()} unread
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={markAllRead}
              disabled={readAllMutation.isPending || data.unreadCount === 0}
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </Button>
          </div>
        }
      />

      <div className="space-y-5 px-6 py-8">
        {/* ── Type filter ─────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setType(f.id);
                setPage(1);
              }}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                type === f.id
                  ? "border-primary/40 bg-accent/10 font-medium text-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* ── Feed ────────────────────────────────────────────────────── */}
        {data.alerts.length > 0 ? (
          <ul className="divide-y divide-border border border-border bg-card">
            {data.alerts.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                onRead={markRead}
                onDismiss={dismiss}
              />
            ))}
          </ul>
        ) : filteredEmpty ? (
          <div className="flex flex-col items-center gap-2 border border-dashed border-border bg-muted/30 px-6 py-14 text-center">
            <Inbox className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No {filterLabel(type)} alerts</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Nothing matched this filter. Try another type, or dismissals may
              have cleared them.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setType("all")}
            >
              Show all alerts
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 border border-dashed border-border bg-muted/30 px-6 py-14 text-center">
            <Inbox className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No alerts to show</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Every alert has been dismissed. Run more crawls — each snapshot
              diff produces new events.
            </p>
          </div>
        )}

        <PaginationBar
          page={page}
          totalPages={totalPages}
          total={data.total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}

function AlertRow({
  alert: a,
  onRead,
  onDismiss,
}: {
  alert: AlertItem;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const Icon = icons[a.type];
  const drop = a.priceChangePct != null && a.priceChangePct < 0;
  const showPrice = a.priceChangePct != null || a.priceChangeAmount != null;

  return (
    <li
      className={cn(
        "group relative flex gap-4 p-5 transition-colors",
        !a.read && "cursor-pointer bg-accent/5 hover:bg-accent/10",
      )}
      onClick={() => {
        if (!a.read) onRead(a.id);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !a.read) {
          e.preventDefault();
          onRead(a.id);
        }
      }}
    >
      {/* Unread marker — a left accent that fades once read. */}
      <span
        className={cn(
          "absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary transition-opacity",
          a.read ? "opacity-0" : "opacity-100",
        )}
      />

      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-sm bg-secondary">
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{a.title}</p>
            <Badge
              variant={
                a.severity === "high"
                  ? "destructive"
                  : a.severity === "medium"
                    ? "outline"
                    : "secondary"
              }
              className="font-normal capitalize"
            >
              {a.severity}
            </Badge>
          </div>
          <button
            type="button"
            aria-label="Dismiss alert"
            className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(a.id);
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Price movement pill — % + amount, colored by direction. */}
        {showPrice ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            {a.priceChangePct != null ? (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold",
                  drop
                    ? "bg-success/10 text-success"
                    : "bg-warning/10 text-warning",
                )}
              >
                {drop ? "−" : "+"}
                {Math.abs(a.priceChangePct).toFixed(1)}%
              </span>
            ) : null}
            {a.priceChangeAmount != null ? (
              <span className="text-muted-foreground">
                {drop ? "cheaper by" : "more expensive by"}{" "}
                <span className="numeric text-foreground">
                  {formatPrice(Math.abs(a.priceChangeAmount))}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}

        <p className="mt-1 text-sm text-muted-foreground">{a.detail}</p>

        <p className="label-caps mt-2 flex items-center gap-1.5">
          <span>{a.competitor}</span>
          <span aria-hidden>·</span>
          <span>{formatCrawlDate(a.time)}</span>
          {a.productUrl ? (
            <a
              href={a.productUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-1 inline-flex items-center gap-0.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
              aria-label="View product on the store"
              onClick={(e) => {
                e.stopPropagation();
                if (!a.read) onRead(a.id);
              }}
            >
              <ExternalLink className="size-3" />
              view
            </a>
          ) : null}
        </p>
      </div>
    </li>
  );
}

function filterLabel(type: AlertType | "all"): string {
  return FILTERS.find((f) => f.id === type)?.label.toLowerCase() ?? "alerts";
}
