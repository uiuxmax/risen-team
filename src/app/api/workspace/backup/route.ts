import { hallsEnabled, exportHalls, importHalls, normalizeHallPackageLogos } from "@/lib/server/halls";
import { z } from "zod";
import { readJson, withApi, withMutationApi } from "@/lib/server/api";
import { exportBackup, importBackup } from "@/lib/server/admin";
import { listSafetyBackups } from "@/lib/server/backups";

export const dynamic = "force-dynamic";

const importSchema = z.object({
  mode: z.enum(["merge", "replace"]).default("merge"),
  backup: z.unknown(),
  targetId: z.string().min(1).optional(),
});

export async function GET(request: Request) {
  return withApi(async () => {
    if (new URL(request.url).searchParams.get("safety") === "1") {
      return { backups: listSafetyBackups() };
    }
    const hallId = new URL(request.url).searchParams.get("hallId");
    return { backup: hallsEnabled() ? exportHalls(hallId ? [hallId] : undefined) : exportBackup() };
  });
}

export async function POST(request: Request) {
  return withMutationApi(request, async () => {
    const body = importSchema.parse(await readJson(request));
    return hallsEnabled() ? importHalls(await normalizeHallPackageLogos(body.backup), body.mode, body.targetId) : importBackup(body.backup, body.mode);
  });
}
