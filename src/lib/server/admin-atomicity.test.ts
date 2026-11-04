import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  scheduleEvents,
  scheduleSettings,
  scheduleVersions,
  schedules,
} from "@/db/schema";
import type { BackupPayload } from "@/lib/server/backup-types";

/**
 * Administrative-mutation atomicity (TESTS A–K).
 *
 * Every test runs against a real SQLite file in a temporary directory
 * (`RISEN_DB_PATH`) — real user data is never touched. The rollback tests
 * inject a failure INSIDE the database transaction and then prove the database
 * is byte-identical to the captured export, which is the only acceptable proof
 * of atomicity.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-admin-atomicity-"));
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

/** Deep-cloned snapshot of the whole persisted graph. */
function snapshot(): BackupPayload {
  return JSON.parse(JSON.stringify(exportModule.exportBackup())) as BackupPayload;
}

function withoutExportedAt(backup: BackupPayload) {
  const { exportedAt: _exportedAt, ...rest } = backup;
  return rest;
}

/** The database must be byte-identical to the captured snapshot. */
function expectUnchanged(before: BackupPayload) {
  expect(withoutExportedAt(exportModule.exportBackup())).toEqual(withoutExportedAt(before));
}

describe("legacy catalogue cascade deletion", () => {
  it.each(["trainer", "class"])("removes a referenced %s and events while keeping snapshots restorable", async entity => {
    const trainerId=`legacy-cascade-trainer-${entity}`,classTypeId=`legacy-cascade-class-${entity}`;
    await admin.upsertTrainer({id:trainerId,name:"Cascade trainer",color:"#112233",active:true,sortOrder:99});
    await admin.upsertClassType({id:classTypeId,name:"Cascade class",shortName:"C",defaultDuration:60,active:true,sortOrder:99,trainerIds:[trainerId]});
    const before=workspace.loadWorkspace();
    const event={id:`legacy-cascade-event-${entity}`,scheduleId:before.activeScheduleId,trainerId,classTypeId,dayOfWeek:3,startTime:"10:00",endTime:"11:00"};
    workspace.saveScheduleState({scheduleId:before.activeScheduleId,settings:before.state.settings,events:[...before.state.events,event]});
    const version=workspace.createVersion({scheduleId:before.activeScheduleId,source:"manual",description:"Before cascade"});
    expect(entity === "trainer" ? admin.deleteTrainer(trainerId) : admin.deleteClassType(classTypeId)).toEqual({deactivated:false});
    const after=workspace.loadWorkspace();
    expect(after.state.events).toEqual(before.state.events);
    expect(entity === "trainer" ? after.trainers.some(item=>item.id===trainerId) : after.classTypes.some(item=>item.id===classTypeId)).toBe(false);
    workspace.restoreVersion(version.id);
    expect(workspace.loadWorkspace().state.events.some(item=>item.id===event.id)).toBe(true);
  });
});

/**
 * Raw table counters for one schedule. The portable export synthesizes a
 * default settings row for a schedule that lost its own, so "no row left
 * behind" has to be witnessed on the tables themselves.
 */
function rawScheduleRows(id: string) {
  const db = dbModule.getDb();
  return {
    schedules: db.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, id)).all().length,
    settings: db
      .select({ id: scheduleSettings.scheduleId })
      .from(scheduleSettings)
      .where(eq(scheduleSettings.scheduleId, id))
      .all().length,
    events: db
      .select({ id: scheduleEvents.id })
      .from(scheduleEvents)
      .where(eq(scheduleEvents.scheduleId, id))
      .all().length,
    versions: db
      .select({ id: scheduleVersions.id })
      .from(scheduleVersions)
      .where(eq(scheduleVersions.scheduleId, id))
      .all().length,
  };
}

/**
 * Wraps `db.transaction` so that the Nth write call of `kind` (per kind, inside
 * that transaction) throws — the same technique the backup-import rollback test
 * uses, applied to the administrative mutations.
 */
