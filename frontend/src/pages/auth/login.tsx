import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { AuthLayout } from "@/layouts/AuthLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROUTES } from "@/constants";
import { DEMO_CREDENTIALS, signIn } from "@/lib/auth";

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
  const [email, setEmail] = useState<string>(DEMO_CREDENTIALS.email);
  const [password, setPassword] = useState<string>(DEMO_CREDENTIALS.password);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await signIn(
        email.trim() || DEMO_CREDENTIALS.email,
        password || DEMO_CREDENTIALS.password,
      );
      toast.success("Signed in");
      await navigate({ to: ROUTES.overview });
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Could not sign in");
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <Card className="p-6">
        <p className="label-caps">Parity</p>
        <h1 className="display-xl mt-2 text-3xl">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your competitive intelligence workspace, crawls and price history stay
          private to you.
        </p>

        <div className="mt-6 flex items-start gap-2 rounded-sm border border-dashed border-border bg-muted/40 p-3">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-success" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Demo access —{" "}
            <span className="font-mono text-foreground">
              {DEMO_CREDENTIALS.email}
            </span>{" "}
            /{" "}
            <span className="font-mono text-foreground">
              {DEMO_CREDENTIALS.password}
            </span>
            . Create your own account via the backend{" "}
            <span className="font-mono">/api/auth/register</span> endpoint.
          </p>
        </div>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}
