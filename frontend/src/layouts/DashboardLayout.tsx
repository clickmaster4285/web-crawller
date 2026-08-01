import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";

export function DashboardLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
