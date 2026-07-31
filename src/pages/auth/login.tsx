import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { AuthLayout } from "@/layouts/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROUTES } from "@/constants";
import { signIn } from "@/lib/mock-auth";

export const Route = createFileRoute("/auth/login")({
  head: () => ({
    meta: [
      { title: "Sign in — Parity" },
      {
        name: "description",
        content:
          "Sign in to your Parity workspace to track competitor prices, catalogue gaps and stock changes from live crawls.",
      },
      { property: "og:title", content: "Sign in — Parity" },
      {
        property: "og:description",
        content: "Access your private competitive intelligence workspace.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    signIn(email);
    toast.success("Signed in");
    await navigate({ to: ROUTES.overview });
  }

  return (
    <AuthLayout>
      <div className="border border-border bg-card p-6">
        <p className="label-caps">Parity</p>
        <h1 className="display-xl mt-2 text-3xl">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your competitive intelligence workspace, crawls and price history stay private to you.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Please wait…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          No account yet?{" "}
          <Link to={ROUTES.signup} className="underline underline-offset-4 hover:text-foreground">
            Create one
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
