import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scheduleEvents } from "@/db/schema";
import type { BackupPayload } from "@/lib/server/backup-types";

/**
 * Backup/import graph validation + merge-safety regression tests (TESTS A–P).
 *
 * Every test runs against a real SQLite file in a temporary directory
 * (RISEN_DB_PATH) — real user data is never touched. Rejection tests assert
 * the database is byte-identical afterwards; the few mutating tests (M, Q)
 * build their backups from current state so they stay self-contained.
 *
 * Bonus coverage beyond the required A–P:
 *   TEST Q — product warnings (eligibility, clashes, duplicates) never block
 *   an import;
 *   TEST R — a backup event id owned by an untouched schedule is rejected in
 *   merge mode instead of violating the primary key mid-transaction.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-backup-validation-test-"));
process.env.RISEN_DB_PATH = path.join(tempDir, "risen-team.db");

type WorkspaceModule = typeof import("@/lib/server/workspace");
type AdminModule = typeof import("@/lib/server/admin");
type SeedModule = typeof import("@/lib/server/seed");
type ExportModule = typeof import("@/lib/server/export-backup");
type DbModule = typeof import("@/db");

let workspace: WorkspaceModule;
let admin: AdminModule;
let seed: SeedModule;
let exportModule: ExportModule;
let dbModule: DbModule;

beforeAll(async () => {
  workspace = await import("@/lib/server/workspace");
  admin = await import("@/lib/server/admin");
  seed = await import("@/lib/server/seed");
  exportModule = await import("@/lib/server/export-backup");
  dbModule = await import("@/db");
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

/** Deep-cloned backup straight from the current database. */
function freshBackup(): BackupPayload {
  return JSON.parse(JSON.stringify(exportModule.exportBackup())) as BackupPayload;
}

function withoutExportedAt(backup: BackupPayload) {
  const { exportedAt: _exportedAt, ...rest } = backup;
  return rest;
}

/** The database must be byte-identical to the captured export. */
function expectUnchanged(before: BackupPayload) {
  expect(withoutExportedAt(exportModule.exportBackup())).toEqual(withoutExportedAt(before));
}

function normalizedGraph(backup: BackupPayload) {
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return {
    app: backup.app,
    schemaVersion: backup.schemaVersion,
    schedules: [...backup.schedules].sort(byId),
    trainers: [...backup.trainers].sort(byId),
    classTypes: [...backup.classTypes].sort(byId),
    rooms: [...backup.rooms].sort(byId),
    events: [...backup.events].sort(byId),
    settings: [...backup.settings].sort((a, b) => a.scheduleId.localeCompare(b.scheduleId)),
    versions: [...backup.versions].sort(byId),
  };
}

describe("backup metadata preflight", () => {
  // TEST A — a foreign application id must never masquerade as a Risen backup.
  it("TEST A — rejects a wrong application identifier before any mutation", () => {
    const before = freshBackup();
    const corrupt = freshBackup();
    (corrupt as unknown as { app: string }).app = "some-other-product";

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Невідомий ідентифікатор програми/);
    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Поточні дані не змінено/);
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/Невідомий ідентифікатор програми/);
    expectUnchanged(before);
  });

  // TEST B — newer (or otherwise unknown) schema versions are refused safely.
  it("TEST B — rejects an unsupported schema version before any mutation", () => {
    const before = freshBackup();
    const future = freshBackup() as unknown as Record<string, unknown>;
    future.schemaVersion = 2;
    const farFuture = freshBackup() as unknown as Record<string, unknown>;
    farFuture.schemaVersion = 99;

    expect(() => admin.importBackup(future, "merge")).toThrow(/Непідтримувана версія схеми/);
    expect(() => admin.importBackup(future, "replace")).toThrow(/schemaVersion 1/);
    expect(() => admin.importBackup(farFuture, "merge")).toThrow(/99/);
    expectUnchanged(before);
  });
});

