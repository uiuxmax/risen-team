import { hallsEnabled, loadHallWorkspace } from "@/lib/server/halls";
import { configuredWorkspaceRoot, readProjectManifest } from "@/db/paths";
import { withApi } from "@/lib/server/api";
import { loadWorkspace } from "@/lib/server/workspace";
import { ensureSeeded } from "@/lib/server/seed";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApi(async () => {
    if (!hallsEnabled()) ensureSeeded();
    const scheduleId = new URL(request.url).searchParams.get("scheduleId") ?? undefined;
    const data = hallsEnabled() ? loadHallWorkspace(scheduleId) : loadWorkspace(scheduleId);
    const root = configuredWorkspaceRoot();
    if (root) data.workspaceId = readProjectManifest(root).workspaceId;
    return data;
  });
}
