import fs from "node:fs";
import path from "node:path";
import { backupsDirectory, backupsDirectoryForDatabase } from "@/db/paths";
import type { BackupPayload } from "@/lib/server/backup-types";

/**
 * Local safety backups.
 *
 * Written automatically before destructive operations (import, version restore,
 * schedule deletion) into ./data/backups. Automatic files rotate; manual
 * backups that the user exported themselves are never touched.
 *
 * Destructive-operation policy (enforced by `requireSafetyBackup` in
 * `workspace.ts`, documented here because this is where the backup is created):
 *   - BACKUP-GATED (a failed safety backup cancels the operation and the API
 *     returns a localized, actionable error): backup import (merge + replace),
 *     version restore, schedule deletion;
 *   - NON-GATED (a convenience backup only): publish — publishing is not
 *     destructive, exactly the same flow records a checkpoint version, so a
 *     failed backup must never block it;
 *   - every other administrative mutation (renames, trainer/class/room edits,
 *     reordering) is non-destructive and writes no backup at all.
 *
 * Filenames: `risen-team-auto-YYYY-MM-DD-HHMMSS-SSS-<short-id>.json`
 *   - Windows- and macOS-safe: digit/dash separators only, never a colon;
 *   - collision-free: millisecond precision plus a random suffix, so two
 *     backups created in the same millisecond still land in two files;
 *   - the chronological prefix keeps plain name sorting useful for rotation.
 *
 * Writes are atomic: the payload is serialized completely, written to a
 * temporary file in the SAME directory, flushed and only then renamed onto the
 * final name. A failed write therefore never leaves a truncated `.json` behind
 * and the previously written backups stay untouched.
 */

const AUTO_PREFIX = "risen-team-auto-";
const PRE_MIGRATION_PREFIX = "risen-team-pre-migration-";
const KEEP_AUTO = 10;
/** Temporary files end in `.json.tmp`, so they are never listed or rotated as backups. */
const TEMP_SUFFIX = ".tmp";
const MAX_NAME_ATTEMPTS = 16;
const SHORT_ID_LENGTH = 8;

/**
 * Minimal filesystem seam for the automatic backup writer.
 *
 * Production uses plain `node:fs`, but the indirection lets tests inject write
 * and rename failures (temp-file write, atomic rename) without mocking the
 * whole `fs` module or building a storage abstraction.
 */
export const backupFileSystem = {
  ensureDirectory: (directory: string): void => {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  },
  /** Complete, flushed single-file write: open → write → fsync → close. */
  writeFileSync: (filePath: string, contents: string): void => {
    const handle = fs.openSync(filePath, "w");
    try {
      fs.writeFileSync(handle, contents, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  },
  renameSync: (from: string, to: string): void => {
    fs.renameSync(from, to);
  },
  removeFileSync: (filePath: string): void => {
    fs.unlinkSync(filePath);
  },
  existsSync: (filePath: string): boolean => fs.existsSync(filePath),
  listDirectory: (directory: string): string[] => fs.readdirSync(directory),
  readStats: (filePath: string): fs.Stats => fs.statSync(filePath),
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Chronological, filesystem-safe stamp: `YYYY-MM-DD-HHMMSS-SSS` (no colons). */
export function backupStamp(date = new Date()): string {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    pad(date.getMilliseconds(), 3),
  ].join("-");
}

/** Short lowercase-hex suffix — safe on every platform and on every filesystem. */
function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, SHORT_ID_LENGTH);
}

/** Collision-proof automatic-backup filename (timestamp + random suffix). */
export function safetyBackupName(date = new Date(), suffix: string = shortId()): string {
  return `${AUTO_PREFIX}${backupStamp(date)}-${suffix}.json`;
}

/**
 * Migration copies are intentionally in a separate, non-rotated namespace.
 * A schema migration is rare and a user may need its exact before-image long
 * after ordinary automatic backups have rotated.
 */
export function preMigrationSafetyBackupName(
  fromVersion: number,
  toVersion: number,
  date = new Date(),
  suffix: string = shortId(),
): string {
  return `${PRE_MIGRATION_PREFIX}v${fromVersion}-to-v${toVersion}-${backupStamp(date)}-${suffix}.json`;
}

export interface SafetyBackupResult {
  file: string | null;
  skipped: string | null;
}