describe("duplicate-id preflight", () => {
  // TEST C — duplicate schedule ids are caught before any write.
  it("TEST C — rejects a duplicate schedule id", () => {
    const before = freshBackup();
    const corrupt = freshBackup();
    corrupt.schedules = [...corrupt.schedules, { ...corrupt.schedules[0] }];

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Повторюваний ідентифікатор/);
    expect(() => admin.importBackup(corrupt, "merge")).toThrow(new RegExp(corrupt.schedules[0].id));
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/Повторюваний ідентифікатор/);
    expectUnchanged(before);
  });

  // TEST D — event ids are globally unique (across ALL schedules, not per schedule).
  it("TEST D — rejects a duplicate event id across schedules", () => {
    const before = freshBackup();
    expect(before.schedules.length).toBeGreaterThanOrEqual(2);
    const corrupt = freshBackup();
    const otherScheduleId = corrupt.schedules[1].id;
    corrupt.events = [...corrupt.events, { ...corrupt.events[0], scheduleId: otherScheduleId }];

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Повторюваний ідентифікатор/);
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/Поточні дані не змінено/);
    expectUnchanged(before);
  });
});

describe("active-schedule invariant", () => {
  // TEST E — several active schedules: rejected (no silent winner-picking).
  it("TEST E — rejects a backup with two active schedules", () => {
    const before = freshBackup();
    expect(before.schedules.length).toBeGreaterThanOrEqual(2);
    const corrupt = freshBackup();
    corrupt.schedules = corrupt.schedules.map((schedule) => ({ ...schedule, isActive: true, isArchived: false }));

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/рівно один активний розклад/);
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/рівно один активний розклад/);
    expectUnchanged(before);
  });
});

describe("top-level reference validation", () => {
  // TEST F — orphan event references are structural errors.
  it("TEST F — rejects events referencing a missing trainer, class type or room", () => {
    const before = freshBackup();

    const missingTrainer = freshBackup();
    missingTrainer.events[0] = { ...missingTrainer.events[0], trainerId: "trainer-that-does-not-exist" };
    expect(() => admin.importBackup(missingTrainer, "merge")).toThrow(/відсутнього тренера/);

    const missingClass = freshBackup();
    missingClass.events[0] = { ...missingClass.events[0], classTypeId: "class-that-does-not-exist" };
    expect(() => admin.importBackup(missingClass, "replace")).toThrow(/відсутній тип заняття/);

    const missingRoom = freshBackup();
    missingRoom.events[0] = { ...missingRoom.events[0], roomId: "room-that-does-not-exist" };
    expect(() => admin.importBackup(missingRoom, "merge")).toThrow(/відсутній зал/);

    expectUnchanged(before);
  });

  // TEST G — settings must map to a schedule from the backup.
  it("TEST G — rejects settings referencing a missing schedule", () => {
    const before = freshBackup();
    const corrupt = freshBackup();
    corrupt.settings = [
      ...corrupt.settings,
      { ...corrupt.settings[0], scheduleId: "schedule-that-does-not-exist" },
    ];

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Налаштування посилаються на відсутній розклад/);
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/Налаштування посилаються на відсутній розклад/);
    expectUnchanged(before);
  });

  // TEST H — versions must map to a schedule from the backup.
  it("TEST H — rejects a version referencing a missing schedule", () => {
    const before = freshBackup();
    const corrupt = freshBackup();
    corrupt.versions = [
      ...corrupt.versions,
      { ...corrupt.versions[0], id: "ver-bogus-owner", scheduleId: "schedule-that-does-not-exist" },
    ];

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Версія посилається на відсутній розклад/);
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/Версія посилається на відсутній розклад/);
    expectUnchanged(before);
  });

  // TEST I — restore references must resolve (or be null); self-refs are corrupt.
  it("TEST I — rejects an invalid restoredFromVersionId", () => {
    const before = freshBackup();

    const dangling = freshBackup();
    dangling.versions[0] = { ...dangling.versions[0], restoredFromVersionId: "version-that-does-not-exist" };
    expect(() => admin.importBackup(dangling, "merge")).toThrow(/відсутню версію/);
    expect(() => admin.importBackup(dangling, "replace")).toThrow(/відсутню версію/);

    const selfRef = freshBackup();
    selfRef.versions[0] = { ...selfRef.versions[0], restoredFromVersionId: selfRef.versions[0].id };
    expect(() => admin.importBackup(selfRef, "merge")).toThrow(/сама на себе/);

    expectUnchanged(before);
  });
});

