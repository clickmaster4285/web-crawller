/** Formats a number as a plain price (max 2 decimals), e.g. `1249.5` → `1,249.5`. */
export function formatPrice(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Formats a duration in ms as `m:ss`. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
