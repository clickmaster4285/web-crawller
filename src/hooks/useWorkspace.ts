import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getWorkspace } from "@/features/workspace/services/workspace.functions";
import { getWorkspaceAnalytics } from "@/features/dashboard/services/analytics.functions";

export function useWorkspace() {
  const fetchWorkspace = useServerFn(getWorkspace);
  return useQuery({
    queryKey: ["workspace"],
    queryFn: () => fetchWorkspace(),
    staleTime: 60_000,
  });
}

export function useAnalytics() {
  const { data: workspace } = useWorkspace();
  const fetchAnalytics = useServerFn(getWorkspaceAnalytics);

  const query = useQuery({
    queryKey: ["analytics", workspace?.id],
    queryFn: () => fetchAnalytics({ data: { workspaceId: workspace!.id } }),
    enabled: Boolean(workspace?.id),
    staleTime: 30_000,
  });

  return { workspace, ...query };
}
