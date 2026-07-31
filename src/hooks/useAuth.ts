import { useSyncExternalStore } from "react";
import type { MockUser } from "@/lib/mock-auth";
import { getUser, signOut as clearSession } from "@/lib/mock-auth";

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getSnapshot() {
  return getUser();
}

export function useAuth() {
  const user = useSyncExternalStore<MockUser | null>(subscribe, getSnapshot, () => null);
  return {
    user,
    loading: false,
    signOut: () => {
      clearSession();
      window.dispatchEvent(new Event("storage"));
    },
  };
}
