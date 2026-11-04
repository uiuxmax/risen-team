import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type SnapshotContent } from "@/lib/domain/types";
import type { BackupPayload } from "@/lib/server/backup-types";
import { emptyPreflightContext, parseBackupPayload, validateBackupPreflight } from "@/lib/server/backup-validation";
import { initializeDatabaseForPath, openDatabase } from "@/db";
import {
  DatabaseMigrationError,
  LEGACY_V0_SCHEMA_SQL,
  LATEST_SCHEMA_VERSION,
  migrationTestHooks,
} from "@/db/migrations";
import { LEGACY_V0_TABLES } from "@/db/migration-validation";
import { backupFileSystem } from "@/lib/server/backups";

/**
 * v0 → v1 migration integration suite.
 *
 * Every fixture is a separate database under `os.tmpdir()` and is built with
 * `LEGACY_V0_SCHEMA_SQL`, the exact schema from immediately before versioned
 * migrations. No test opens, deletes or mutates data/risen-team.db.
 */

const tempRoots: string[] = [];
const NOW = 1_735_689_600_123;

function temporaryDatabase(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `risen-migration-${label}-`));
  tempRoots.push(root);
  return path.join(root, "risen-team.db");
}

function closeDb(db: { $client: Database.Database }): void {
  db.$client.close();
}

function snapshotFor(scheduleId: string, scheduleName: string, eventId: string): string {
  const snapshot: SnapshotContent = {
    schemaVersion: 1,
    schedule: { id: scheduleId, name: scheduleName, status: scheduleId === "sched-active" ? "published" : "draft" },
    settings: { ...DEFAULT_SETTINGS },
    events: [
      {
        id: eventId,
        scheduleId,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "10:00",
        trainerId: "trn-a",
        classTypeId: "cls-box",
        roomId: "room-main",
        notes: "legacy event",
      },
    ],
    trainers: [
      { id: "trn-a", name: "Ada", color: "#8b5cf6", initials: "A", notes: null, active: true, sortOrder: 0 },
      { id: "trn-b", name: "Bohdan", color: "#0ea5e9", initials: "B", notes: null, active: true, sortOrder: 1 },
    ],
    classTypes: [
      {
        id: "cls-box",
        name: "Boxing",
        shortName: "BOX",
        defaultDuration: 60,
        color: null,
        description: null,
        active: true,
        sortOrder: 0,
        trainerIds: ["trn-a"],
      },
      {
        id: "cls-yoga",
        name: "Yoga",
        shortName: "YOGA",
        defaultDuration: 45,
        color: null,
        description: null,
        active: true,
        sortOrder: 1,
        trainerIds: ["trn-b"],
      },
    ],
    rooms: [{ id: "room-main", name: "Main hall", active: true, sortOrder: 0 }],
  };
  return JSON.stringify(snapshot);
}

