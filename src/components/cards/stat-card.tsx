import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  delta,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  delta?: string;
  hint?: string;
  tone?: "neutral" | "positive" | "negative" | "accent";
}) {
  return (
    <div className="flex flex-col justify-between border border-border bg-card p-5">
      <p className="label-caps">{label}</p>
      <p
        className={cn(
          "numeric mt-4 text-3xl leading-none",
          tone === "accent" && "text-accent",
          tone === "positive" && "text-success",
          tone === "negative" && "text-destructive",
        )}
      >
        {value}
      </p>
      <div className="mt-2 flex items-baseline gap-2">
        {delta ? (
          <span
            className={cn(
              "numeric text-xs",
              delta.startsWith("-") ? "text-destructive" : "text-success",
            )}
          >
            {delta}
          </span>
        ) : null}
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
}

export function SectionTitle({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <h2 className="text-xl">{children}</h2>
      {aside}
    </div>
  );
}
