import { http } from "@/lib/http";
import type { Workspace } from "@/types";

/** Fetches the workspace record from the server API. */
export const getWorkspaceData = () => http.get<Workspace>("/data/workspace");
