import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { DashboardLayout } from "@/layouts/DashboardLayout";
import { ROUTES } from "@/constants";
import { getUser } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: () => {
    if (!getUser()) throw redirect({ to: ROUTES.login });
  },
  ssr: false,
  component: () => (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  ),
});
