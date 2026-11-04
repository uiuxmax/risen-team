import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackupPayload } from "@/lib/server/backup-types";

/**
 * Automatic safety-backup file handling (TESTS L, M, N, O).
 *
 * Runs against temporary directories/`RISEN_DB_PATH` databases only. The
 * filesystem-failure tests use the small `backupFileSystem` seam exported by
 * `backups.ts` instead of mocking `node:fs` globally.
 */

type BackupsModule = typeof import("@/lib/server/backups");
type WorkspaceModule = typeof import("@/lib/server/workspace");
type AdminModule = typeof import("@/lib/server/admin");
type SeedModule = typeof import("@/lib/server/seed");

let backups: BackupsModule;
let workspace: WorkspaceModule;
let admin: AdminModule;
let seed: SeedModule;

const createdDirs: string[] = [];

/** Isolated database + backups directory for one test. */
function freshDatabase(): { dir: string; backupsDirectory: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-backup-files-"));
  createdDirs.push(dir);
  const dbPath = path.join(dir, "risen-team.db");
  process.env.RISEN_DB_PATH = dbPath;
  return { dir, backupsDirectory: path.join(dir, "backups") };
}

function minimalBackup(): BackupPayload {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    app: "risen-team-schedule-builder",
    schedules: [],
    trainers: [],
    classTypes: [],
    rooms: [],
    events: [],
    settings: [],
    versions: [],
  };
}

function autoFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith("risen-team-auto-") && name.endsWith(".json"))
    .sort();
}

function tempFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"));
}

function snapshot(): BackupPayload {
  return JSON.parse(JSON.stringify(workspace.exportBackup())) as BackupPayload;
}

function withoutExportedAt(backup: BackupPayload) {
  const { exportedAt: _exportedAt, ...rest } = backup;
  return rest;
}

beforeAll(async () => {
  backups = await import("@/lib/server/backups");
  workspace = await import("@/lib/server/workspace");
  admin = await import("@/lib/server/admin");
  seed = await import("@/lib/server/seed");
});

