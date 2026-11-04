import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScheduleEvent, SnapshotContent } from "@/lib/domain/types";

/**
 * Persistence-boundary regression tests (TESTS A–J, server side).
 *
 * Every write path — direct save, backup import and version restore — must
 * apply the same shared schedule-state rules, and a restore must be atomic
 * (including its checkpoint) and must never leave orphan room references.
 * All of it runs against a real SQLite file in a temporary directory
 * (RISEN_DB_PATH) — real user data is never touched.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-state-test-"));
process.env.RISEN_DB_PATH = path.join(tempDir, "risen-team.db");

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

function snapshotOf(scheduleId: string): SnapshotContent {
  return JSON.parse(JSON.stringify(workspace.buildSnapshot(scheduleId))) as SnapshotContent;
}

function withoutExportedAt(backup: ReturnType<ExportModule["exportBackup"]>) {
  const { exportedAt: _exportedAt, ...rest } = backup;
  return rest;
}

function baseEvent(scheduleId: string, trainerId: string, classTypeId: string, overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: "evt-base",
    scheduleId,
    dayOfWeek: 2,
    startTime: "15:45",
    endTime: "16:30",
    trainerId,
    classTypeId,
    roomId: null,
    notes: null,
    ...overrides,
  };
}

describe("shared schedule-state validation on the normal save path", () => {
  // TEST A (persistence) — invalid schedule start/end cannot persist.
  it("refuses to persist a reversed or empty schedule window", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;

    expect(() =>
      workspace.saveScheduleState({
        scheduleId,
        events: before.state.events,
        settings: { ...before.state.settings, startTime: "21:00", endTime: "07:00" },
      }),
    ).toThrow(/Розклад має починатися раніше/);

    expect(() =>
      workspace.saveScheduleState({
        scheduleId,
        events: before.state.events,
        settings: { ...before.state.settings, startTime: "07:00", endTime: "07:00" },
      }),
    ).toThrow(/Розклад має починатися раніше/);

    const after = workspace.loadWorkspace();
    expect(after.state.settings.startTime).toBe("07:00");
    expect(after.state.settings.endTime).toBe("21:00");
    expect(after.state.events).toEqual(before.state.events);
  });

  // TEST B — direct server save before the window fails and changes nothing.
  it("rejects a direct save whose event starts before the window", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    const event = baseEvent(scheduleId, before.trainers[0].id, before.classTypes[0].id, {
      id: "evt-too-early",
      startTime: "05:00",
      endTime: "05:30",
    });

    expect(() =>
      workspace.saveScheduleState({
        scheduleId,
        events: [...before.state.events, event],
        settings: before.state.settings,
      }),
    ).toThrow(/раніше 07:00/);

    const after = workspace.loadWorkspace();
    expect(after.state.events.some((item) => item.id === "evt-too-early")).toBe(false);
    expect(after.state.events).toEqual(before.state.events);
  });

  // TEST C — an event that exceeds the schedule end fails.
  it("rejects a direct save whose event exceeds the schedule end", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    const event = baseEvent(scheduleId, before.trainers[0].id, before.classTypes[0].id, {
      id: "evt-too-late",
      startTime: "20:30",
      endTime: "21:30",
    });

    expect(() =>
      workspace.saveScheduleState({
        scheduleId,
        events: [...before.state.events, event],
        settings: before.state.settings,
      }),
    ).toThrow(/не пізніше 21:00/);

    const after = workspace.loadWorkspace();
    expect(after.state.events.some((item) => item.id === "evt-too-late")).toBe(false);
    expect(after.state.events).toEqual(before.state.events);
  });

  // TEST D — exact valid boundaries pass.
  it("accepts events that touch the exact window boundaries", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    const result = workspace.saveScheduleState({
      scheduleId,
      events: [
        baseEvent(scheduleId, before.trainers[0].id, before.classTypes[0].id, {
          id: "evt-open",
          dayOfWeek: 0,
          startTime: "07:00",
          endTime: "07:30",
        }),
        baseEvent(scheduleId, before.trainers[1]?.id ?? before.trainers[0].id, before.classTypes[1]?.id ?? before.classTypes[0].id, {
          id: "evt-close",
          dayOfWeek: 2,
          startTime: "20:30",
          endTime: "21:00",
        }),
      ],
      settings: before.state.settings,
    });
    expect(result.savedAt).toBeTruthy();

    const after = workspace.loadWorkspace();
    expect(after.state.events.map((event) => event.id).sort()).toEqual(["evt-close", "evt-open"]);
  });
});

describe("shared schedule-state validation on backup import", () => {
  // TEST E — an out-of-bounds event in a backup fails before any mutation.
  it("rejects a backup containing an out-of-window event and leaves the database unchanged", () => {
    const before = exportModule.exportBackup();
    const corrupt = JSON.parse(JSON.stringify(before)) as typeof before;
    expect(corrupt.events.length).toBeGreaterThan(0);
    corrupt.events[0] = { ...corrupt.events[0], startTime: "05:00", endTime: "05:30" };

    expect(() => admin.importBackup(corrupt, "replace")).toThrow(/Поточні дані не змінено/);
    expect(() => admin.importBackup(corrupt, "merge")).toThrow(/Поточні дані не змінено/);

    const after = exportModule.exportBackup();
    expect(withoutExportedAt(after)).toEqual(withoutExportedAt(before));
    expect(workspace.loadWorkspace().state.events.some((event) => event.startTime === "05:00")).toBe(false);
  });
});

describe("shared schedule-state validation and integrity on version restore", () => {
  // TEST F — an invalid historical snapshot cannot modify the database.
  it("refuses to restore snapshots with out-of-range, reversed or broken content", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;

    // (a) event outside the schedule window
    const tooEarly = snapshotOf(scheduleId);
    tooEarly.events[0] = { ...tooEarly.events[0], startTime: "05:00", endTime: "05:30" };
    const badEarly = workspace.createVersion({
      scheduleId,
      source: "manual",
      description: "знімок поза межами",
      snapshot: tooEarly,
    });

    // (b) reversed event range (audit probe: 18:00–09:00)
    const reversed = snapshotOf(scheduleId);
    reversed.events[0] = { ...reversed.events[0], startTime: "18:00", endTime: "09:00" };
    const badReversed = workspace.createVersion({
      scheduleId,
      source: "manual",
      description: "перевернутий діапазон",
      snapshot: reversed,
    });

    // (c) reversed schedule window
    const badWindow = snapshotOf(scheduleId);
    badWindow.settings = { ...badWindow.settings, startTime: "18:00", endTime: "09:00" };
    const badWindowVersion = workspace.createVersion({
      scheduleId,
      source: "manual",
      description: "перевернуте вікно",
      snapshot: badWindow,
    });

    // (d) broken required reference (trainer that exists nowhere)
    const brokenRefs = snapshotOf(scheduleId);
    brokenRefs.events[0] = { ...brokenRefs.events[0], trainerId: "trn-vanished" };
    brokenRefs.trainers = brokenRefs.trainers.filter((trainer) => trainer.id !== "trn-vanished");
    const badRefs = workspace.createVersion({
      scheduleId,
      source: "manual",
      description: "зруйновані посилання",
      snapshot: brokenRefs,
    });

    const versionsBefore = workspace.listVersions(scheduleId);
    const eventsBefore = before.state.events;
    const settingsBefore = before.state.settings;

    expect(() => workspace.restoreVersion(badEarly.id)).toThrow();
    expect(() => workspace.restoreVersion(badReversed.id)).toThrow();
    expect(() => workspace.restoreVersion(badWindowVersion.id)).toThrow();
    expect(() => workspace.restoreVersion(badRefs.id)).toThrow();

    const after = workspace.loadWorkspace();
    expect(after.state.events).toEqual(eventsBefore);
    expect(after.state.settings).toEqual(settingsBefore);
    // Version history is consistent: failed restores add no entries.
    expect(workspace.listVersions(scheduleId)).toEqual(versionsBefore);
    expect(workspace.listVersions(scheduleId).some((version) => version.source === "restore")).toBe(false);
  });

  // TEST G — missing room restore: recreated insert-only, reference stays valid.
  it("recreates a deleted referenced room insert-only and restores a valid room reference", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    admin.upsertRoom({ id: "room-x", name: "Зал X", active: true, sortOrder: 7 });
    const withRoom = baseEvent(scheduleId, before.trainers[0].id, before.classTypes[0].id, {
      id: "evt-room-x",
      dayOfWeek: 3,
      roomId: "room-x",
      notes: "мала зала",
    });
    workspace.saveScheduleState({
      scheduleId,
      events: [...before.state.events, withRoom],
      settings: before.state.settings,
    });
    const version = workspace.createVersion({ scheduleId, source: "manual", description: "із залом X" });

    // Remove every current reference, then delete the room for good.
    const withoutEvent = workspace.loadWorkspace();
    workspace.saveScheduleState({
      scheduleId,
      events: withoutEvent.state.events.filter((event) => event.id !== "evt-room-x"),
      settings: withoutEvent.state.settings,
    });
    const deletion = admin.deleteRoom("room-x");
    expect(deletion).toEqual({ deactivated: false });
    expect(workspace.loadWorkspace().rooms.some((room) => room.id === "room-x")).toBe(false);

    const result = workspace.restoreVersion(version.id);
    expect(result.scheduleId).toBe(scheduleId);

    const after = workspace.loadWorkspace();
    const room = after.rooms.find((item) => item.id === "room-x");
    expect(room).toBeDefined();
    expect(room?.name).toBe("Зал X");
    const restored = after.state.events.find((event) => event.id === "evt-room-x");
    expect(restored?.roomId).toBe("room-x");
    // Never an orphan: the restored event's room reference resolves.
    expect(after.rooms.some((item) => item.id === restored?.roomId)).toBe(true);
  });

  // TEST H — an existing room is never overwritten by a restore.
  it("keeps current workspace room metadata when the snapshot holds older metadata", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    admin.upsertRoom({ id: "room-h", name: "Зал H (старий)", active: true, sortOrder: 4 });
    const withRoom = baseEvent(scheduleId, before.trainers[0].id, before.classTypes[0].id, {
      id: "evt-room-h",
      dayOfWeek: 4,
      roomId: "room-h",
    });
    workspace.saveScheduleState({
      scheduleId,
      events: [...before.state.events, withRoom],
      settings: before.state.settings,
    });
    const version = workspace.createVersion({ scheduleId, source: "manual", description: "із залом H" });

    // Newer workspace-level metadata that the restore must not revert.
    admin.upsertRoom({ id: "room-h", name: "Зал H (новий)", active: false, sortOrder: 1 });

    workspace.restoreVersion(version.id);

    const after = workspace.loadWorkspace();
    expect(after.rooms.find((room) => room.id === "room-h")).toEqual({
      id: "room-h",
      name: "Зал H (новий)",
      active: false,
      sortOrder: 1,
    });
    const restored = after.state.events.find((event) => event.id === "evt-room-h");
    expect(restored?.roomId).toBe("room-h");
  });

  // TEST I — restore failure rollback (mid-transaction event write).
  it("rolls back entity recreation and state replacement when the restore fails mid-transaction", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    const snapshot = snapshotOf(scheduleId);
    expect(snapshot.events.length).toBeGreaterThanOrEqual(2);
    // A room the restore would recreate insert-only …
    snapshot.rooms = [...snapshot.rooms, { id: "room-ghost", name: "Привид", active: true, sortOrder: 42 }];
    // … and two events sharing one primary key, so the insert fails mid-flight.
    snapshot.events = [
      { ...snapshot.events[0], id: "evt-collision" },
      { ...snapshot.events[1], id: "evt-collision" },
    ];
    const version = workspace.createVersion({ scheduleId, source: "manual", description: "аварійний знімок", snapshot });
    const versionsBefore = workspace.listVersions(scheduleId);

    expect(() => workspace.restoreVersion(version.id)).toThrow(/Не вдалося відновити версію/);

    const after = workspace.loadWorkspace();
    expect(after.state.events).toEqual(before.state.events);
    expect(after.state.settings).toEqual(before.state.settings);
    expect(after.rooms.some((room) => room.id === "room-ghost")).toBe(false);
    expect(after.rooms).toEqual(before.rooms);
    expect(workspace.listVersions(scheduleId)).toEqual(versionsBefore);
  });

  // TEST I — restore failure rollback at the version checkpoint (last step).
  it("rolls back the whole restore when the restore checkpoint cannot be written", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    const snapshot = snapshotOf(scheduleId);
    snapshot.rooms = [...snapshot.rooms, { id: "room-ghost-2", name: "Привид 2", active: true, sortOrder: 43 }];
    snapshot.events = snapshot.events.map((event) => ({ ...event, roomId: "room-ghost-2" }));
    const version = workspace.createVersion({ scheduleId, source: "manual", description: "аварійна точка", snapshot });
    const versionsBefore = workspace.listVersions(scheduleId);

    // The checkpoint id collides with an existing version: the failure happens
    // at the LAST write of the restore and must still roll back everything.
    const spy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(version.id as `${string}-${string}-${string}-${string}-${string}`);
    try {
      expect(() => workspace.restoreVersion(version.id)).toThrow(/Не вдалося відновити версію/);
    } finally {
      spy.mockRestore();
    }

    const after = workspace.loadWorkspace();
    expect(after.state.events).toEqual(before.state.events);
    expect(after.state.settings).toEqual(before.state.settings);
    expect(after.rooms.some((room) => room.id === "room-ghost-2")).toBe(false);
    expect(workspace.listVersions(scheduleId)).toEqual(versionsBefore);
  });
});

describe("product warnings stay warnings", () => {
  // TEST J — eligibility/clash/duplicate warnings must never block a save.
  it("persists a save that only carries eligibility, clash and duplicate warnings", () => {
    const before = workspace.loadWorkspace();
    const scheduleId = before.activeScheduleId;
    const source = before.state.events.find((event) => event.roomId === "room-x") ?? before.state.events[0];
    const ineligibleClass = before.classTypes.find(
      (classType) =>
        classType.id !== source.classTypeId &&
        classType.trainerIds.length > 0 &&
        !classType.trainerIds.includes(source.trainerId),
    );
    expect(ineligibleClass).toBeDefined();

    const clone: ScheduleEvent = { ...source, id: "evt-warning-clone" };
    const ineligible: ScheduleEvent = { ...source, id: "evt-ineligible", classTypeId: ineligibleClass!.id };

    const result = workspace.saveScheduleState({
      scheduleId,
      events: [...before.state.events, clone, ineligible],
      settings: before.state.settings,
    });
    expect(result.warnings.length).toBeGreaterThan(0);

    const after = workspace.loadWorkspace();
    expect(after.state.events.some((event) => event.id === "evt-warning-clone")).toBe(true);
    expect(after.state.events.some((event) => event.id === "evt-ineligible")).toBe(true);
  });
});
