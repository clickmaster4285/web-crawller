import { useQuery } from "@tanstack/react-query";

import { getAnalyticsData, getWorkspaceData } from "@/lib/api";

/** Fetches the workspace record from the server API. */
export function useWorkspace() {
  const query = useQuery({
    queryKey: ["workspace"],
    queryFn: () => getWorkspaceData(),
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Fetches the dashboard analytics bundle from the server API. */
export function useAnalytics() {
  const query = useQuery({
    queryKey: ["analytics"],
    queryFn: () => getAnalyticsData(),
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
