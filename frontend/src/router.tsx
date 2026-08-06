import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Reuse cached data across page navigations instead of refetching
        // everything on every mount — crawl-derived data only changes when a
        // crawl runs, and mutations invalidate the relevant queries. Window
        // focus still refetches, but only queries older than staleTime, so a
        // quick tab switch never triggers a refetch storm.
        staleTime: 30_000,
        retry: 1,
        gcTime: 10 * 60_000,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Hover-preloaded data stays usable for the same window as the query
    // cache, so navigating to a preloaded route doesn't refetch immediately.
    defaultPreloadStaleTime: 30_000,
  });

  return router;
};
