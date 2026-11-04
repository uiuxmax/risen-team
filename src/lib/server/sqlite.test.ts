import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Local persistence, version-restore scope and atomic import behaviour — all
 * exercised against a real SQLite file in a temporary directory.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-team-test-"));
const dbPath = path.join(tempDir, "risen-team.db");
process.env.RISEN_DB_PATH = dbPath;

type WorkspaceModule = typeof import("@/lib/server/workspace");
type AdminModule = typeof import("@/lib/server/admin");
type SeedModule = typeof import("@/lib/server/seed");
type ExportModule = typeof import("@/lib/server/export-backup");

let workspace: WorkspaceModule;
let admin: AdminModule;
let seed: SeedModule;
let exportModule: ExportModule;

beforeAll(async () => {
  workspace = await import("@/lib/server/workspace");
  admin = await import("@/lib/server/admin");
  seed = await import("@/lib/server/seed");
  exportModule = await import("@/lib/server/export-backup");
  seed.ensureSeeded();
});

afterAll(async () => {
  try {
    const db = await import("@/db");
    if (typeof db.closeDatabaseForTests === "function") db.closeDatabaseForTests();
  } catch {}
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe("local SQLite storage", () => {
  it("creates the database file automatically and seeds demo data once", () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    const loaded = workspace.loadWorkspace();
    expect(loaded.schedules.length).toBeGreaterThanOrEqual(2);
    expect(loaded.trainers.length).toBeGreaterThan(0);
    expect(loaded.state.events.length).toBeGreaterThan(30);
    expect(loaded.schedules.map((schedule) => schedule.name)).toContain("Основний розклад");

    // Seeding is marker-based: calling it again must not duplicate rows.
    const before = workspace.loadWorkspace().trainers.length;
    seed.ensureSeeded();
    expect(workspace.loadWorkspace().trainers.length).toBe(before);
  });

  it("keeps data after a full module restart (file-backed, not in-memory)", async () => {
    const loaded = workspace.loadWorkspace();
    const scheduleId = loaded.activeScheduleId;
    const event = {
      id: "persist-check",
      scheduleId,
      dayOfWeek: 2,
      startTime: "15:45",
      endTime: "16:45",
      trainerId: loaded.trainers[0].id,
      classTypeId: loaded.classTypes[0].id,
      roomId: null,
      notes: "Перевірка збереження",
    };
    workspace.saveScheduleState({
      scheduleId,
      events: [...loaded.state.events, event],
      settings: loaded.state.settings,
      changeDescription: "Тестове збереження",
      snapshot: true,
    });

    // Simulate closing and reopening the application: fresh module registry,
    // same database file on disk.
    vi.resetModules();
    const freshWorkspace = await import("@/lib/server/workspace");
    const reopened = freshWorkspace.loadWorkspace();
    const found = reopened.state.events.find((item) => item.id === "persist-check");
    expect(found).toBeDefined();
    expect(found?.startTime).toBe("15:45");
    const version = reopened.versions.find((item) => item.description === "Тестове збереження");
    expect(version).toBeDefined();

    workspace = freshWorkspace;
  });

  it("rejects an invalid time range instead of corrupting the schedule", () => {
    const loaded = workspace.loadWorkspace();
    expect(() =>
      workspace.saveScheduleState({
        scheduleId: loaded.activeScheduleId,
        events: [
          {
            id: "bad-range",
            scheduleId: loaded.activeScheduleId,
            dayOfWeek: 0,
            startTime: "18:00",
            endTime: "09:00",
            trainerId: loaded.trainers[0].id,
            classTypeId: loaded.classTypes[0].id,
            roomId: null,
            notes: null,
          },
        ],
        settings: loaded.state.settings,
      }),
    ).toThrow(/завершення/i);
    expect(workspace.loadWorkspace().state.events.some((event) => event.id === "bad-range")).toBe(false);
  });
});

describe("version history scope", () => {
  it("restores only the selected schedule and never mutates shared trainers or other schedules", () => {
    const before = workspace.loadWorkspace();
    const targetScheduleId = before.activeScheduleId;
    const otherSchedule = before.schedules.find((schedule) => schedule.id !== targetScheduleId);
    expect(otherSchedule).toBeDefined();

    // Snapshot the current (seeded) state, then make the schedule very different.
    const baseline = workspace.createVersion({
      scheduleId: targetScheduleId,
      source: "manual",
      description: "Базовий стан",
    });
    const stripped = {
      ...before.state,
      scheduleId: targetScheduleId,
      events: before.state.events.filter((event) => event.dayOfWeek !== 0),
    };
    workspace.saveScheduleState({ ...stripped, changeDescription: "Видалено понеділок" });

    // Rename a trainer afterwards: the old version must not undo workspace-level names.
    const trainer = before.trainers[0];
    const renamed = `${trainer.name} (перевірка)`;
    admin.upsertTrainer({ ...trainer, name: renamed });

    const otherBefore = workspace.loadWorkspace(otherSchedule!.id).state.events.length;
    const otherTrainersBefore = workspace.loadWorkspace().trainers.map((item) => item.name).sort();
    const versionsBeforeRestore = workspace.listVersions(targetScheduleId).length;

    const result = workspace.restoreVersion(baseline.id);
    expect(result.scheduleId).toBe(targetScheduleId);

    const afterTarget = workspace.loadWorkspace(targetScheduleId);
    const afterOther = workspace.loadWorkspace(otherSchedule!.id);

    // Monday is back in the restored schedule …
    expect(afterTarget.state.events.some((event) => event.dayOfWeek === 0)).toBe(true);
    // … the other schedule is untouched …
    expect(afterOther.state.events.length).toBe(otherBefore);
    // … and the workspace trainer rename survived the restore.
    expect(afterOther.state.events.length + otherTrainersBefore.length).toBeGreaterThan(0);
    const namesAfter = workspace.loadWorkspace().trainers.map((item) => item.name).sort();
    expect(namesAfter).toEqual(otherTrainersBefore);
    expect(namesAfter).toContain(renamed);

    // History is append-only: the restore adds one entry and deletes nothing.
    const versions = workspace.listVersions(targetScheduleId);
    expect(versions.some((version) => version.source === "restore")).toBe(true);
    expect(versions.length).toBe(versionsBeforeRestore + 1);
    expect(versions.some((version) => version.description === "Базовий стан")).toBe(true);
  });
});

describe("atomic backup import", () => {
  it("exports a portable backup and imports it back without losing data", () => {
    const backup = exportModule.exportBackup();
    expect(backup.schemaVersion).toBe(1);
    expect(backup.app).toBe("risen-team-schedule-builder");
    expect(backup.schedules.length).toBeGreaterThan(0);

    const result = admin.importBackup(backup, "merge");
    expect(result.schedules).toBe(backup.schedules.length);
    expect(result.events).toBe(backup.events.length);
    expect(workspace.loadWorkspace().state.events.length).toBeGreaterThan(0);
  });

  it("rejects an incompatible backup without touching the database", () => {
    const before = exportModule.exportBackup();
    expect(() => admin.importBackup({ schemaVersion: 99, schedules: [] }, "replace")).toThrow(/schemaVersion 1/);
    const after = exportModule.exportBackup();
    expect(after.events.length).toBe(before.events.length);
    expect(after.trainers.length).toBe(before.trainers.length);
  });

  it("rolls back completely when a corrupt backup breaks inside the transaction", () => {
    const before = exportModule.exportBackup();
    const corrupt = JSON.parse(JSON.stringify(before)) as typeof before;
    // Valid file shape, valid relationships, but two schedules share an event id →
    // the primary-key violation happens halfway through the import and must roll back.
    const scheduleIds = corrupt.schedules.map((schedule) => schedule.id);
    if (scheduleIds.length >= 2) {
      const duplicated = { ...corrupt.events[0], id: "collision", scheduleId: scheduleIds[0] };
      const duplicatedAgain = { ...corrupt.events[1], id: "collision", scheduleId: scheduleIds[1] };
      corrupt.events = [...corrupt.events, duplicated, duplicatedAgain];
    }

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Поточні дані не змінено/);
    const after = exportModule.exportBackup();
    expect(after.events.length).toBe(before.events.length);
    expect(after.events.some((event) => event.id === "collision")).toBe(false);
    expect(after.schedules.length).toBe(before.schedules.length);
    expect(after.trainers.length).toBe(before.trainers.length);
    expect(after.versions.length).toBe(before.versions.length);
  });

  it("rejects a backup whose relationships are broken", () => {
    const before = exportModule.exportBackup();
    const broken = JSON.parse(JSON.stringify(before)) as typeof before;
    broken.events = broken.events.map((event, index) =>
      index === 0 ? { ...event, trainerId: "trainer-that-does-not-exist" } : event,
    );
    expect(() => admin.importBackup(broken, "replace")).toThrow(/відсутнього тренера/);
    expect(exportModule.exportBackup().events.length).toBe(before.events.length);
  });

  it("writes a rotating safety backup before applying an import", () => {
    const backup = exportModule.exportBackup();
    const result = admin.importBackup(backup, "merge");
    expect(result.safetyBackup).toBeTruthy();
    expect(fs.existsSync(result.safetyBackup as string)).toBe(true);
    const backupDir = path.join(tempDir, "backups");
    expect(fs.existsSync(backupDir)).toBe(true);
  });
});