function failInsideTransaction(kind: "insert" | "update" | "delete", failAt: number) {
  const db = dbModule.getDb();
  const runTransaction = db.transaction.bind(db);
  const counter = { calls: 0 };
  const spy = vi.spyOn(db, "transaction");
  spy.mockImplementation((handler: Parameters<typeof db.transaction>[0]) => {
    const fn = handler as unknown as (tx: Record<string, unknown>) => unknown;
    return runTransaction((tx) => {
      const runner = tx as unknown as Record<string, (...args: unknown[]) => unknown>;
      const original = runner[kind].bind(runner);
      runner[kind] = (...args: unknown[]) => {
        counter.calls += 1;
        if (counter.calls === failAt) throw new Error("injected failure");
        return original(...args);
      };
      return fn(tx as unknown as Record<string, unknown>);
    }) as never;
  });
  return { counter, restore: () => spy.mockRestore() };
}

async function createSchedule(name: string): Promise<string> {
  const result = await admin.scheduleAction({ action: "create", name });
  return result.activeScheduleId as string;
}

function inactiveScheduleId(): string {
  const inActive = snapshot().schedules.find((schedule) => !schedule.isActive);
  if (!inActive) throw new Error("fixture error: no inactive schedule available");
  return inActive.id;
}

function activeScheduleId(): string {
  const active = snapshot().schedules.find((schedule) => schedule.isActive);
  if (!active) throw new Error("fixture error: no active schedule available");
  return active.id;
}

/** Keeps the workspace large enough for the deletion tests. */
async function ensureScheduleCount(count: number): Promise<void> {
  let current = snapshot().schedules.length;
  while (current < count) {
    await createSchedule(`fixture-${current}`);
    current += 1;
  }
}

describe("atomic schedule deletion", () => {
  // TEST A — deleting an inactive schedule removes every associated row.
  it("TEST A — deletes an inactive schedule together with all of its rows", async () => {
    const originalActive = activeScheduleId();
    const copyId = (await admin.scheduleAction({ action: "duplicate", sourceId: originalActive, name: "A-copy" }))
      .activeScheduleId as string;
    // The copy is active right after duplicating; open the original again so the
    // copy is the inactive target of this test.
    await admin.scheduleAction({ action: "activate", id: originalActive });

    const before = snapshot();
    const copy = before.schedules.find((schedule) => schedule.id === copyId);
    expect(copy?.isActive).toBe(false);
    expect(before.events.filter((event) => event.scheduleId === copyId).length).toBeGreaterThan(0);
    expect(before.settings.some((settings) => settings.scheduleId === copyId)).toBe(true);
    expect(before.versions.filter((version) => version.scheduleId === copyId).length).toBeGreaterThan(0);

    const result = await admin.scheduleAction({ action: "delete", id: copyId });

    const after = snapshot();
    expect(after.schedules.some((schedule) => schedule.id === copyId)).toBe(false);
    expect(after.settings.some((settings) => settings.scheduleId === copyId)).toBe(false);
    expect(after.events.some((event) => event.scheduleId === copyId)).toBe(false);
    expect(after.versions.some((version) => version.scheduleId === copyId)).toBe(false);
    // … and the raw tables agree (the export would hide a leftover settings row).
    expect(rawScheduleRows(copyId)).toEqual({ schedules: 0, settings: 0, events: 0, versions: 0 });

    // Nothing else moved: the untouched schedule keeps its rows and stays active.
    expect(after.events.filter((event) => event.scheduleId === originalActive)).toEqual(
      before.events.filter((event) => event.scheduleId === originalActive),
    );
    expect(after.settings.find((settings) => settings.scheduleId === originalActive)).toEqual(
      before.settings.find((settings) => settings.scheduleId === originalActive),
    );
    expect(after.schedules.filter((schedule) => schedule.isActive).map((schedule) => schedule.id)).toEqual([
      originalActive,
    ]);
    expect(result.activeScheduleId).toBe(originalActive);
  });

  // TEST B — deleting the active schedule selects the proper fallback.
  it("TEST B — deleting the active schedule activates exactly one valid fallback", async () => {
    const first = await createSchedule("B-first");
    await createSchedule("B-second");
    await admin.scheduleAction({ action: "activate", id: first });

    const result = await admin.scheduleAction({ action: "delete", id: first });
    const after = snapshot();

    expect(after.schedules.some((schedule) => schedule.id === first)).toBe(false);
    const active = after.schedules.filter((schedule) => schedule.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].isArchived).toBe(false);
    expect(result.activeScheduleId).toBe(active[0].id);
    expect(workspace.loadWorkspace().activeScheduleId).toBe(active[0].id);

    // Deterministic product rule: most recently updated non-archived schedule,
    // id as tie-breaker — never an arbitrary row, never an archived one. The
    // portable export has no `updatedAt`, so the raw rows are the witness.
    const rows = dbModule.getDb().select().from(schedules).all();
    const expected = rows
      .filter((schedule) => !schedule.isArchived)
      .sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id),
      )[0];
    expect(active[0].id).toBe(expected.id);
  });

  // TEST C — a failure after some delete statements rolls everything back.
  it("TEST C — rolls back every statement and the active state on a mid-delete failure", async () => {
    await ensureScheduleCount(3);
    const target = inactiveScheduleId();
    const before = snapshot();
    expect(before.events.some((event) => event.scheduleId === target)).toBe(true);
    expect(before.versions.some((version) => version.scheduleId === target)).toBe(true);
    const rowsBefore = rawScheduleRows(target);
    expect(rowsBefore.schedules).toBe(1);
    expect(rowsBefore.settings).toBe(1);
    const activeBefore = before.schedules.filter((schedule) => schedule.isActive).map((schedule) => schedule.id);

    // Writes inside the deletion transaction: settings → events → versions →
    // schedule. Failing on the third means rows were already deleted.
    const failure = failInsideTransaction("delete", 3);
    try {
      await expect(admin.scheduleAction({ action: "delete", id: target })).rejects.toThrow(
        /Не вдалося видалити розклад/,
      );
    } finally {
      failure.restore();
    }

    expect(failure.counter.calls).toBe(3);
    expectUnchanged(before);
    // The statements that already ran (settings + events deletion) are undone
    // row by row — not just as far as the portable export can see.
    expect(rawScheduleRows(target)).toEqual(rowsBefore);
    expect(
      snapshot().schedules.filter((schedule) => schedule.isActive).map((schedule) => schedule.id),
    ).toEqual(activeBefore);
  });
});

