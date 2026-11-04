import Database from "better-sqlite3";
import { z } from "zod";
import { closeDatabaseForTests, resolveDatabasePath } from "@/db";
import { applyHallMigration, previewHallMigration } from "@/db/hall-migration";
import { readJson, withApi, withMutationApi } from "@/lib/server/api";
import { configuredWorkspaceRoot, readProjectManifest } from "@/db/paths";
import { prepareHallMigrationLogos } from "@/lib/server/assets";

export const dynamic = "force-dynamic";

export async function GET() {
  return withApi(async () => {
    const db = new Database(resolveDatabasePath(), {readonly:true,fileMustExist:true});
    try { const root=configuredWorkspaceRoot(); return {preview:previewHallMigration(db),workspaceId:root ? readProjectManifest(root).workspaceId : undefined}; } finally { db.close(); }
  });
}

export async function POST(request:Request) {
  return withMutationApi(request,async () => {
    const decision = z.object({confirmed:z.literal(true),policy:z.literal("one-hall-per-schedule").default("one-hall-per-schedule")}).parse(await readJson(request));
    closeDatabaseForTests();
    const filename = resolveDatabasePath();
    const db = new Database(filename,{fileMustExist:true});
    try {
      const root=configuredWorkspaceRoot();
      const logoReferences=root ? await prepareHallMigrationLogos(db,root) : undefined;
      return applyHallMigration(db,filename,{...decision,logoReferences});
    } finally { db.close(); }
  });
}