describe("historical snapshot validation", () => {
  // TEST J — valid current state + corrupt history: the whole backup is refused.
  it("TEST J — rejects a backup whose historical snapshot holds an out-of-bounds event", () => {
    const before = freshBackup();
    const corrupt = freshBackup();
    expect(corrupt.versions[0].snapshot.events.length).toBeGreaterThan(0);
    corrupt.versions[0].snapshot.events[0] = {
      ...corrupt.versions[0].snapshot.events[0],
      startTime: "05:00",
      endTime: "05:30",
    };

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/пошкоджений знімок/);
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/пошкоджений знімок/);
    expectUnchanged(before);
  });

  // TEST K — a snapshot owned by another schedule is corruption.
  it("TEST K — rejects a snapshot whose schedule id mismatches the version owner", () => {
    const before = freshBackup();
    const corrupt = freshBackup();
    corrupt.versions[0].snapshot.schedule.id = "another-schedule";

    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/версія — розкладу/);
    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/версія — розкладу/);
    expectUnchanged(before);
  });
});

describe("explicit merge semantics", () => {
  // TEST L — an included schedule without settings never wipes current state.
  it("TEST L — incomplete merge schedule does not erase existing events or settings", () => {
    const before = freshBackup();
    const scheduleId = before.schedules[0].id;
    const eventsBefore = before.events.filter((event) => event.scheduleId === scheduleId);
    const settingsBefore = before.settings.find((settings) => settings.scheduleId === scheduleId);
    expect(eventsBefore.length).toBeGreaterThan(0);
    expect(settingsBefore).toBeDefined();

    const partial = freshBackup();
    partial.settings = partial.settings.filter((settings) => settings.scheduleId !== scheduleId);

    expect(() => admin.importBackup(partial, "merge")).toThrow(/не має налаштувань у копії/);
    expect(() => admin.importBackup(partial, "replace")).toThrow(/не має налаштувань у копії/);

    const after = freshBackup();
    expect(after.events.filter((event) => event.scheduleId === scheduleId)).toEqual(eventsBefore);
    expect(after.settings.find((settings) => settings.scheduleId === scheduleId)).toEqual(settingsBefore);
    expectUnchanged(before);
  });

  // TEST M — merge replaces included schedules wholesale, leaves the rest alone.
  it("TEST M — merge affects only the schedules included in the backup", () => {
    const untouched = freshBackup().schedules.find((schedule) => schedule.isActive);
    const included = freshBackup().schedules.find((schedule) => !schedule.isActive);
    expect(untouched).toBeDefined();
    expect(included).toBeDefined();
    const untouchedId = untouched!.id;
    const includedId = included!.id;

    // A pre-existing version on the included schedule exercises the
    // insert-unless-exists version path during the merge below.
    workspace.createVersion({ scheduleId: includedId, source: "manual", description: "M checkpoint" });

    const before = freshBackup();
    const untouchedRowBefore = before.schedules.find((schedule) => schedule.id === untouchedId);
    const untouchedEventsBefore = before.events.filter((event) => event.scheduleId === untouchedId);
    const untouchedSettingsBefore = before.settings.find((settings) => settings.scheduleId === untouchedId);
    const untouchedVersionsBefore = before.versions.filter((version) => version.scheduleId === untouchedId);
    const includedEventsBefore = before.events.filter((event) => event.scheduleId === includedId);
    expect(untouchedEventsBefore.length).toBeGreaterThan(0);
    expect(includedEventsBefore.length).toBeGreaterThan(1);

    // Subset backup: only the inactive schedule, renamed, with one event
    // dropped (wholesale schedule-unit replacement must drop it).
    const subset = freshBackup();
    subset.schedules = subset.schedules
      .filter((schedule) => schedule.id === includedId)
      .map((schedule) => ({ ...schedule, name: `${schedule.name} (merge)` }));
    subset.events = subset.events
      .filter((event) => event.scheduleId === includedId)
      .slice(1);
    subset.settings = subset.settings.filter((settings) => settings.scheduleId === includedId);
    subset.versions = subset.versions.filter((version) => version.scheduleId === includedId);

    const result = admin.importBackup(subset, "merge");
    expect(result.mode).toBe("merge");
    expect(result.schedules).toBe(1);

    const after = freshBackup();
    // Included schedule: replaced as a complete unit.
    expect(after.schedules.find((schedule) => schedule.id === includedId)?.name).toContain("(merge)");
    expect(after.events.filter((event) => event.scheduleId === includedId)).toEqual(subset.events);
    expect(after.settings.find((settings) => settings.scheduleId === includedId)).toEqual(subset.settings[0]);
    expect(after.versions.filter((version) => version.scheduleId === includedId)).toEqual(
      before.versions.filter((version) => version.scheduleId === includedId),
    );
    // Untouched schedule: byte-identical, and still the active one.
    expect(after.schedules.find((schedule) => schedule.id === untouchedId)).toEqual(untouchedRowBefore);
    expect(after.events.filter((event) => event.scheduleId === untouchedId)).toEqual(untouchedEventsBefore);
    expect(after.settings.find((settings) => settings.scheduleId === untouchedId)).toEqual(untouchedSettingsBefore);
    expect(after.versions.filter((version) => version.scheduleId === untouchedId)).toEqual(untouchedVersionsBefore);
    expect(workspace.loadWorkspace().activeScheduleId).toBe(untouchedId);
  });
});

