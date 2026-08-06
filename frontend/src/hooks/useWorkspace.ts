import { useQuery } from "@tanstack/react-query";

import {
  getAnalyticsData,
  getWorkspaceData,
  MATCHER_STALE_TIME,
  queryKeys,
} from "@/api";

/** Fetches the workspace record from the server API. */
export function useWorkspace() {
  const query = useQuery({
    queryKey: queryKeys.workspace,
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
    queryKey: queryKeys.analytics,
    queryFn: () => getAnalyticsData(),
    staleTime: MATCHER_STALE_TIME,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
