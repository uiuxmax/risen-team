import { initializeHallDatabase, verifyHallSchema } from "@/db/hall-migration";
import { configuredWorkspaceRoot, readProjectManifest } from "@/db/paths";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import {
  ensureForeignKeysEnabled,
  initializeDatabaseSchema,
  type MigrationResult,
} from "@/db/migrations";
import {
  DEFAULT_DB_RELATIVE_PATH,
  backupsDirectory,
  backupsDirectoryForDatabase,
  resolveDatabasePath,
} from "@/db/paths";

/**
 * Local-first persistence.
 *
 * Everything is stored in a single SQLite file inside the project's data folder
 * (default: ./data/risen-team.db). No server, no cloud, no internet required.
 * The database, its folder and its versioned schema are created automatically
 * on first intentional use.
 *
 * `RISEN_DB_PATH` can override the location (useful for tests and for moving the
 * file between computers).
 */

/** Drizzle's runtime client exposes `$client`; keep it typed for low-level integrity probes/tests. */
export type AppDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export { DEFAULT_DB_RELATIVE_PATH, backupsDirectory, backupsDirectoryForDatabase, resolveDatabasePath };

/**
 * Opens and initializes one SQLite connection. Migration execution is confined
 * to this explicit initialization path; importing a module never touches a
 * developer database or a repository fixture.
 */
export function openDatabase(dbPath: string = resolveDatabasePath()): AppDatabase {
  const directory = path.dirname(dbPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });

  const sqlite = new Database(dbPath);
  try {
    // FK enforcement is connection-local and must be active before validation
    // or copy operations. Do this before inspecting any schema version.
    ensureForeignKeysEnabled(sqlite);
    const root = configuredWorkspaceRoot();
    if (root) { readProjectManifest(root); initializeHallDatabase(sqlite, dbPath); }
    else if (sqlite.pragma("user_version", { simple: true }) === 2) verifyHallSchema(sqlite);
    else initializeDatabaseSchema(sqlite, dbPath);
    // Preserve the pre-existing WAL choice for databases that successfully
    // open. It is intentionally delayed until after a future/unsafe schema is
    // refused, so refusal itself does not persist a journal-mode change.
    sqlite.pragma("journal_mode = WAL");
    // `initializeDatabaseSchema` verifies this too; retaining the explicit
    // final assertion documents that the Drizzle client never escapes with FK
    // enforcement disabled on its underlying runtime connection.
    ensureForeignKeysEnabled(sqlite);
    return drizzle(sqlite, { schema });
  } catch (error) {
    // Avoid retaining a locked connection after a safe migration refusal. No
    // reset/seed fallback is attempted here; the original database stays put.
    sqlite.close();
    throw error;
  }
}

let singleton: { path: string; db: AppDatabase } | null = null;

/**
 * Lazy singleton keyed by path: the environment variable is read on first use,
 * which keeps tests and the app from sharing a connection.
 * On path switch, the previous connection is closed to avoid file locks on Windows.
 */
export function getDb(): AppDatabase {
  const dbPath = resolveDatabasePath();
  if (!singleton || singleton.path !== dbPath) {
    if (singleton) {
      try {
        singleton.db.$client.close();
      } catch {
        // Best effort - ignore close errors
      }
      singleton = null;
    }
    singleton = { path: dbPath, db: openDatabase(dbPath) };
  }
  return singleton.db;
}

/**
 * Test/probe helper: closes the singleton connection if open and clears it.
 * Safe to call when already closed/null. Required on Windows where an open
 * SQLite handle prevents unlinking the database file.
 *
 * No production behavior change: production code never calls this; it exists
 * solely to make Windows file-lock cleanup deterministic.
 */
export function closeDatabaseForTests(): void {
  if (singleton) {
    try {
      singleton.db.$client.close();
    } catch {
      // Ignore close errors - best effort cleanup for tests
    } finally {
      singleton = null;
    }
  }
}

/**
 * Test/probe-friendly explicit initializer result. Production callers should
 * use `openDatabase`/`getDb`; this wrapper exists so migration tests can inspect
 * a temporary connection without duplicating startup policy.
 */
export function initializeDatabaseForPath(dbPath: string): { db: AppDatabase; migration: MigrationResult } {
  const directory = path.dirname(dbPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const sqlite = new Database(dbPath);
  try {
    ensureForeignKeysEnabled(sqlite);
    const migration = initializeDatabaseSchema(sqlite, dbPath);
    sqlite.pragma("journal_mode = WAL");
    ensureForeignKeysEnabled(sqlite);
    return { db: drizzle(sqlite, { schema }), migration };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
