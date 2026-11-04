import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  scheduleEvents,
  scheduleSettings,
  scheduleVersions,
  schedules,
} from "@/db/schema";
import type { ScheduleEvent, SnapshotContent } from "@/lib/domain/types";

/**
 * Normal-save atomicity and checkpoint failure injection (TESTS A–J).
 *
 * Confirms that normal schedule-state persistence and its version/checkpoint
 * creation are fully atomic:
 *   STATE WRITE + CHECKPOINT WRITE
 * must either both succeed or both roll back.
 *
 * Runs against a dedicated temporary SQLite database with foreign keys enabled (v1 schema).
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-save-atomicity-"));
const dbPath = path.join(tempDir, "risen-team.db");
process.env.RISEN_DB_PATH = dbPath;

type WorkspaceModule = typeof import("@/lib/server/workspace");
type DbModule = typeof import("@/db");
type SeedModule = typeof import("@/lib/server/seed");

let workspace: WorkspaceModule;
let dbModule: DbModule;
let seed: SeedModule;

type BackupsModule = typeof import("@/lib/server/backups");
let backupsModule: BackupsModule;

beforeAll(async () => {
  workspace = await import("@/lib/server/workspace");
  dbModule = await import("@/db");
  seed = await import("@/lib/server/seed");
  backupsModule = await import("@/lib/server/backups");
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

function getRawCounts(scheduleId: string) {
  const db = dbModule.getDb();
  return {
    events: db.$client.prepare("SELECT count(*) as count FROM schedule_events WHERE schedule_id = ?").get(scheduleId) as { count: number },
    settings: db.$client.prepare("SELECT * FROM schedule_settings WHERE schedule_id = ?").get(scheduleId) as Record<string, unknown>,
    versions: db.$client.prepare("SELECT count(*) as count FROM schedule_versions WHERE schedule_id = ?").get(scheduleId) as { count: number },
    schedule: db.$client.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as Record<string, unknown>,
  };
}

function checkFkIntegrity(): void {
  const db = dbModule.getDb();
  const rows = db.$client.pragma("foreign_key_check") as unknown[];
  expect(rows).toEqual([]);
}

describe("saveScheduleState atomicity & checkpoint consistency", () => {
  // TEST A — state + checkpoint success
  it("TEST A — persists valid state and creates exactly one matching version checkpoint", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;
    const initialCounts = getRawCounts(scheduleId);

    const newEvent: ScheduleEvent = {
      id: "evt-test-a",
      scheduleId,
      dayOfWeek: 1,
      startTime: "10:00",
      endTime: "11:00",
      trainerId: ws.trainers[0].id,
      classTypeId: ws.classTypes[0].id,
      roomId: null,
      notes: "Test A Note",
    };

    const newSettings = {
      ...ws.state.settings,
      scheduleTitle: "Title Updated Test A",
    };

    const result = workspace.saveScheduleState({
      scheduleId,
      events: [newEvent],
      settings: newSettings,
      snapshot: true,
      changeDescription: "Checkpoint A description",
    });

    expect(result.versionCreated).not.toBeNull();
    expect(result.versionCreated?.description).toBe("Checkpoint A description");
    expect(result.versionCreated?.source).toBe("manual");

    // Check DB state
    const afterCounts = getRawCounts(scheduleId);
    expect(afterCounts.events.count).toBe(1);
    expect(afterCounts.versions.count).toBe(initialCounts.versions.count + 1);
    expect(afterCounts.settings.schedule_title).toBe("Title Updated Test A");

    // Check checkpoint snapshot content
    const versionSnap = workspace.getVersionSnapshot(result.versionCreated!.id);
    expect(versionSnap.snapshot.settings.scheduleTitle).toBe("Title Updated Test A");
    expect(versionSnap.snapshot.events).toHaveLength(1);
    expect(versionSnap.snapshot.events[0]).toEqual(newEvent);
    expect(versionSnap.snapshot.schedule.status).toBe("draft");

    checkFkIntegrity();
  });

  // TEST B — checkpoint insertion failure rolls back state
  it("TEST B — rolls back state writes completely if checkpoint insert fails", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;
    const beforeCounts = getRawCounts(scheduleId);
    const beforeWorkspace = workspace.loadWorkspace();

    const uniqueEventId = "evt-test-b-will-rollback";
    const newEvent: ScheduleEvent = {
      id: uniqueEventId,
      scheduleId,
      dayOfWeek: 2,
      startTime: "12:00",
      endTime: "13:00",
      trainerId: ws.trainers[0].id,
      classTypeId: ws.classTypes[0].id,
      roomId: null,
      notes: null,
    };

    const targetVersionId = "colliding-version-id";
    // First, insert a version with this id to force a PK collision on version insert
    const db = dbModule.getDb();
    db.$client.prepare(`
      INSERT INTO schedule_versions (id, schedule_id, created_at, source, description, snapshot)
      VALUES (?, ?, ?, 'manual', 'existing', '{}')
    `).run(targetVersionId, scheduleId, Date.now());

    const countsAfterFixture = getRawCounts(scheduleId);

    // Mock globalThis.crypto.randomUUID to return the colliding version id
    const origUUID = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = (() => targetVersionId) as any;

    let caughtError: unknown;
    try {
      workspace.saveScheduleState({
        scheduleId,
        events: [newEvent],
        settings: { ...ws.state.settings, scheduleTitle: "Title Should Not Persist B" },
        snapshot: true,
        changeDescription: "Will fail on version insert",
      });
    } catch (e) {
      caughtError = e;
    } finally {
      globalThis.crypto.randomUUID = origUUID;
    }

    expect(caughtError).toBeDefined();

    // Verify complete rollback: event must NOT exist, settings must be unchanged, versions unchanged
    const afterCounts = getRawCounts(scheduleId);
    expect(afterCounts.events.count).toBe(countsAfterFixture.events.count);
    expect(afterCounts.settings.schedule_title).toBe(countsAfterFixture.settings.schedule_title);
    expect(afterCounts.versions.count).toBe(countsAfterFixture.versions.count);

    // Event was never committed
    const eventRow = db.$client.prepare("SELECT * FROM schedule_events WHERE id = ?").get(uniqueEventId);
    expect(eventRow).toBeUndefined();

    checkFkIntegrity();

    // Clean up fixture version
    db.$client.prepare("DELETE FROM schedule_versions WHERE id = ?").run(targetVersionId);
  });

  // TEST C — state write failure creates no checkpoint
  it("TEST C — creates no checkpoint and commits no partial state when event/settings write fails", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;
    const beforeCounts = getRawCounts(scheduleId);

    // Introduce duplicate event id within the same payload to violate primary key in insert
    const dupeEvent1: ScheduleEvent = {
      id: "dupe-id",
      scheduleId,
      dayOfWeek: 3,
      startTime: "14:00",
      endTime: "15:00",
      trainerId: ws.trainers[0].id,
      classTypeId: ws.classTypes[0].id,
      roomId: null,
      notes: null,
    };
    const dupeEvent2: ScheduleEvent = {
      ...dupeEvent1,
      startTime: "16:00",
      endTime: "17:00",
    };

    expect(() => {
      workspace.saveScheduleState({
        scheduleId,
        events: [dupeEvent1, dupeEvent2],
        settings: { ...ws.state.settings, scheduleTitle: "Title Should Fail C" },
        snapshot: true,
        changeDescription: "Should fail in state write",
      });
    }).toThrow();

    const afterCounts = getRawCounts(scheduleId);
    expect(afterCounts.events.count).toBe(beforeCounts.events.count);
    expect(afterCounts.versions.count).toBe(beforeCounts.versions.count);
    expect(afterCounts.settings.schedule_title).toBe(beforeCounts.settings.schedule_title);

    checkFkIntegrity();
  });

  // TEST D — checkpoint build failure causes full rollback
  it("TEST D — rolls back state write if checkpoint snapshot construction fails", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;
    const beforeCounts = getRawCounts(scheduleId);

    const eventId = "evt-test-d-will-rollback";
    const newEvent: ScheduleEvent = {
      id: eventId,
      scheduleId,
      dayOfWeek: 4,
      startTime: "10:00",
      endTime: "11:00",
      trainerId: ws.trainers[0].id,
      classTypeId: ws.classTypes[0].id,
      roomId: null,
      notes: null,
    };

    // Ensure latestVersion succeeds, but building snapshot fails during its transactional reads.
    // In saveScheduleState:
    // 1. tx.delete(scheduleEvents)
    // 2. tx.insert(scheduleEvents)
    // 3. tx.insert(scheduleSettings)
    // 4. tx.update(schedules)
    // 5. latestVersion(scheduleId, tx) -> queries schedule_versions
    // 6. buildSnapshot(..., tx) -> queries schedules, trainers, classTypes, etc.
    const db = dbModule.getDb();
    const runTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction");
    let deleteCalls = 0;
    let insertCalls = 0;
    let updateCalls = 0;
    let latestVersionSelectCalls = 0;
    let buildSnapshotFailureTriggered = false;

    spy.mockImplementation(((handler: (tx: unknown) => unknown) => {
      return runTransaction((tx) => {
        const runner = tx as unknown as Record<string, (...args: unknown[]) => unknown>;
        const origDelete = runner.delete.bind(runner);
        const origInsert = runner.insert.bind(runner);
        const origUpdate = runner.update.bind(runner);
        const origSelect = runner.select.bind(runner);

        runner.delete = (...args: unknown[]) => {
          deleteCalls++;
          return origDelete(...args);
        };
        runner.insert = (...args: unknown[]) => {
          insertCalls++;
          return origInsert(...args);
        };
        runner.update = (...args: unknown[]) => {
          updateCalls++;
          return origUpdate(...args);
        };
        runner.select = (...args: unknown[]) => {
          // The first select in tx is latestVersion(scheduleId, tx)
          if (latestVersionSelectCalls === 0) {
            latestVersionSelectCalls++;
            return origSelect(...args);
          }
          // The next select is inside buildSnapshot (e.g. schedules or trainers)
          buildSnapshotFailureTriggered = true;
          throw new Error("injected snapshot building failure");
        };

        return handler(tx);
      });
    }) as unknown as typeof db.transaction);

    try {
      expect(() => {
        workspace.saveScheduleState({
          scheduleId,
          events: [newEvent],
          settings: { ...ws.state.settings, scheduleTitle: "Title Should Rollback D" },
          snapshot: true,
          changeDescription: "Snapshot failure test",
        });
      }).toThrow(/injected snapshot building failure/);
    } finally {
      spy.mockRestore();
    }

    expect(deleteCalls).toBeGreaterThan(0);
    expect(insertCalls).toBeGreaterThan(0);
    expect(updateCalls).toBeGreaterThan(0);
    expect(latestVersionSelectCalls).toBe(1);
    expect(buildSnapshotFailureTriggered).toBe(true);

    const afterCounts = getRawCounts(scheduleId);
    expect(afterCounts.events.count).toBe(beforeCounts.events.count);
    expect(afterCounts.versions.count).toBe(beforeCounts.versions.count);
    expect(afterCounts.settings.schedule_title).toBe(beforeCounts.settings.schedule_title);

    const eventRow = db.$client.prepare("SELECT * FROM schedule_events WHERE id = ?").get(eventId);
    expect(eventRow).toBeUndefined();

    checkFkIntegrity();
  });

  // TEST E — snapshot disabled: persists normally, no new version
  it("TEST E — persists state normally without creating a new version when snapshot=false", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;

    // Create a recent version so elapsed < AUTO_SNAPSHOT_INTERVAL_MS
    workspace.createVersion({
      scheduleId,
      source: "manual",
      description: "Recent baseline",
      createdAt: new Date(),
    });

    const beforeCounts = getRawCounts(scheduleId);
    const newEvent: ScheduleEvent = {
      id: "evt-test-e-normal",
      scheduleId,
      dayOfWeek: 5,
      startTime: "09:00",
      endTime: "10:00",
      trainerId: ws.trainers[0].id,
      classTypeId: ws.classTypes[0].id,
      roomId: null,
      notes: null,
    };

    const result = workspace.saveScheduleState({
      scheduleId,
      events: [newEvent],
      settings: { ...ws.state.settings, scheduleTitle: "Title Persisted Test E" },
      snapshot: false,
    });

    expect(result.versionCreated).toBeNull();

    const afterCounts = getRawCounts(scheduleId);
    expect(afterCounts.events.count).toBe(1);
    expect(afterCounts.settings.schedule_title).toBe("Title Persisted Test E");
    expect(afterCounts.versions.count).toBe(beforeCounts.versions.count);

    checkFkIntegrity();
  });

  // TEST F — checkpoint content consistency (no live state leak)
  it("TEST F — ensures checkpoint snapshot exactly reflects the saved payload", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;

    const eventX: ScheduleEvent = {
      id: "evt-test-f-x",
      scheduleId,
      dayOfWeek: 1,
      startTime: "14:00",
      endTime: "15:00",
      trainerId: ws.trainers[0].id,
      classTypeId: ws.classTypes[0].id,
      roomId: null,
      notes: "State X",
    };

    const result = workspace.saveScheduleState({
      scheduleId,
      events: [eventX],
      settings: { ...ws.state.settings, scheduleTitle: "State X Title" },
      snapshot: true,
      changeDescription: "Saved State X",
    });

    expect(result.versionCreated).not.toBeNull();
    const versionSnap = workspace.getVersionSnapshot(result.versionCreated!.id);

    expect(versionSnap.snapshot.settings.scheduleTitle).toBe("State X Title");
    expect(versionSnap.snapshot.events).toHaveLength(1);
    expect(versionSnap.snapshot.events[0].id).toBe("evt-test-f-x");
    expect(versionSnap.snapshot.events[0].notes).toBe("State X");

    checkFkIntegrity();
  });

  // TEST G — repeated sequential valid saves do not duplicate versions unexpectedly
  it("TEST G — sequential saves only create expected versions", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;
    const initialVersions = workspace.listVersions(scheduleId).length;

    // Save 1: with snapshot: true
    const r1 = workspace.saveScheduleState({
      scheduleId,
      events: ws.state.events,
      settings: ws.state.settings,
      snapshot: true,
      changeDescription: "Save 1",
    });
    expect(r1.versionCreated).not.toBeNull();

    // Save 2: with snapshot: false (elapsed < 90s, so no automatic snapshot either)
    const r2 = workspace.saveScheduleState({
      scheduleId,
      events: ws.state.events,
      settings: ws.state.settings,
      snapshot: false,
    });
    expect(r2.versionCreated).toBeNull();

    // Save 3: with snapshot: true
    const r3 = workspace.saveScheduleState({
      scheduleId,
      events: ws.state.events,
      settings: ws.state.settings,
      snapshot: true,
      changeDescription: "Save 3",
    });
    expect(r3.versionCreated).not.toBeNull();

    const finalVersions = workspace.listVersions(scheduleId).length;
    expect(finalVersions).toBe(initialVersions + 2);

    checkFkIntegrity();
  });

  // TEST H — publish backup timing and semantics
  it("TEST H — creates non-blocking publish safety backup only after successful transaction commit", () => {
    const ws = workspace.loadWorkspace();
    const scheduleId = ws.activeScheduleId;

    const eventPublish: ScheduleEvent = {
      id: "evt-test-publish",
      scheduleId,
      dayOfWeek: 1,
      startTime: "11:00",
      endTime: "12:00",
      trainerId: ws.trainers[0].id,
      classTypeId: ws.classTypes[0].id,
      roomId: null,
      notes: "Publish event",
    };

    // Case 1: Successful publish save creates backup after commit with updated status and event
    const backupSpy = vi.spyOn(backupsModule, "writeSafetyBackup");

    const result = workspace.saveScheduleState({
      scheduleId,
      events: [eventPublish],
      settings: ws.state.settings,
      status: "published",
      changeDescription: "Weekly Schedule Final",
    });

    expect(result.status).toBe("published");
    expect(result.versionCreated?.source).toBe("publish");
    expect(backupSpy).toHaveBeenCalled();
    const capturedBackup = backupSpy.mock.calls[0][0];
    const capturedReason = backupSpy.mock.calls[0][1];
    expect(capturedReason).toBe("publish");
    // The exported backup must reflect the COMMITTED state: schedule status published and the new event
    expect(capturedBackup.schedules.find((s) => s.id === scheduleId)?.status).toBe("published");
    expect(capturedBackup.events.some((e) => e.id === "evt-test-publish")).toBe(true);
    backupSpy.mockRestore();

    // Case 2: Failed publish transaction rolls back and must NOT trigger writeSafetyBackup
    const failingUUID = "colliding-publish-version-id";
    const db = dbModule.getDb();
    db.$client.prepare(`
      INSERT INTO schedule_versions (id, schedule_id, created_at, source, description, snapshot)
      VALUES (?, ?, ?, 'manual', 'existing', '{}')
    `).run(failingUUID, scheduleId, Date.now());

    const origUUID = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = (() => failingUUID) as any;

    const backupCallSpy = vi.spyOn(backupsModule, "writeSafetyBackup");

    try {
      expect(() => {
        workspace.saveScheduleState({
          scheduleId,
          events: [{ ...eventPublish, id: "evt-test-publish-fail" }],
          settings: ws.state.settings,
          status: "published",
          changeDescription: "Will fail",
        });
      }).toThrow();
    } finally {
      globalThis.crypto.randomUUID = origUUID;
      backupCallSpy.mockRestore();
      db.$client.prepare("DELETE FROM schedule_versions WHERE id = ?").run(failingUUID);
    }

    // Because the transaction failed and threw, writeSafetyBackup for publish was never called
    expect(backupCallSpy).not.toHaveBeenCalled();

    checkFkIntegrity();
  });

  // TEST J — FK integrity check
  it("TEST J — confirms PRAGMA foreign_key_check returns zero rows after all operations", () => {
    checkFkIntegrity();
  });
});