describe("transaction and final verification", () => {
  // TEST N — a failure mid-transaction rolls back to the pre-import database.
  it("TEST N — replace rolls back completely when the transaction fails midway", () => {
    const before = freshBackup();
    const backup = freshBackup();
    const db = dbModule.getDb();
    const runTransaction = db.transaction.bind(db);
    let insertCalls = 0;
    const spy = vi.spyOn(db, "transaction");
    spy.mockImplementation((handler: Parameters<typeof db.transaction>[0]) => {
      const fn = handler as unknown as (tx: Record<string, unknown>) => unknown;
      return runTransaction((tx) => {
        const runner = tx as unknown as { insert: (...args: unknown[]) => unknown };
        const originalInsert = runner.insert.bind(runner);
        runner.insert = (...args: unknown[]) => {
          insertCalls += 1;
          if (insertCalls === 4) throw new Error("injected mid-transaction failure");
          return originalInsert(...args);
        };
        return fn(tx as unknown as Record<string, unknown>);
      }) as never;
    });

    try {
      expect(() => admin.importBackup(backup, "replace")).toThrow(/Поточні дані не змінено/);
    } finally {
      spy.mockRestore();
    }
    // The failure fired after writes had already begun …
    expect(insertCalls).toBe(4);
    // … yet the database is byte-identical: the transaction rolled back.
    expectUnchanged(before);
  });

  // TEST O — final verification sees the RESULTING graph, not just the backup.
  it("TEST O — final verification rolls back when the resulting graph is invalid", () => {
    const db = dbModule.getDb();
    const before = freshBackup();
    const included = before.schedules.find((schedule) => schedule.isActive)!;
    const untouched = before.schedules.find((schedule) => !schedule.isActive)!;

    // Subset backup with only the active schedule — valid on its own.
    const backup = freshBackup();
    backup.schedules = backup.schedules.filter((schedule) => schedule.id === included.id);
    backup.events = backup.events.filter((event) => event.scheduleId === included.id);
    backup.settings = backup.settings.filter((settings) => settings.scheduleId === included.id);
    backup.versions = backup.versions.filter((version) => version.scheduleId === included.id);

    // Plant pre-existing corruption where the merge will NOT overwrite it.
    const ORPHAN_ID = "evt-orphan-final-check";
    const now = new Date();
    // v1 correctly rejects this write under normal runtime conditions. This
    // fixture deliberately simulates an on-disk pre-existing corruption (for
    // example a file edited by another tool) by disabling enforcement only long
    // enough to plant it, then restores FK enforcement before import. The final
    // graph verifier must still defend against data that predates constraints.
    db.$client.pragma("foreign_keys = OFF");
    try {
      db.insert(scheduleEvents)
        .values({
          id: ORPHAN_ID,
          scheduleId: untouched.id,
          dayOfWeek: 0,
          startTime: "10:00",
          endTime: "11:00",
          trainerId: "trainer-that-does-not-exist",
          classTypeId: before.classTypes[0].id,
          roomId: null,
          notes: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } finally {
      db.$client.pragma("foreign_keys = ON");
    }

    try {
      expect(() => admin.importBackup(backup, "merge")).toThrow(/Фінальна перевірка/);
      const after = freshBackup();
      expect(after.events.filter((event) => event.scheduleId === included.id)).toEqual(
        before.events.filter((event) => event.scheduleId === included.id),
      );
      // Rollback preserved the workspace as-is (planted row included).
      expect(after.events.some((event) => event.id === ORPHAN_ID)).toBe(true);
    } finally {
      db.delete(scheduleEvents).where(eq(scheduleEvents.id, ORPHAN_ID)).run();
    }
    expectUnchanged(before);
  });

  // TEST R (bonus) — merge must not steal an event id owned by another schedule.
  it("TEST R — merge rejects a backup event id owned by an untouched schedule", () => {
    const before = freshBackup();
    const included = before.schedules.find(
      (schedule) => schedule.isActive && before.events.some((event) => event.scheduleId === schedule.id),
    )!;
    const untouched = before.schedules.find(
      (schedule) => schedule.id !== included.id && before.events.some((event) => event.scheduleId === schedule.id),
    )!;
    const protectedEvent = before.events.find((event) => event.scheduleId === untouched.id)!;

    const backup = freshBackup();
    backup.schedules = backup.schedules.filter((schedule) => schedule.id === included.id);
    backup.settings = backup.settings.filter((settings) => settings.scheduleId === included.id);
    backup.versions = backup.versions.filter((version) => version.scheduleId === included.id);
    backup.events = backup.events.filter((event) => event.scheduleId === included.id);
    // Internally unique, yet owned by the untouched schedule.
    backup.events[0] = { ...backup.events[0], id: protectedEvent.id };

    expect(() => admin.importBackup(backup, "merge")).toThrow(/вже використовується розкладом/);
    expectUnchanged(before);
  });
});

describe("valid backup round-trip", () => {
  // TEST P — export → fresh database → import: an equivalent graph.
  it("TEST P — valid backup round-trips into a fresh database", async () => {
    const before = freshBackup();
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-backup-roundtrip-"));
    const secondPath = path.join(secondDir, "risen-team.db");
    const previousPath = process.env.RISEN_DB_PATH;
    try {
      process.env.RISEN_DB_PATH = secondPath;
      // Close any existing singleton for previous path so secondPath can be opened cleanly
      try {
        const dbMod = await import("@/db");
        if (typeof dbMod.closeDatabaseForTests === "function") dbMod.closeDatabaseForTests();
      } catch {}
      const payload = JSON.parse(JSON.stringify(before)) as BackupPayload;
      const result = admin.importBackup(payload, "replace");
      expect(result.schedules).toBe(before.schedules.length);
      expect(result.events).toBe(before.events.length);

      const roundTripped = exportModule.exportBackup();
      expect(normalizedGraph(roundTripped)).toEqual(normalizedGraph(before));

      // The active schedule survives the round trip.
      const activeBefore = before.schedules.find((schedule) => schedule.isActive)?.id;
      const activeAfter = roundTripped.schedules.find((schedule) => schedule.isActive)?.id;
      expect(activeAfter).toBe(activeBefore);
    } finally {
      // Close the second database before deleting its directory (Windows file-lock safety)
      try {
        const dbMod = await import("@/db");
        if (typeof dbMod.closeDatabaseForTests === "function") dbMod.closeDatabaseForTests();
      } catch {}
      if (previousPath === undefined) delete process.env.RISEN_DB_PATH;
      else process.env.RISEN_DB_PATH = previousPath;
      // Also close the restored original DB handle so afterAll can clean up
      try {
        const dbMod = await import("@/db");
        if (typeof dbMod.closeDatabaseForTests === "function") dbMod.closeDatabaseForTests();
      } catch {}
      try {
        fs.rmSync(secondDir, { recursive: true, force: true });
      } catch {}
    }
    expectUnchanged(before);
  });

  // TEST Q (bonus) — warnings must never block an import.
  it("TEST Q — product warnings stay warnings on import", () => {
    const before = freshBackup();
    const backup = freshBackup();
    const scheduleId = backup.schedules[0].id;
    const base = backup.events.find((event) => event.scheduleId === scheduleId)!;
    // Exact clone under a fresh id: trainer clash + room clash + duplicate
    // warnings, but no structural errors.
    backup.events.push({ ...base, id: "evt-warning-clone" });
    // Same slot with a class the trainer is not assigned to: eligibility warning.
    const ineligible = backup.classTypes.find(
      (classType) =>
        classType.id !== base.classTypeId &&
        classType.trainerIds.length > 0 &&
        !classType.trainerIds.includes(base.trainerId),
    )!;
    backup.events.push({ ...base, id: "evt-warning-ineligible", classTypeId: ineligible.id });

    const result = admin.importBackup(backup, "merge");
    expect(result.events).toBe(backup.events.length);

    const after = freshBackup();
    expect(after.events.some((event) => event.id === "evt-warning-clone")).toBe(true);
    expect(after.events.some((event) => event.id === "evt-warning-ineligible")).toBe(true);
  });
});