describe("atomic class type + trainer links", () => {
  // TEST D — metadata + links update together.
  it("TEST D — writes class metadata and its trainer links in one operation", async () => {
    const before = snapshot();
    const classType = before.classTypes[0];
    const earlier = before.classTypes.find((item) => item.id !== classType.id);
    const nextLinks = [before.trainers[4].id, before.trainers[1].id];
    expect(nextLinks[0]).not.toBe(nextLinks[1]);
    expect(earlier).toBeDefined();

    const updated = await admin.upsertClassType({
      ...classType,
      name: `${classType.name} (D)`,
      trainerIds: nextLinks,
    });

    const after = snapshot();
    const row = after.classTypes.find((item) => item.id === classType.id);
    expect(row?.name).toBe(`${classType.name} (D)`);
    expect([...(row?.trainerIds ?? [])].sort()).toEqual([...nextLinks].sort());
    expect(updated.trainerIds).toEqual(nextLinks);
    // Other class types (metadata + links) are untouched.
    expect(after.classTypes.filter((item) => item.id !== classType.id)).toEqual(
      before.classTypes.filter((item) => item.id !== classType.id),
    );
  });

  // TEST E — unknown trainer ids are rejected before any mutation.
  it("TEST E — rejects an unknown trainer id before writing anything", async () => {
    const before = snapshot();
    const classType = before.classTypes[0];

    await expect(
      admin.upsertClassType({
        ...classType,
        name: `${classType.name} (E)`,
        trainerIds: ["trainer-that-does-not-exist"],
      }),
    ).rejects.toThrow(/Тренера «trainer-that-does-not-exist» не існує/);

    // The new name must not have landed either: the save never started.
    expectUnchanged(before);
  });

  // TEST F — a failure between the metadata write and the link write rolls back.
  it("TEST F — rolls back class metadata AND links when the link write fails", async () => {
    const before = snapshot();
    const classType = before.classTypes.find((item) => item.trainerIds.length > 0);
    expect(classType).toBeDefined();
    const target = classType as (typeof before.classTypes)[number];
    const nextLinks = [before.trainers[0].id, before.trainers[2].id];

    // Writes: 1 = class type row, 2 = the trainer link insert (after the link
    // deletion already ran) → the metadata write is definitely undone too.
    const failure = failInsideTransaction("insert", 2);
    try {
      await expect(
        admin.upsertClassType({ ...target, name: `${target.name} (F)`, trainerIds: nextLinks }),
      ).rejects.toThrow(/Не вдалося зберегти тип заняття/);
    } finally {
      failure.restore();
    }

    expect(failure.counter.calls).toBe(2);
    expectUnchanged(before);
  });
});

