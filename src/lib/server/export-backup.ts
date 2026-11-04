import { getDb } from "@/db";
import { configuredWorkspaceRoot } from "@/db/paths";
import { serializeBackup } from "@/lib/server/backup-serialization";

/** Builds a complete, portable snapshot of the local workspace. */
export function exportBackup() {
  return serializeBackup(getDb(), configuredWorkspaceRoot());
}

export { serializeBackup } from "@/lib/server/backup-serialization";
