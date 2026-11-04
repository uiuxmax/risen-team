import { getDb, resolveDatabasePath } from "@/db";
import { sql } from "drizzle-orm";
import { ensureSeeded } from "@/lib/server/seed";
import { configuredWorkspaceRoot, readProjectManifest } from "@/db/paths";
import { LATEST_SCHEMA_VERSION } from "@/db/migrations";
import { HallMigrationRequiredError } from "@/db/hall-migration";

export const dynamic = "force-dynamic";

/**
 * Stable application identity.
 *
 * The desktop launchers poll `/api/health` on the fixed loopback port before
 * they open a browser, so they must be able to distinguish this application
 * from any unrelated service that happens to occupy the same port. An
 * unrelated listener must never be adopted and never be killed — it is simply
 * reported to the operator. That decision depends entirely on this constant,
 * so it is:
 *
 * - never derived from the request, the hostname or the database contents;
 * - returned on the failure response too, so a launcher can still recognize a
 *   Risen instance whose database could not be opened (that is a startup
 *   failure worth surfacing, not evidence of a foreign service);
 * - mirrored by `scripts/prepare-portable.mjs`, which refuses to stage a
 *   portable bundle whose identity it cannot read back from this file.
 */
export const APP_IDENTITY = "risen-team-schedule-builder-v1";
export const LAUNCHER_PROTOCOL_VERSION = 1;

export async function GET() {
  try {
    // Opening the database also creates ./data/risen-team.db and its schema.
    const workspace = configuredWorkspaceRoot();
    const manifest = workspace ? readProjectManifest(workspace) : null;
    const db = getDb();
    db.run(sql`select 1`);
    ensureSeeded();
    return Response.json({
      ok: true,
      app: APP_IDENTITY,
      protocolVersion: LAUNCHER_PROTOCOL_VERSION,
      workspaceId: manifest?.workspaceId ?? null,
      schemaVersion: db.$client.pragma("user_version", { simple: true }),
      storage: "sqlite",
      database: resolveDatabasePath(),
    });
  } catch (error) {
    if (error instanceof HallMigrationRequiredError) {
      const root = configuredWorkspaceRoot();
      const manifest = root ? readProjectManifest(root) : null;
      return Response.json({ ok: true, app: APP_IDENTITY, protocolVersion: LAUNCHER_PROTOCOL_VERSION,
        workspaceId: manifest?.workspaceId ?? null, schemaVersion: LATEST_SCHEMA_VERSION, migrationRequired: true });
    }
    // Loopback-only local app: the concrete reason is the single most useful
    // thing to show an operator debugging a failed launch, and it is also what
    // gets written to the launcher log.
    return Response.json(
      {
        ok: false,
        app: APP_IDENTITY,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