/** Creates a representative actual v0 database, never a v1 lookalike. */
function createLegacyFixture(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  try {
    sqlite.exec(LEGACY_V0_SCHEMA_SQL);
    sqlite.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run("seeded", "legacy-fixture");

    const insertTrainer = sqlite.prepare(
      `INSERT INTO trainers (id, name, color, initials, notes, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertTrainer.run("trn-a", "Ada", "#8b5cf6", "A", null, 1, 0, NOW, NOW + 1);
    insertTrainer.run("trn-b", "Bohdan", "#0ea5e9", "B", "legacy note", 1, 1, NOW + 2, NOW + 3);

    const insertClass = sqlite.prepare(
      `INSERT INTO class_types
        (id, name, short_name, default_duration, color, description, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertClass.run("cls-box", "Boxing", "BOX", 60, null, null, 1, 0, NOW, NOW + 1);
    insertClass.run("cls-yoga", "Yoga", "YOGA", 45, "#14b8a6", "flexibility", 1, 1, NOW + 2, NOW + 3);
    sqlite.prepare("INSERT INTO trainer_class_types (trainer_id, class_type_id) VALUES (?, ?)").run("trn-a", "cls-box");
    sqlite.prepare("INSERT INTO trainer_class_types (trainer_id, class_type_id) VALUES (?, ?)").run("trn-b", "cls-yoga");
    sqlite.prepare("INSERT INTO rooms (id, name, active, sort_order) VALUES (?, ?, ?, ?)").run("room-main", "Main hall", 1, 0);

    const insertSchedule = sqlite.prepare(
      `INSERT INTO schedules
        (id, name, status, is_active, is_archived, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSchedule.run("sched-active", "Current schedule", "published", 1, 0, NOW, NOW, NOW + 10);
    insertSchedule.run("sched-inactive", "Summer schedule", "draft", 0, 0, null, NOW + 20, NOW + 21);
    insertSchedule.run("sched-archived", "Archived schedule", "draft", 0, 1, null, NOW + 22, NOW + 23);

    const insertSettings = sqlite.prepare(
      `INSERT INTO schedule_settings (
        schedule_id, visible_days, start_time, end_time, default_interval, custom_markers, snap_minutes,
        theme_id, show_trainer_legend, legend_position, show_logo, logo_data_url, schedule_title,
        schedule_subtitle, effective_date, export_paper, export_orientation, export_scale,
        custom_export_width, custom_export_height, autosave, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, title] of [
      ["sched-active", "Current"],
      ["sched-inactive", "Summer"],
      ["sched-archived", "Archived"],
    ] as const) {
      insertSettings.run(
        id,
        JSON.stringify(DEFAULT_SETTINGS.visibleDays),
        "07:00",
        "21:00",
        60,
        JSON.stringify(["12:00"]),
        15,
        "risen-team-dark",
        1,
        "right",
        1,
        null,
        title,
        "Legacy fixture",
        null,
        "original",
        "landscape",
        2,
        1680,
        880,
        1,
        NOW + 30,
      );
    }

    const insertEvent = sqlite.prepare(
      `INSERT INTO schedule_events
        (id, schedule_id, day_of_week, start_time, end_time, trainer_id, class_type_id, room_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEvent.run("evt-active", "sched-active", 1, "09:00", "10:00", "trn-a", "cls-box", "room-main", "legacy event", NOW, NOW + 1);
    insertEvent.run(
      "evt-inactive",
      "sched-inactive",
      2,
      "09:00",
      "10:00",
      "trn-a",
      "cls-box",
      "room-main",
      null,
      NOW + 2,
      NOW + 3,
    );
    insertEvent.run(
      "evt-archived",
      "sched-archived",
      3,
      "09:00",
      "10:00",
      "trn-a",
      "cls-box",
      "room-main",
      null,
      NOW + 4,
      NOW + 5,
    );

    const insertVersion = sqlite.prepare(
      `INSERT INTO schedule_versions
        (id, schedule_id, created_at, source, description, snapshot, restored_from_version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // Deliberately insert the restore checkpoint before its target. v0 had no
    // self-FK, and v1 must preserve this realistic historical row ordering by
    // staging restored_from_version_id until all version ids are copied.
    insertVersion.run(
      "ver-active-restored",
      "sched-active",
      NOW + 101,
      "restore",
      "legacy restore version",
      snapshotFor("sched-active", "Current schedule", "evt-active"),
      "ver-active-base",
    );
    insertVersion.run(
      "ver-active-base",
      "sched-active",
      NOW + 100,
      "manual",
      "legacy base version",
      snapshotFor("sched-active", "Current schedule", "evt-active"),
      null,
    );
    insertVersion.run(
      "ver-inactive",
      "sched-inactive",
      NOW + 102,
      "manual",
      "legacy inactive version",
      snapshotFor("sched-inactive", "Summer schedule", "evt-inactive"),
      null,
    );
  } finally {
    sqlite.close();
  }
}

function queryRows(sqlite: Database.Database, table: string): unknown[] {
  const orderBy: Record<string, string> = {
    app_meta: "key",
    schedules: "id",
    trainers: "id",
    class_types: "id",
    trainer_class_types: "trainer_id, class_type_id",
    rooms: "id",
    schedule_events: "id",
    schedule_settings: "schedule_id",
    schedule_versions: "id",
  };
  return sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy[table]}`).all();
}

function dumpMeaningfulData(dbPath: string) {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return Object.fromEntries(LEGACY_V0_TABLES.map((table) => [table, queryRows(sqlite, table)]));
  } finally {
    sqlite.close();
  }
}

/**
 * The normal portable backup deliberately excludes implementation timestamps
 * such as a trainer row's `updated_at`; Replace import writes those anew. This
 * is the complete user-visible/importable graph that the v0 source and the
 * migration-created JSON safety copy must represent identically.
 */
type MeaningfulGraph = {
  schedules: unknown[];
  trainers: unknown[];
  classTypes: unknown[];
  eligibilityLinks: unknown[];
  rooms: unknown[];
  events: unknown[];
  settings: unknown[];
  versions: unknown[];
};

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function parseStoredJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("fixture expected a JSON SQLite text value");
  return JSON.parse(value) as T;
}

function toIso(value: unknown): string {
  return new Date(Number(value)).toISOString();
}

function asRows(rows: unknown[]): Record<string, unknown>[] {
  return rows as Record<string, unknown>[];
}

/** Normalizes either v0 or v1 raw tables to the supported backup graph. */
function meaningfulGraphFromDatabase(dbPath: string): MeaningfulGraph {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const schedulesRows = asRows(queryRows(sqlite, "schedules"));
    const trainerRows = asRows(queryRows(sqlite, "trainers"));
    const classTypeRows = asRows(queryRows(sqlite, "class_types"));
    const linkRows = asRows(queryRows(sqlite, "trainer_class_types"));
    const roomRows = asRows(queryRows(sqlite, "rooms"));
    const eventRows = asRows(queryRows(sqlite, "schedule_events"));
    const settingsRows = asRows(queryRows(sqlite, "schedule_settings"));
    const versionRows = asRows(queryRows(sqlite, "schedule_versions"));

    const trainerIdsByClassType = new Map<string, string[]>();
    for (const link of linkRows) {
      const classTypeId = String(link.class_type_id);
      const existing = trainerIdsByClassType.get(classTypeId) ?? [];
      existing.push(String(link.trainer_id));
      trainerIdsByClassType.set(classTypeId, existing);
    }

    return {
      schedules: sortById(
        schedulesRows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          status: String(row.status),
          isActive: Boolean(row.is_active),
          isArchived: Boolean(row.is_archived),
          publishedAt: row.published_at == null ? null : toIso(row.published_at),
        })),
      ),
      trainers: sortById(
        trainerRows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          color: String(row.color),
          initials: row.initials == null ? null : String(row.initials),
          notes: row.notes == null ? null : String(row.notes),
          active: Boolean(row.active),
          sortOrder: Number(row.sort_order),
        })),
      ),
      classTypes: sortById(
        classTypeRows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          shortName: String(row.short_name),
          defaultDuration: Number(row.default_duration),
          color: row.color == null ? null : String(row.color),
          description: row.description == null ? null : String(row.description),
          active: Boolean(row.active),
          sortOrder: Number(row.sort_order),
          trainerIds: [...(trainerIdsByClassType.get(String(row.id)) ?? [])].sort(),
        })),
      ),
      eligibilityLinks: linkRows
        .map((row) => ({ trainerId: String(row.trainer_id), classTypeId: String(row.class_type_id) }))
        .sort((left, right) => left.classTypeId.localeCompare(right.classTypeId) || left.trainerId.localeCompare(right.trainerId)),
      rooms: sortById(
        roomRows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          active: Boolean(row.active),
          sortOrder: Number(row.sort_order),
        })),
      ),
      events: sortById(
        eventRows.map((row) => ({
          id: String(row.id),
          scheduleId: String(row.schedule_id),
          dayOfWeek: Number(row.day_of_week),
          startTime: String(row.start_time),
          endTime: String(row.end_time),
          trainerId: String(row.trainer_id),
          classTypeId: String(row.class_type_id),
          roomId: row.room_id == null ? null : String(row.room_id),
          notes: row.notes == null ? null : String(row.notes),
        })),
      ),
      settings: [...settingsRows]
        .map((row) => ({
          scheduleId: String(row.schedule_id),
          visibleDays: row.visible_days == null ? DEFAULT_SETTINGS.visibleDays : parseStoredJson<number[]>(row.visible_days),
          startTime: String(row.start_time),
          endTime: String(row.end_time),
          defaultInterval: Number(row.default_interval),
          customMarkers: row.custom_markers == null ? [] : parseStoredJson<string[]>(row.custom_markers),
          snapMinutes: Number(row.snap_minutes),
          themeId: String(row.theme_id),
          showTrainerLegend: Boolean(row.show_trainer_legend),
          legendPosition: String(row.legend_position),
          showLogo: Boolean(row.show_logo),
          logoDataUrl: row.logo_data_url == null ? null : String(row.logo_data_url),
          scheduleTitle: String(row.schedule_title),
          scheduleSubtitle: String(row.schedule_subtitle),
          effectiveDate: row.effective_date == null ? null : String(row.effective_date),
          exportPaper: String(row.export_paper),
          exportOrientation: String(row.export_orientation),
          exportScale: Number(row.export_scale),
          customExportWidth: Number(row.custom_export_width),
          customExportHeight: Number(row.custom_export_height),
          autosave: Boolean(row.autosave),
        }))
        .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId)),
      versions: sortById(
        versionRows.map((row) => ({
          id: String(row.id),
          scheduleId: String(row.schedule_id),
          createdAt: toIso(row.created_at),
          source: String(row.source),
          description: String(row.description),
          restoredFromVersionId: row.restored_from_version_id == null ? null : String(row.restored_from_version_id),
          snapshot: row.snapshot == null ? null : parseStoredJson<unknown>(row.snapshot),
        })),
      ),
    };
  } finally {
    sqlite.close();
  }
}

function meaningfulGraphFromBackup(backup: BackupPayload): MeaningfulGraph {
  return {
    schedules: sortById(backup.schedules.map((schedule) => ({ ...schedule }))),
    trainers: sortById(backup.trainers.map((trainer) => ({ ...trainer }))),
    classTypes: sortById(
      backup.classTypes.map((classType) => ({ ...classType, trainerIds: [...classType.trainerIds].sort() })),
    ),
    eligibilityLinks: backup.classTypes
      .flatMap((classType) =>
        classType.trainerIds.map((trainerId) => ({ trainerId, classTypeId: classType.id })),
      )
      .sort((left, right) => left.classTypeId.localeCompare(right.classTypeId) || left.trainerId.localeCompare(right.trainerId)),
    rooms: sortById(backup.rooms.map((room) => ({ ...room }))),
    events: sortById(backup.events.map((event) => ({ ...event }))),
    settings: [...backup.settings].sort((left, right) => left.scheduleId.localeCompare(right.scheduleId)),
    versions: sortById(backup.versions.map((version) => ({ ...version }))),
  };
}

function readVersion(dbPath: string): number {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return Number(sqlite.pragma("user_version", { simple: true }));
  } finally {
    sqlite.close();
  }
}

function tableNames(dbPath: string): string[] {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return (sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]).map((row) => row.name);
  } finally {
    sqlite.close();
  }
}

function migrateFixture(dbPath: string) {
  const opened = initializeDatabaseForPath(dbPath);
  closeDb(opened.db);
  return opened.migration;
}

function expectLegacyStillIntact(dbPath: string, before: ReturnType<typeof dumpMeaningfulData>): void {
  expect(readVersion(dbPath)).toBe(0);
  expect(dumpMeaningfulData(dbPath)).toEqual(before);
  expect(tableNames(dbPath)).toEqual([...LEGACY_V0_TABLES].sort());
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    expect(sqlite.prepare("PRAGMA foreign_key_list('schedule_events')").all()).toEqual([]);
    expect(tableNames(dbPath).some((name) => name.startsWith("__risen_v0_"))).toBe(false);
  } finally {
    sqlite.close();
  }
}

afterAll(async () => {
  migrationTestHooks.failAt = null;
  migrationTestHooks.onStage = null;
  try {
    const db = await import("@/db");
    if (typeof db.closeDatabaseForTests === "function") db.closeDatabaseForTests();
  } catch {}
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

describe("SQLite schema v1 bootstrap and real v0 compatibility", () => {
  it("TEST A — bootstraps a truly blank database through the versioned path with foreign keys enabled", () => {
    const dbPath = temporaryDatabase("fresh");
    const opened = initializeDatabaseForPath(dbPath);
    try {
      expect(opened.migration).toEqual({
        fromVersion: 0,
        toVersion: LATEST_SCHEMA_VERSION,
        migrated: true,
        safetyBackup: null,
      });
      expect(Number(opened.db.$client.pragma("user_version", { simple: true }))).toBe(LATEST_SCHEMA_VERSION);
      expect(Number(opened.db.$client.pragma("foreign_keys", { simple: true }))).toBe(1);
      expect(opened.db.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(tableNames(dbPath)).toEqual([...LEGACY_V0_TABLES].sort());
    } finally {
      closeDb(opened.db);
    }
  });

  it("enables foreign-key enforcement again on a separately reopened application connection", () => {
    const dbPath = temporaryDatabase("reopened-app-connection");
    const firstConnection = openDatabase(dbPath);
    try {
      expect(Number(firstConnection.$client.pragma("foreign_keys", { simple: true }))).toBe(1);
    } finally {
      closeDb(firstConnection);
    }

    const reopenedConnection = openDatabase(dbPath);
    try {
      expect(Number(reopenedConnection.$client.pragma("foreign_keys", { simple: true }))).toBe(1);
      expect(reopenedConnection.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeDb(reopenedConnection);
    }
  });

  it("TEST B/E/T — migrates a populated actual v0 fixture without data loss and writes a retained pre-migration backup", () => {
    const dbPath = temporaryDatabase("legacy-success");
    createLegacyFixture(dbPath);
    // Witness that this fixture is the unconstrained pre-versioning layout,
    // not a v1 database created through the new schema code.
    const legacy = new Database(dbPath, { readonly: true });
    try {
      expect(Number(legacy.pragma("user_version", { simple: true }))).toBe(0);
      expect(legacy.prepare("PRAGMA foreign_key_list('schedule_events')").all()).toEqual([]);
    } finally {
      legacy.close();
    }
    const before = dumpMeaningfulData(dbPath);

    const result = migrateFixture(dbPath);
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.safetyBackup).toMatch(/risen-team-pre-migration-v0-to-v1-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}-[0-9a-z]{8}\.json$/);
    expect(fs.existsSync(result.safetyBackup as string)).toBe(true);
    expect(fs.readdirSync(path.dirname(result.safetyBackup as string)).some((name) => name.endsWith(".tmp"))).toBe(false);
    const safetyCopy = JSON.parse(fs.readFileSync(result.safetyBackup as string, "utf8")) as {
      safetyReason: string;
      schedules: unknown[];
      events: unknown[];
      versions: unknown[];
    };
    expect(safetyCopy.safetyReason).toBe("schema-migration:v0-to-v1");
    expect(safetyCopy.schedules).toHaveLength(3);
    expect(safetyCopy.events).toHaveLength(3);
    expect(safetyCopy.versions).toHaveLength(3);

    // Every meaningful row, id, timestamp and JSON payload survived byte-for-byte.
    expect(dumpMeaningfulData(dbPath)).toEqual(before);
    expect(readVersion(dbPath)).toBe(LATEST_SCHEMA_VERSION);

    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma("foreign_keys = ON");
      expect(Number(sqlite.pragma("foreign_keys", { simple: true }))).toBe(1);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const active = sqlite.prepare("SELECT id FROM schedules WHERE is_active = 1").all() as { id: string }[];
      expect(active).toEqual([{ id: "sched-active" }]);
      expect(sqlite.prepare("PRAGMA foreign_key_list('schedule_events')").all()).toHaveLength(4);
      expect(sqlite.prepare("PRAGMA foreign_key_list('schedule_versions')").all()).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("TEST C — does not rerun an already-applied migration or create another migration backup", () => {
    const dbPath = temporaryDatabase("idempotent");
    createLegacyFixture(dbPath);
    migrateFixture(dbPath);
    const before = dumpMeaningfulData(dbPath);
    const backupDirectory = path.join(path.dirname(dbPath), "backups");
    const backupsBefore = fs.readdirSync(backupDirectory).sort();

    const result = migrateFixture(dbPath);
    expect(result).toEqual({
      fromVersion: LATEST_SCHEMA_VERSION,
      toVersion: LATEST_SCHEMA_VERSION,
      migrated: false,
      safetyBackup: null,
    });
    expect(dumpMeaningfulData(dbPath)).toEqual(before);
    expect(fs.readdirSync(backupDirectory).sort()).toEqual(backupsBefore);
  });

  it("refuses an arbitrary user_version = 0 SQLite file instead of treating it as a disposable blank install", () => {
    const dbPath = temporaryDatabase("unknown-v0");
    const sqlite = new Database(dbPath);
    sqlite.exec("CREATE TABLE unrelated_workspace (id TEXT PRIMARY KEY, note TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO unrelated_workspace (id, note) VALUES ('keep', 'do not reset')").run();
    sqlite.close();

    let caught: unknown;
    try {
      migrateFixture(dbPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseMigrationError);
    expect((caught as DatabaseMigrationError).code).toBe("unknown-unversioned-schema");
    const after = new Database(dbPath, { readonly: true });
    try {
      expect(after.prepare("SELECT * FROM unrelated_workspace").all()).toEqual([{ id: "keep", note: "do not reset" }]);
      expect(Number(after.pragma("user_version", { simple: true }))).toBe(0);
    } finally {
      after.close();
    }
  });

  it("TEST D — safely refuses a future schema version without changing the file", () => {
    const dbPath = temporaryDatabase("future");
    createLegacyFixture(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("user_version = 99");
    sqlite.close();
    const before = dumpMeaningfulData(dbPath);

    let caught: unknown;
    try {
      migrateFixture(dbPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseMigrationError);
    expect((caught as DatabaseMigrationError).code).toBe("future-schema-version");
    expect(readVersion(dbPath)).toBe(99);
    expect(dumpMeaningfulData(dbPath)).toEqual(before);
    expect(fs.existsSync(path.join(path.dirname(dbPath), "backups"))).toBe(false);
  });

  it("TEST F — fails closed when the required pre-migration safety backup cannot be written", () => {
    const dbPath = temporaryDatabase("backup-failure");
    createLegacyFixture(dbPath);
    const before = dumpMeaningfulData(dbPath);
    const failure = vi.spyOn(backupFileSystem, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated disk full");
    });
    let caught: unknown;
    try {
      migrateFixture(dbPath);
    } catch (error) {
      caught = error;
    } finally {
      failure.mockRestore();
    }

    expect(caught).toBeInstanceOf(DatabaseMigrationError);
    expect((caught as DatabaseMigrationError).code).toBe("migration-safety-backup-failed");
    expectLegacyStillIntact(dbPath, before);
  });
});

describe("legacy graph preflight refuses ambiguous or orphaned v0 data", () => {
  const corruptions: {
    name: string;
    code: string;
    corrupt: (sqlite: Database.Database) => void;
  }[] = [
    {
      name: "orphan event trainer",
      code: "legacy-orphan-event-trainer",
      corrupt: (sqlite) => sqlite.prepare("UPDATE schedule_events SET trainer_id = 'missing-trainer' WHERE id = 'evt-active'").run(),
    },
    {
      name: "orphan event room",
      code: "legacy-orphan-event-room",
      corrupt: (sqlite) => sqlite.prepare("UPDATE schedule_events SET room_id = 'missing-room' WHERE id = 'evt-active'").run(),
    },
    {
      name: "settings for missing schedule",
      code: "legacy-orphan-settings-schedule",
      corrupt: (sqlite) => sqlite.prepare("INSERT INTO schedule_settings (schedule_id, updated_at) VALUES ('missing-schedule', ?)").run(NOW),
    },
    {
      name: "broken trainer/class eligibility link",
      code: "legacy-orphan-trainer-class-trainer",
      corrupt: (sqlite) => sqlite.prepare("INSERT INTO trainer_class_types (trainer_id, class_type_id) VALUES ('missing-trainer', 'cls-box')").run(),
    },
    {
      name: "invalid restored version reference",
      code: "legacy-orphan-restored-version",
      corrupt: (sqlite) => sqlite.prepare("UPDATE schedule_versions SET restored_from_version_id = 'missing-version' WHERE id = 'ver-active-restored'").run(),
    },
    {
      name: "multiple active schedules",
      code: "legacy-multiple-active-schedules",
      corrupt: (sqlite) => sqlite.prepare("UPDATE schedules SET is_active = 1 WHERE id = 'sched-inactive'").run(),
    },
    {
      name: "active archived schedule",
      code: "legacy-active-archived-schedule",
      corrupt: (sqlite) => sqlite.prepare("UPDATE schedules SET is_active = 1 WHERE id = 'sched-archived'").run(),
    },
  ];

  it.each(corruptions)("TEST G — refuses $name without rebuilding or versioning the original file", ({ code, corrupt }) => {
    const dbPath = temporaryDatabase(`corrupt-${code}`);
    createLegacyFixture(dbPath);
    const sqlite = new Database(dbPath);
    corrupt(sqlite);
    sqlite.close();
    const before = dumpMeaningfulData(dbPath);

    let caught: unknown;
    try {
      migrateFixture(dbPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseMigrationError);
    expect((caught as DatabaseMigrationError).code).toBe(code);
    expectLegacyStillIntact(dbPath, before);
    // Preflight is deliberately before backup: no schema-changing migration was
    // started, so this is a refusal, not a completed migration safety copy.
    expect(fs.existsSync(path.join(path.dirname(dbPath), "backups"))).toBe(false);
  });
});

describe("migration transaction rollback and retry", () => {
  const failurePoints = [
    "after-first-table-rebuild",
    "midway-through-data-copy",
    "during-index-creation",
    "before-foreign-key-check",
    "before-schema-version-update",
  ] as const;

  it.each(failurePoints)("TEST H — rolls back exactly when failure is injected at %s", (failurePoint) => {
    const dbPath = temporaryDatabase(`rollback-${failurePoint}`);
    createLegacyFixture(dbPath);
    const before = dumpMeaningfulData(dbPath);
    migrationTestHooks.failAt = failurePoint;
    let caught: unknown;
    try {
      migrateFixture(dbPath);
    } catch (error) {
      caught = error;
    } finally {
      migrationTestHooks.failAt = null;
    }

    expect(caught).toBeInstanceOf(DatabaseMigrationError);
    expect((caught as DatabaseMigrationError).code).toBe("migration-failed");
    expectLegacyStillIntact(dbPath, before);
    // The mandatory pre-image remains useful even when the schema transaction
    // rolled back; a retry creates a fresh collision-safe migration copy.
    expect(fs.readdirSync(path.join(path.dirname(dbPath), "backups")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("TEST I — retries cleanly after an injected rollback", () => {
    const dbPath = temporaryDatabase("retry");
    createLegacyFixture(dbPath);
    const before = dumpMeaningfulData(dbPath);
    migrationTestHooks.failAt = "midway-through-data-copy";
    try {
      expect(() => migrateFixture(dbPath)).toThrow(DatabaseMigrationError);
    } finally {
      migrationTestHooks.failAt = null;
    }
    expectLegacyStillIntact(dbPath, before);

    const retry = migrateFixture(dbPath);
    expect(retry.migrated).toBe(true);
    expect(readVersion(dbPath)).toBe(LATEST_SCHEMA_VERSION);
    expect(dumpMeaningfulData(dbPath)).toEqual(before);
  });
});

describe("v1 runtime foreign keys and delete policy", () => {
  it("TEST J/K/L/M/N — runs foreign_key_check and SQLite itself rejects every required orphan write", () => {
    const dbPath = temporaryDatabase("fk-runtime");
    createLegacyFixture(dbPath);
    migrateFixture(dbPath);
    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma("foreign_keys = ON");
      expect(Number(sqlite.pragma("foreign_keys", { simple: true }))).toBe(1);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const insertEvent = sqlite.prepare(
        `INSERT INTO schedule_events
          (id, schedule_id, day_of_week, start_time, end_time, trainer_id, class_type_id, room_id, created_at, updated_at)
         VALUES (?, ?, 0, '10:00', '11:00', ?, ?, ?, ?, ?)`,
      );
      expect(() => insertEvent.run("fk-event-schedule", "missing-schedule", "trn-a", "cls-box", null, NOW, NOW)).toThrow(/FOREIGN KEY/);
      expect(() => insertEvent.run("fk-event-trainer", "sched-active", "missing-trainer", "cls-box", null, NOW, NOW)).toThrow(/FOREIGN KEY/);
      expect(() => insertEvent.run("fk-event-class", "sched-active", "trn-a", "missing-class", null, NOW, NOW)).toThrow(/FOREIGN KEY/);
      expect(() => insertEvent.run("fk-event-room", "sched-active", "trn-a", "cls-box", "missing-room", NOW, NOW)).toThrow(/FOREIGN KEY/);
      expect(() =>
        sqlite.prepare("INSERT INTO trainer_class_types (trainer_id, class_type_id) VALUES ('missing-trainer', 'cls-box')").run(),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        sqlite.prepare("INSERT INTO trainer_class_types (trainer_id, class_type_id) VALUES ('trn-a', 'missing-class')").run(),
      ).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.prepare("INSERT INTO schedule_settings (schedule_id, updated_at) VALUES ('missing-schedule', ?)").run(NOW)).toThrow(
        /FOREIGN KEY/,
      );
      expect(() =>
        sqlite.prepare("INSERT INTO schedule_versions (id, schedule_id, created_at) VALUES ('fk-version', 'missing-schedule', ?)").run(NOW),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO schedule_versions (id, schedule_id, created_at, restored_from_version_id) VALUES ('ver-self', 'sched-active', ?, 'ver-self')",
          )
          .run(NOW),
      ).toThrow(/CHECK/);

      // Direct destructive writes are blocked; the supported administrative
      // flow explicitly deletes owned children in its transaction instead.
      expect(() => sqlite.prepare("DELETE FROM schedules WHERE id = 'sched-active'").run()).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.prepare("DELETE FROM trainers WHERE id = 'trn-a'").run()).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.prepare("DELETE FROM class_types WHERE id = 'cls-box'").run()).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.prepare("DELETE FROM rooms WHERE id = 'room-main'").run()).toThrow(/FOREIGN KEY/);

      // restoredFromVersionId is optional historical metadata: if its target is
      // legitimately removed, SQLite preserves the surviving checkpoint and
      // clears only the optional pointer.
      sqlite
        .prepare(
          "INSERT INTO schedule_versions (id, schedule_id, created_at, restored_from_version_id) VALUES ('ver-cross', 'sched-active', ?, 'ver-inactive')",
        )
        .run(NOW + 900);
      sqlite.prepare("DELETE FROM schedule_versions WHERE id = 'ver-inactive'").run();
      expect(
        sqlite.prepare("SELECT restored_from_version_id AS restoredFromVersionId FROM schedule_versions WHERE id = 'ver-cross'").get(),
      ).toEqual({ restoredFromVersionId: null });
    } finally {
      sqlite.close();
    }
  });

  it("TEST O — the supported atomic schedule deletion succeeds under RESTRICT foreign keys", async () => {
    const dbPath = temporaryDatabase("supported-delete");
    createLegacyFixture(dbPath);
    migrateFixture(dbPath);
    process.env.RISEN_DB_PATH = dbPath;
    vi.resetModules();
    const admin = await import("@/lib/server/admin");
    const result = await admin.scheduleAction({ action: "delete", id: "sched-inactive" });
    expect(result.activeScheduleId).toBe("sched-active");

    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma("foreign_keys = ON");
      expect(sqlite.prepare("SELECT * FROM schedules WHERE id = 'sched-inactive'").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM schedule_settings WHERE schedule_id = 'sched-inactive'").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM schedule_events WHERE schedule_id = 'sched-inactive'").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM schedule_versions WHERE schedule_id = 'sched-inactive'").all()).toEqual([]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("backup/import and restore compatibility after a v0 upgrade", () => {
  it("restores the exact migration-created v0 pre-image backup through the supported Replace path", async () => {
    // A: construct the actual former schema, then capture its meaningful graph
    // before startup touches it.
    const legacyPath = temporaryDatabase("migration-backup-source");
    createLegacyFixture(legacyPath);
    const sourceGraph = meaningfulGraphFromDatabase(legacyPath);

    // B/C: startup migration creates the real retained JSON pre-image. Do not
    // use a newly exported v1 backup anywhere in this test.
    const migration = migrateFixture(legacyPath);
    const safetyBackupPath = migration.safetyBackup;
    expect(safetyBackupPath).toMatch(/risen-team-pre-migration-v0-to-v1-.*\.json$/);
    const rawSafetyBackup = JSON.parse(fs.readFileSync(safetyBackupPath as string, "utf8")) as unknown;

    // D: prove the file itself—not a reconstructed object—passes current shape
    // and graph preflight before normal import is allowed to write anything.
    const parsedSafetyBackup = parseBackupPayload(rawSafetyBackup);
    validateBackupPreflight(parsedSafetyBackup, "replace", emptyPreflightContext());
    expect(meaningfulGraphFromBackup(parsedSafetyBackup)).toEqual(sourceGraph);

    // E/F: create a separate fresh v1 file, then submit the parsed contents of
    // the migration-generated file to the public Replace implementation.
    const restoredPath = temporaryDatabase("migration-backup-restored");
    const fresh = initializeDatabaseForPath(restoredPath);
    closeDb(fresh.db);
    process.env.RISEN_DB_PATH = restoredPath;
    vi.resetModules();
    const destinationAdmin = await import("@/lib/server/admin");
    const destinationDb = await import("@/db");
    const result = destinationAdmin.importBackup(rawSafetyBackup, "replace");
    expect(result.mode).toBe("replace");

    // G/H: every portable user-visible relation and metadata field from v0
    // survives the real safety-copy round trip, and the application-owned
    // connection enforces FKs on this reopened destination.
    expect(meaningfulGraphFromDatabase(restoredPath)).toEqual(sourceGraph);
    expect(readVersion(restoredPath)).toBe(LATEST_SCHEMA_VERSION);
    expect(Number(destinationDb.getDb().$client.pragma("foreign_keys", { simple: true }))).toBe(1);
    expect(destinationDb.getDb().$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("TEST Q/R — exports/imports a migrated workspace and restores its historical version", async () => {
    const sourcePath = temporaryDatabase("roundtrip-source");
    createLegacyFixture(sourcePath);
    migrateFixture(sourcePath);

    process.env.RISEN_DB_PATH = sourcePath;
    vi.resetModules();
    const sourceExport = await import("@/lib/server/export-backup");
    const sourceWorkspace = await import("@/lib/server/workspace");
    const backup = sourceExport.exportBackup();
    expect(backup.schedules).toHaveLength(3);
    expect(backup.versions.map((version) => version.id)).toContain("ver-active-restored");

    const restored = sourceWorkspace.restoreVersion("ver-active-base");
    expect(restored.scheduleId).toBe("sched-active");
    expect(restored.version.source).toBe("restore");

    const destinationPath = temporaryDatabase("roundtrip-destination");
    process.env.RISEN_DB_PATH = destinationPath;
    vi.resetModules();
    const destinationAdmin = await import("@/lib/server/admin");
    const destinationExport = await import("@/lib/server/export-backup");
    const imported = destinationAdmin.importBackup(backup, "replace");
    expect(imported.mode).toBe("replace");
    expect(destinationExport.exportBackup().schedules).toHaveLength(3);

    const sqlite = new Database(destinationPath);
    try {
      sqlite.pragma("foreign_keys = ON");
      expect(readVersion(destinationPath)).toBe(LATEST_SCHEMA_VERSION);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