export function writeSafetyBackup(backup: BackupPayload, reason: string): SafetyBackupResult {
  return writeBackup(backup, reason, {
    directory: backupsDirectory(),
    nameFor: (date, suffix) => safetyBackupName(date, suffix),
    rotateAutomaticBackups: true,
  });
}

/**
 * Required before a non-empty legacy database is rebuilt. It shares the exact
 * atomic writer and portable serializer used by ordinary safety backups, but
 * uses a migration-specific filename and is never included in auto rotation.
 */
export function writePreMigrationSafetyBackup(
  backup: BackupPayload,
  fromVersion: number,
  toVersion: number,
  dbPath: string,
): SafetyBackupResult {
  return writeBackup(backup, `schema-migration:v${fromVersion}-to-v${toVersion}`, {
    directory: backupsDirectoryForDatabase(dbPath),
    nameFor: (date, suffix) => preMigrationSafetyBackupName(fromVersion, toVersion, date, suffix),
    rotateAutomaticBackups: false,
  });
}

interface WriteBackupOptions {
  directory: string;
  nameFor: (date: Date, suffix: string) => string;
  rotateAutomaticBackups: boolean;
}

/** Shared collision-safe, flushed, atomic writer for every safety-backup class. */
function writeBackup(backup: BackupPayload, reason: string, options: WriteBackupOptions): SafetyBackupResult {
  try {
    backupFileSystem.ensureDirectory(options.directory);
    // The COMPLETE payload is serialized before any file is created: a
    // serialization failure must not leave anything behind.
    const contents = JSON.stringify({ ...backup, safetyReason: reason }, null, 2);
    const file = reserveBackupPath(options.directory, new Date(), options.nameFor);
    writeAtomicFile(file, contents);
    if (options.rotateAutomaticBackups) rotateAutoBackups(options.directory);
    return { file, skipped: null };
  } catch (error) {
    // A failed safety backup NEVER silently permits a destructive operation:
    // callers needing protection must go through `requireSafetyBackup`
    // (workspace.ts), which turns `file: null` into a localized error and
    // cancels the mutation.
    return { file: null, skipped: error instanceof Error ? error.message : "unknown error" };
  }
}

/**
 * First filename that does not exist yet. The random suffix makes a collision
 * practically impossible; the existence check closes the remaining window
 * (e.g. a leftover file from an interrupted earlier run).
 */
function reserveBackupPath(
  directory: string,
  date: Date,
  nameFor: (date: Date, suffix: string) => string,
): string {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(directory, nameFor(date, shortId()));
    if (!backupFileSystem.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique safety-backup filename.");
}

/**
 * Write-through-temporary-file + atomic rename.
 *
 * The temporary file lives in the same directory as the final one (a rename
 * across filesystems is not atomic), and is removed again whenever the write or
 * the rename fails — a failed backup leaves no `.json` and no leftover temp
 * file behind.
 */
function writeAtomicFile(finalPath: string, contents: string): void {
  const temporaryPath = `${finalPath}${TEMP_SUFFIX}`;
  let finalized = false;
  try {
    backupFileSystem.writeFileSync(temporaryPath, contents);
    backupFileSystem.renameSync(temporaryPath, finalPath);
    finalized = true;
  } finally {
    if (!finalized) {
      try {
        backupFileSystem.removeFileSync(temporaryPath);
      } catch {
        /* best effort — the temp file is ignored by listing and rotation */
      }
    }
  }
}

export function listSafetyBackups(): { name: string; size: number; modifiedAt: string }[] {
  const directory = backupsDirectory();
  if (!backupFileSystem.existsSync(directory)) return [];
  return backupFileSystem
    .listDirectory(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const stats = backupFileSystem.readStats(path.join(directory, name));
      return { name, size: stats.size, modifiedAt: stats.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Automatic backups only: manual exports and temp files are never rotated away. */
function isAutoBackup(name: string): boolean {
  return name.startsWith(AUTO_PREFIX) && name.endsWith(".json");
}

function rotateAutoBackups(directory: string): void {
  const autoFiles = backupFileSystem.listDirectory(directory).filter(isAutoBackup).sort();
  const excess = autoFiles.length - KEEP_AUTO;
  for (let index = 0; index < excess; index += 1) {
    try {
      backupFileSystem.removeFileSync(path.join(directory, autoFiles[index]));
    } catch {
      /* keep going — rotation is best effort */
    }
  }
}