describe("atomic trainer save with several class links", () => {
  // TEST G — one trainer edit changes several class links, all atomically.
  it("TEST G — updates every affected class link in one save", async () => {
    const before = snapshot();
    const trainer = before.trainers[0];
    const linkedBefore = before.classTypes
      .filter((classType) => classType.trainerIds.includes(trainer.id))
      .map((classType) => classType.id);
    const targetLinks = before.classTypes
      .filter((classType) => !linkedBefore.includes(classType.id))
      .slice(0, 3)
      .map((classType) => classType.id);
    expect(linkedBefore.length).toBeGreaterThan(0);
    expect(targetLinks.length).toBe(3);

    await admin.upsertTrainer({
      trainer: { ...trainer, name: `${trainer.name} (G)` },
      classTypeIds: targetLinks,
    });

    const after = snapshot();
    expect(after.trainers.find((item) => item.id === trainer.id)?.name).toBe(`${trainer.name} (G)`);
    expect(
      after.classTypes
        .filter((classType) => classType.trainerIds.includes(trainer.id))
        .map((classType) => classType.id)
        .sort(),
    ).toEqual([...targetLinks].sort());

    // Every OTHER trainer's links are exactly as before — on every class type.
    for (const classType of after.classTypes) {
      const original = before.classTypes.find((item) => item.id === classType.id);
      expect(classType.trainerIds.filter((id) => id !== trainer.id).sort()).toEqual(
        (original?.trainerIds ?? []).filter((id) => id !== trainer.id).sort(),
      );
    }
  });

  // TEST H — a failure midway leaves all links exactly as before.
  it("TEST H — rolls back the trainer row and every link on a mid-save failure", async () => {
    const before = snapshot();
    const trainer = before.trainers.find((item) =>
      before.classTypes.some((classType) => classType.trainerIds.includes(item.id)),
    );
    expect(trainer).toBeDefined();
    const target = trainer as (typeof before.trainers)[number];
    const targetLinks = before.classTypes
      .filter((classType) => !classType.trainerIds.includes(target.id))
      .slice(0, 2)
      .map((classType) => classType.id);
    expect(targetLinks.length).toBe(2);

    // Writes: 1 = trainer row, 2 = the new link rows (after link deletions).
    const failure = failInsideTransaction("insert", 2);
    try {
      await expect(
        admin.upsertTrainer({ trainer: { ...target, name: `${target.name} (H)` }, classTypeIds: targetLinks }),
      ).rejects.toThrow(/Не вдалося зберегти зміни тренера/);
    } finally {
      failure.restore();
    }

    expect(failure.counter.calls).toBe(2);
    expectUnchanged(before);
  });
});

