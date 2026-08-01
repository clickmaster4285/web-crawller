import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/sources/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/_authenticated/sources/"!</div>;
}
