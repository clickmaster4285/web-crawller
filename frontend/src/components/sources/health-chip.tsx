import {
  CircleCheck,
  CircleX,
  HeartPulse,
  ShieldAlert,
  Store,
} from "lucide-react";

import type { StoreHealthVerdict } from "@/lib/crawl";

/**
 * Shared store-health verdict chip (P4 store-health pass). Used by the
 * analysis panel banner, the Sources store profile, and the /crawls store
 * groups, so the verdict styling never drifts. Tone: success for healthy,
 * destructive for the expensive dead ends (no-products), warning for
 * fixable-but-risky (blocked / corporate), muted for unclear.
 */
const VERDICT_META: Record<
  StoreHealthVerdict,
  { label: string; tone: string; Icon: typeof HeartPulse }
> = {
  healthy: {
    label: "Healthy",
    tone: "bg-success/10 text-success",
    Icon: CircleCheck,
  },
  "no-products": {
    label: "No products",
    tone: "bg-destructive/10 text-destructive",
    Icon: CircleX,
  },
  blocked: {
    label: "Blocked",
    tone: "bg-warning/10 text-warning",
    Icon: ShieldAlert,
  },
  corporate: {
    label: "Corporate",
    tone: "bg-warning/10 text-warning",
    Icon: Store,
  },
  unclear: {
    label: "Unclear",
    tone: "bg-muted text-muted-foreground",
    Icon: HeartPulse,
  },
};

export function HealthChip({
  verdict,
  score,
}: {
  verdict: StoreHealthVerdict;
  /** Optional 0–100 confidence score — rendered beside the label. */
  score?: number;
}) {
  const { label, tone, Icon } = VERDICT_META[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}
    >
      <Icon className="size-3.5" />
      {label}
      {score != null ? (
        <span className="font-normal opacity-80">{score}</span>
      ) : null}
    </span>
  );
}
