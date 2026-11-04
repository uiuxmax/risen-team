import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

/** Default local-first database location relative to the application root. */
export const DEFAULT_DB_RELATIVE_PATH = path.join(/* turbopackIgnore: true */ "data", "risen-team.db");

/**
 * Resolves the configured database without opening it. Keeping this in a small
 * dependency-free module lets migrations and the backup writer share the same
 * storage location without creating a database-initialization import cycle.
 */
export function resolveDatabasePath(): string {
  const fromEnv = process.env.RISEN_DB_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(/* turbopackIgnore: true */ fromEnv.trim());
  const workspace = configuredWorkspaceRoot();
  if (workspace) return projectPaths(workspace).database;
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), DEFAULT_DB_RELATIVE_PATH);
}

/** The established local storage directory for automatic and migration backups. */
export function backupsDirectory(): string {
  return backupsDirectoryForDatabase(resolveDatabasePath());
}

/** Backup directory beside an explicit database path (used before migration). */
export function backupsDirectoryForDatabase(dbPath: string): string {
  const workspace = configuredWorkspaceRoot();
  if (workspace && path.resolve(/* turbopackIgnore: true */ dbPath) === projectPaths(workspace).database) {
    return projectPaths(workspace).backups;
  }
  return path.join(/* turbopackIgnore: true */ path.dirname(/* turbopackIgnore: true */ dbPath), "backups");
}

export const PROJECT_FORMAT_VERSION = 1;
export interface ProjectManifest {
  format: "risen-team-project";
  formatVersion: 1;
  workspaceId: string;
  createdAt: string;
}

/** Desktop launchers must supply an absolute path; never resolve it against a transient cwd. */
export function configuredWorkspaceRoot(): string | null {
  const value = process.env.RISEN_WORKSPACE_PATH?.trim();
  if (!value) return null;
  if (!path.isAbsolute(value)) throw new Error("RISEN_WORKSPACE_PATH must be an absolute project directory.");
  return path.normalize(value);
}

export function projectPaths(root: string) {
  if (!path.isAbsolute(root)) throw new Error("Project directory must be absolute.");
  const directory = path.normalize(root);
  return {
    root: directory,
    manifest: path.join(/* turbopackIgnore: true */ directory, "project.json"),
    database: path.join(/* turbopackIgnore: true */ directory, DEFAULT_DB_RELATIVE_PATH),
    logos: path.join(/* turbopackIgnore: true */ directory, "assets", "logos"),
    backups: path.join(/* turbopackIgnore: true */ directory, "backups"),
    exports: path.join(/* turbopackIgnore: true */ directory, "exports"),
    logs: path.join(/* turbopackIgnore: true */ directory, "logs"),
  };
}

/** Reads identity only; imports and readiness checks must not create projects. */
export function readProjectManifest(root: string): ProjectManifest {
  const value: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ projectPaths(root).manifest, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid Risen Team project manifest.");
  const manifest = value as Partial<ProjectManifest>;
  if (manifest.format !== "risen-team-project" || manifest.formatVersion !== PROJECT_FORMAT_VERSION ||
      typeof manifest.workspaceId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(manifest.workspaceId) ||
      typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("Invalid or unsupported Risen Team project manifest.");
  }
  return manifest as ProjectManifest;
}

/** Explicit first-launch action. An existing unidentified directory is never silently adopted. */
export function createProject(root: string): ProjectManifest {
  const locations = projectPaths(root);
  if (fs.existsSync(/* turbopackIgnore: true */ locations.manifest)) return readProjectManifest(root);
  if (fs.existsSync(/* turbopackIgnore: true */ root) && fs.readdirSync(/* turbopackIgnore: true */ root).length > 0) {
    throw new Error("Choose an empty directory or an existing Risen Team project. Legacy data must be migrated explicitly.");
  }
  fs.mkdirSync(/* turbopackIgnore: true */ root, { recursive: true });
  const lock = path.join(/* turbopackIgnore: true */ root, ".project-create.lock");
  let lockHandle: number;
  try { lockHandle = fs.openSync(/* turbopackIgnore: true */ lock, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (fs.existsSync(/* turbopackIgnore: true */ locations.manifest)) return readProjectManifest(root);
      throw new Error("Project creation is already in progress. Retry after the other launch has finished.");
    }
    throw error;
  }
  const manifest: ProjectManifest = {
    format: "risen-team-project", formatVersion: PROJECT_FORMAT_VERSION,
    workspaceId: randomUUID(), createdAt: new Date().toISOString(),
  };
  const temporary = `${locations.manifest}.${randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(/* turbopackIgnore: true */ temporary, "wx");
    try {
      fs.writeFileSync(handle, JSON.stringify(manifest, null, 2), "utf8");
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    // The exclusive creation lock protects identity; rename is atomic on portable
    // filesystems as well as NTFS/APFS (hard links are unavailable on exFAT).
    if (fs.existsSync(/* turbopackIgnore: true */ locations.manifest)) return readProjectManifest(root);
    fs.renameSync(/* turbopackIgnore: true */ temporary, locations.manifest);
    for (const directory of [path.dirname(/* turbopackIgnore: true */ locations.database), locations.logos, locations.backups, locations.exports, locations.logs]) {
      fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true });
    }
  } finally {
    fs.rmSync(/* turbopackIgnore: true */ temporary, { force: true });
    fs.closeSync(lockHandle);
    fs.rmSync(/* turbopackIgnore: true */ lock, { force: true });
  }
  return manifest;
}

/** Locate candidates only. Selecting or copying one is an explicit migration action. */
export function legacyDatabaseCandidates(applicationRoot: string, home = os.homedir()): string[] {
  const candidates = [
    path.join(/* turbopackIgnore: true */ applicationRoot, DEFAULT_DB_RELATIVE_PATH),
    ...(process.env.LOCALAPPDATA ? [path.join(/* turbopackIgnore: true */ process.env.LOCALAPPDATA, "RisenTeamSchedule-v1.0", "risen-team.db")] : []),
    path.join(/* turbopackIgnore: true */ home, "Library", "Application Support", "RisenTeamSchedule-v1.0", "risen-team.db"),
  ];
  return [...new Set(candidates.map((candidate) => path.resolve(/* turbopackIgnore: true */ candidate)))].filter((candidate) => fs.existsSync(/* turbopackIgnore: true */ candidate) && fs.statSync(/* turbopackIgnore: true */ candidate).isFile());
}