describe("atomic reorder", () => {
  // TEST I — batch reorder applies every sort order consistently.
  it("TEST I — applies one deterministic order for the whole list", () => {
    const before = snapshot();
    const trainerOrder = [...before.trainers].sort((a, b) => b.id.localeCompare(a.id)).map((item) => item.id);
    const classOrder = [...before.classTypes].sort((a, b) => b.id.localeCompare(a.id)).map((item) => item.id);

    expect(admin.reorderEntities({ entity: "trainers", order: trainerOrder })).toEqual({
      entity: "trainers",
      order: trainerOrder,
    });
    expect(admin.reorderEntities({ entity: "classTypes", order: classOrder })).toEqual({
      entity: "classTypes",
      order: classOrder,
    });

    const after = snapshot();
    expect([...after.trainers].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => item.id)).toEqual(trainerOrder);
    expect([...after.classTypes].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => item.id)).toEqual(classOrder);
    expect(after.trainers.map((item) => item.sortOrder).sort((a, b) => a - b)).toEqual(
      trainerOrder.map((_id, index) => index),
    );
    expect(after.classTypes.map((item) => item.sortOrder).sort((a, b) => a - b)).toEqual(
      classOrder.map((_id, index) => index),
    );
    // The lists the app loads follow the new order.
    expect(workspace.loadWorkspace().trainers.map((item) => item.id)).toEqual(trainerOrder);
    // Nothing else changed: same links, same schedules, same events.
    expect(after.classTypes.map((item) => ({ id: item.id, trainerIds: item.trainerIds }))).toEqual(
      before.classTypes.map((item) => ({ id: item.id, trainerIds: item.trainerIds })),
    );
    expect(after.events).toEqual(before.events);
  });

  // TEST J — invalid order lists are rejected before any mutation.
  it("TEST J — rejects unknown, duplicated and stale order lists before any write", () => {
    const before = snapshot();
    const ids = before.trainers.map((item) => item.id);

    expect(() => admin.reorderEntities({ entity: "trainers", order: [...ids, "trainer-that-does-not-exist"] })).toThrow(
      /невідомий запис «trainer-that-does-not-exist»/,
    );
    expect(() => admin.reorderEntities({ entity: "trainers", order: [...ids, ids[0]] })).toThrow(/повторюється/);
    expect(() => admin.reorderEntities({ entity: "trainers", order: ids.slice(1) })).toThrow(/список застарів/);
    expect(() => admin.reorderEntities({ entity: "classTypes", order: ["class-that-does-not-exist"] })).toThrow(
      /невідомий запис/,
    );

    expectUnchanged(before);
  });

  // TEST K — a failure mid-batch preserves all previous sort orders.
  it("TEST K — rolls the whole batch back when one update fails", () => {
    const before = snapshot();
    const order = [...before.trainers].sort((a, b) => b.id.localeCompare(a.id)).map((item) => item.id);

    const failure = failInsideTransaction("update", 3);
    try {
      expect(() => admin.reorderEntities({ entity: "trainers", order })).toThrow(/Не вдалося зберегти порядок/);
    } finally {
      failure.restore();
    }

    expect(failure.counter.calls).toBe(3);
    expectUnchanged(before);
    expect(snapshot().trainers.map((item) => item.sortOrder)).toEqual(before.trainers.map((item) => item.sortOrder));
  });
});

describe("schedule lifecycle invariants", () => {
  // Bonus (same risk class): archive/unarchive/activate keep the active flag
  // consistent instead of relying on statement order.
  it("keeps exactly one active schedule when archiving and unarchiving", async () => {
    await ensureScheduleCount(2);
    const target = inactiveScheduleId();
    const activesBefore = snapshot().schedules.filter((schedule) => schedule.isActive).map((schedule) => schedule.id);

    const archived = await admin.scheduleAction({ action: "archive", id: target });
    const afterArchive = snapshot();
    expect(afterArchive.schedules.find((schedule) => schedule.id === target)?.isArchived).toBe(true);
    expect(afterArchive.schedules.find((schedule) => schedule.id === target)?.isActive).toBe(false);
    expect(afterArchive.schedules.filter((schedule) => schedule.isActive).map((schedule) => schedule.id)).toEqual(
      activesBefore,
    );
    expect(archived.activeScheduleId).toBe(activesBefore[0]);

    await admin.scheduleAction({ action: "unarchive", id: target });
    expect(snapshot().schedules.filter((schedule) => schedule.isActive).map((schedule) => schedule.id)).toEqual(
      activesBefore,
    );

    // An archived schedule is never made active by "opening" it from the selector.
    await admin.scheduleAction({ action: "archive", id: target });
    await admin.scheduleAction({ action: "activate", id: target });
    const afterOpenArchived = snapshot();
    expect(afterOpenArchived.schedules.find((schedule) => schedule.id === target)?.isActive).toBe(false);
    expect(afterOpenArchived.schedules.filter((schedule) => schedule.isActive)).toHaveLength(1);
    await admin.scheduleAction({ action: "unarchive", id: target });
  });
});
