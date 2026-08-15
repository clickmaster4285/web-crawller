import { useEffect, useRef, useState } from "react";
import { ChevronDown, Terminal } from "lucide-react";

import type { CrawlLogLine } from "@/lib/crawl";
import { cn } from "@/lib/utils";

/** HH:MM:SS (local) — stable across SSR/hydration, no locale coupling. */
function logTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function levelClass(level: CrawlLogLine["level"]): string {
  switch (level) {
    case "warn":
      return "text-amber-600";
    case "error":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Run log — the crawl's structured, timestamped story (Phase 5
 * observability). Fed by the engine's onLog callback + the worker's own
 * lifecycle lines, flushed to the job's capped `progress.log`; the UI polls
 * the job and appends lines live as they arrive. Compact and collapsible —
 * newest at the bottom, auto-scrolled while open.
 */
export function RunLog({
  lines,
  className,
  title = "Run log",
  defaultOpen = false,
}: {
  lines: CrawlLogLine[];
  className?: string;
  title?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const listRef = useRef<HTMLUListElement>(null);

  // Auto-scroll the container to the newest line while open and growing
  // (scrollIntoView would scroll the whole page — scroll the list instead).
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [open, lines.length]);

  if (!lines || lines.length === 0) return null;

  const warnCount = lines.filter((l) => l.level !== "info").length;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left text-xs"
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="label-caps">{title}</span>
        <span className="text-muted-foreground">
          {lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}
        </span>
        {warnCount > 0 ? (
          <span className="ml-auto font-medium text-amber-600">
            {warnCount} warning{warnCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </button>
      {open ? (
        <ul
          ref={listRef}
          className="mt-2 max-h-48 space-y-1 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-snug"
        >
          {lines.map((line, i) => (
            <li
              key={`${line.at}-${i}`}
              className={cn("flex gap-2", levelClass(line.level))}
            >
              <span className="shrink-0 text-muted-foreground/60">
                {logTime(line.at)}
              </span>
              <span className="min-w-0 break-words">{line.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