afterAll(async () => {
  try {
    const db = await import("@/db");
    if (typeof db.closeDatabaseForTests === "function") db.closeDatabaseForTests();
  } catch {}
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("automatic backup filenames", () => {
  // TEST L — two backups in the same millisecond cannot overwrite each other.
  it("TEST L — creates unique, platform-safe names even within one millisecond", () => {
    const { backupsDirectory } = freshDatabase();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5, 678));
      const first = backups.writeSafetyBackup(minimalBackup(), "probe-1");
      const second = backups.writeSafetyBackup(minimalBackup(), "probe-2");

      expect(first.file).toBeTruthy();
      expect(second.file).toBeTruthy();
      expect(first.file).not.toBe(second.file);
      expect(fs.existsSync(first.file as string)).toBe(true);
      expect(fs.existsSync(second.file as string)).toBe(true);

      const names = autoFiles(backupsDirectory);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);

      for (const name of names) {
        // Chronological prefix (sortable for rotation) + unique suffix, and no
        // colon or other platform-hostile character anywhere.
        expect(name).toMatch(/^risen-team-auto-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}-[0-9a-z]{8}\.json$/);
        expect(name).not.toMatch(/[:*?"<>|\\/]/);
        const contents = JSON.parse(fs.readFileSync(path.join(backupsDirectory, name), "utf8")) as {
          safetyReason: string;
          app: string;
        };
        expect(contents.app).toBe("risen-team-schedule-builder");
        expect(contents.safetyReason).toMatch(/^probe-/);
      }
      const reasons = names
        .map(
          (name) =>
            (
              JSON.parse(fs.readFileSync(path.join(backupsDirectory, name), "utf8")) as {
                safetyReason: string;
              }
            ).safetyReason,
        )
        .sort();
      expect(reasons).toEqual(["probe-1", "probe-2"]);
      expect(tempFiles(backupsDirectory)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("atomic safety-backup writes", () => {
  // TEST M — a failed temp write / rename leaves no partial .json behind.
  it("TEST M — never leaves a corrupted backup and keeps earlier backups intact", () => {
    const { backupsDirectory } = freshDatabase();
    const good = backups.writeSafetyBackup(minimalBackup(), "m-good");
    expect(good.file).toBeTruthy();
    const goodPath = good.file as string;
    const goodContents = fs.readFileSync(goodPath, "utf8");

    // 1) The payload is written, but the atomic rename fails.
    const renameSpy = vi
      .spyOn(backups.backupFileSystem, "renameSync")
      .mockImplementation(() => {
        throw new Error("rename refused");
      });
    try {
      const failed = backups.writeSafetyBackup(minimalBackup(), "m-rename");
      expect(failed.file).toBeNull();
      expect(failed.skipped).toBeTruthy();
    } finally {
      renameSpy.mockRestore();
    }
    // The temporary file was cleaned up and no final file appeared.
    expect(tempFiles(backupsDirectory)).toEqual([]);
    expect(autoFiles(backupsDirectory)).toEqual([path.basename(goodPath)]);
    expect(fs.readFileSync(goodPath, "utf8")).toBe(goodContents);

    // 2) The temp-file write itself fails (nothing is created at all).
    const writeSpy = vi
      .spyOn(backups.backupFileSystem, "writeFileSync")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    try {
      const failed = backups.writeSafetyBackup(minimalBackup(), "m-write");
      expect(failed.file).toBeNull();
      expect(failed.skipped).toBe("disk full");
    } finally {
      writeSpy.mockRestore();
    }
    expect(autoFiles(backupsDirectory)).toEqual([path.basename(goodPath)]);

    // Every surviving file is valid JSON — no truncated backup ever appears.
    for (const name of fs.readdirSync(backupsDirectory).filter((item) => item.endsWith(".json"))) {
      expect(() => JSON.parse(fs.readFileSync(path.join(backupsDirectory, name), "utf8"))).not.toThrow();
    }
  });
});

describe("destructive-operation backup policy", () => {
  // TEST N — a failed safety backup blocks every backup-gated destructive action.
  it("TEST N — refuses gated destructive operations when the safety backup fails", async () => {
    const { backupsDirectory } = freshDatabase();
    seed.ensureSeeded();
    const before = snapshot();
    const inactive = before.schedules.find((schedule) => !schedule.isActive);
    const version = before.versions[0];
    expect(inactive).toBeDefined();
    expect(version).toBeDefined();

    const breakBackup = vi
      .spyOn(backups.backupFileSystem, "writeFileSync")
      .mockImplementation(() => {
        throw new Error("no space left on device");
      });
    expect(autoFiles(backupsDirectory)).toEqual([]);
    try {
      // Schedule deletion: cancelled instead of silently losing the schedule.
      await expect(admin.scheduleAction({ action: "delete", id: inactive?.id })).rejects.toThrow(
        /Не вдалося створити резервну копію. Операцію скасовано/,
      );
      // Import (merge + replace both rewrite existing data).
      expect(() => admin.importBackup(before, "replace")).toThrow(/Не вдалося створити резервну копію/);
      expect(() => admin.importBackup(before, "merge")).toThrow(/Не вдалося створити резервну копію/);
      // Version restore replaces the schedule's current state.
      expect(() => workspace.restoreVersion(version?.id as string)).toThrow(
        /Не вдалося створити резервну копію/,
      );
    } finally {
      breakBackup.mockRestore();
    }

    // Nothing was mutated by any of the refused operations.
    expect(withoutExportedAt(workspace.exportBackup())).toEqual(withoutExportedAt(before));

    // With a working filesystem the very same deletion succeeds and writes a
    // real safety-backup file — proving the refusal came from the backup step.
    const result = await admin.scheduleAction({ action: "delete", id: inactive?.id });
    expect(result.activeScheduleId).toBeTruthy();
    expect(workspace.exportBackup().schedules.some((schedule) => schedule.id === inactive?.id)).toBe(false);
    expect(autoFiles(backupsDirectory)).toHaveLength(1);
  });

  // Non-gated operations must keep working when the backup cannot be written.
  it("keeps non-gated operations (publish) working when the backup fails", () => {
    freshDatabase();
    seed.ensureSeeded();
    const loaded = workspace.loadWorkspace();
    const writeSpy = vi
      .spyOn(backups.backupFileSystem, "writeFileSync")
      .mockImplementation(() => {
        throw new Error("no space left on device");
      });
    try {
      const result = workspace.saveScheduleState({
        scheduleId: loaded.activeScheduleId,
        events: loaded.state.events,
        settings: loaded.state.settings,
        status: "published",
        changeDescription: "Publish without backup",
        snapshot: true,
      });
      expect(result.status).toBe("published");
    } finally {
      writeSpy.mockRestore();
    }
    expect(workspace.exportBackup().schedules.find((schedule) => schedule.isActive)?.status).toBe("published");
  });
});

describe("automatic backup rotation", () => {
  // TEST O — only the newest automatic backups rotate; manual files survive.
  it("TEST O — keeps the newest automatic backups and never deletes manual ones", () => {
    const { backupsDirectory } = freshDatabase();
    fs.mkdirSync(backupsDirectory, { recursive: true });
    const manual = path.join(backupsDirectory, "risen-team-schedule-backup-2026-01-01.json");
    fs.writeFileSync(manual, JSON.stringify({ manual: true }), "utf8");
    const leftoverTemp = path.join(backupsDirectory, "risen-team-auto-2026-01-01-000000-000-deadbeef.json.tmp");
    fs.writeFileSync(leftoverTemp, "partial write", "utf8");

    const written: string[] = [];
    vi.useFakeTimers();
    try {
      for (let index = 0; index < 14; index += 1) {
        // One second apart: the chronological prefix must sort exactly like time.
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
        const result = backups.writeSafetyBackup(minimalBackup(), `rot-${index}`);
        expect(result.file).toBeTruthy();
        written.push(path.basename(result.file as string));
      }
    } finally {
      vi.useRealTimers();
    }

    const remaining = autoFiles(backupsDirectory);
    expect(remaining).toHaveLength(10);
    // The ten newest survive, sorted by the deterministic chronological name.
    expect(remaining).toEqual([...written].sort().slice(-10));
    expect(remaining).not.toContain(path.basename(written[0]));

    // Manual export: untouched, still listed, never rotated away.
    expect(fs.existsSync(manual)).toBe(true);
    expect(fs.readFileSync(manual, "utf8")).toContain("manual");
    expect(backups.listSafetyBackups().map((item) => item.name)).toContain(
      "risen-team-schedule-backup-2026-01-01.json",
    );

    // Incomplete temp files are neither counted as backups nor listed.
    expect(fs.existsSync(leftoverTemp)).toBe(true);
    expect(backups.listSafetyBackups().some((item) => item.name.endsWith(".tmp"))).toBe(false);
  });
});
