import { useCallback, useState } from "react";

/**
 * useState backed by localStorage, so an accidental refresh (or even a full
 * browser restart) restores the last value instead of resetting it — used by
 * the Sources page so a live crawl's job id and config survive a reload.
 *
 * SSR-safe: on the server there is no `window`, so the initial value is used
 * and writes are no-ops. Values are JSON-serialized (strings, numbers,
 * booleans, null all round-trip fine).
 */
export function useLocalStorageState<T>(
  key: string,
  initialValue: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const raw = window.localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initialValue;
    } catch {
      // Corrupt/unreadable value — fall back to the initial value.
      return initialValue;
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        try {
          if (typeof window !== "undefined") {
            window.localStorage.setItem(key, JSON.stringify(resolved));
          }
        } catch {
          // Storage full/unavailable — state still works in-memory.
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}
