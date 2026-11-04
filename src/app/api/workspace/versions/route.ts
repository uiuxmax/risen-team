import { assertHallVersionContext, hallsEnabled, restoreHallVersion } from "@/lib/server/halls";
import { z } from "zod";
import { readJson, withApi, withMutationApi } from "@/lib/server/api";
import { createVersion, getVersionSnapshot, listVersions, restoreVersion } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  action: z.literal("create"),
  scheduleId: z.string().min(1),
  description: z.string().max(240).default("Керований знімок"),
});

const restoreSchema = z.object({
  action: z.literal("restore"),
  versionId: z.string().min(1),
});

const bodySchema = z.discriminatedUnion("action", [createSchema, restoreSchema]);

export async function GET(request: Request) {
  return withApi(async () => {
    const params = new URL(request.url).searchParams;
    const versionId = params.get("versionId");
    if (hallsEnabled()) assertHallVersionContext(params.get("hallId")??"",params.get("scheduleId")??undefined,versionId??undefined);
    if (versionId) return getVersionSnapshot(versionId);
    const scheduleId = params.get("scheduleId");
    if (!scheduleId) throw new Error("Не вказано розклад.");
    return { versions: listVersions(scheduleId) };
  });
}

export async function POST(request: Request) {
  return withMutationApi(request, async () => {
    const body = bodySchema.parse(await readJson(request));
    if (body.action === "create") {
      if (hallsEnabled()) assertHallVersionContext(new URL(request.url).searchParams.get("hallId")??"",body.scheduleId);
      const version = createVersion({ scheduleId: body.scheduleId, source: "manual", description: body.description });
      return { version };
    }
    const result = hallsEnabled() ? restoreHallVersion(new URL(request.url).searchParams.get("hallId") ?? "", body.versionId) : restoreVersion(body.versionId);
    return { restored: true, scheduleId: result.scheduleId, version: result.version };
  });
}
