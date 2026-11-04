import type Database from "better-sqlite3";

/**
 * Safe, intentionally non-SQL-facing error returned when startup cannot open a
 * workspace without risking data loss. `diagnostic` is suitable for developer
 * logs and tests; `message` is safe to show through the existing API/toast
 * error funnel and never contains a database path, row payload or SQL text.
 */
export class DatabaseMigrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostic: string = code,
  ) {
    super(message);
    this.name = "DatabaseMigrationError";
  }
}

export const LEGACY_V0_TABLE_COLUMNS = {
  app_meta: ["key", "value"],
  schedules: ["id", "name", "status", "is_active", "is_archived", "published_at", "created_at", "updated_at"],
  trainers: ["id", "name", "color", "initials", "notes", "active", "sort_order", "created_at", "updated_at"],
  class_types: [
    "id",
    "name",
    "short_name",
    "default_duration",
    "color",
    "description",
    "active",
    "sort_order",
    "created_at",
    "updated_at",
  ],
  trainer_class_types: ["trainer_id", "class_type_id"],
  rooms: ["id", "name", "active", "sort_order"],
  schedule_events: [
    "id",
    "schedule_id",
    "day_of_week",
    "start_time",
    "end_time",
    "trainer_id",
    "class_type_id",
    "room_id",
    "notes",
    "created_at",
    "updated_at",
  ],
  schedule_settings: [
    "schedule_id",
    "visible_days",
    "start_time",
    "end_time",
    "default_interval",
    "custom_markers",
    "snap_minutes",
    "theme_id",
    "show_trainer_legend",
    "legend_position",
    "show_logo",
    "logo_data_url",
    "schedule_title",
    "schedule_subtitle",
    "effective_date",
    "export_paper",
    "export_orientation",
    "export_scale",
    "custom_export_width",
    "custom_export_height",
    "autosave",
    "updated_at",
  ],
  schedule_versions: [
    "id",
    "schedule_id",
    "created_at",
    "source",
    "description",
    "snapshot",
    "restored_from_version_id",
  ],
} as const;

export type LegacyV0Table = keyof typeof LEGACY_V0_TABLE_COLUMNS;
export const LEGACY_V0_TABLES = Object.keys(LEGACY_V0_TABLE_COLUMNS) as LegacyV0Table[];
/** Explicit non-auto indexes emitted by the exact pre-versioning runtime schema. */
export const LEGACY_V0_INDEXES = ["schedule_events_schedule_idx", "schedule_versions_schedule_idx"] as const;

export type LegacySchemaKind = "blank" | "legacy-v0" | "unsupported" | "version-marker-missing";

export interface LegacySchemaInspection {
  kind: LegacySchemaKind;
  tables: string[];
  reason: string;
}

interface NameRow {
  name: string;
}

interface ColumnRow {
  name: string;
}

/**
 * Recognizes only two safe v0 cases:
 *   - no application tables at all (a genuinely blank SQLite file), or
 *   - the exact unversioned schema shipped before schema versioning.
 *
 * Any partial, unknown or already-constrained schema with `user_version = 0`
 * is rejected rather than guessed at or reset.
 */
export function inspectUnversionedSchema(sqlite: Database.Database): LegacySchemaInspection {
  const objects = sqlite
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as { type: string; name: string }[];
  const tables = objects.filter((object) => object.type === "table");
  const names = tables.map((row) => row.name);

  if (names.length === 0 && objects.length === 0) {
    return { kind: "blank", tables: names, reason: "no user schema objects" };
  }
  if (objects.some((object) => object.type !== "table" && object.type !== "index")) {
    return {
      kind: "unsupported",
      tables: names,
      reason: "the database has views or triggers outside the known Risen Team v0 schema",
    };
  }

  const expected = [...LEGACY_V0_TABLES].sort();
  const actual = [...names].sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    return {
      kind: "unsupported",
      tables: names,
      reason: "the table set is not the known Risen Team v0 schema",
    };
  }

  // Rebuilding drops indexes/triggers attached to the old table names. Reject a
  // manually altered schema instead of silently discarding an unknown index.
  const explicitIndexes = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all() as NameRow[]
  ).map((row) => row.name);
  const expectedIndexes = [...LEGACY_V0_INDEXES].sort();
  if (
    explicitIndexes.length !== expectedIndexes.length ||
    explicitIndexes.some((name, index) => name !== expectedIndexes[index])
  ) {
    return {
      kind: "unsupported",
      tables: names,
      reason: "the explicit indexes are not the known Risen Team v0 schema",
    };
  }

  for (const table of LEGACY_V0_TABLES) {
    const expectedColumns = [...LEGACY_V0_TABLE_COLUMNS[table]].sort();
    const actualColumns = (sqlite.prepare(`PRAGMA table_info('${table}')`).all() as ColumnRow[])
      .map((row) => row.name)
      .sort();
    if (
      expectedColumns.length !== actualColumns.length ||
      expectedColumns.some((column, index) => column !== actualColumns[index])
    ) {
      return {
        kind: "unsupported",
        tables: names,
        reason: `the column set for ${table} is not the known Risen Team v0 schema`,
      };
    }
  }

  // A v1 table layout has the same columns as v0, so use the actual FK metadata
  // to distinguish a missing version marker from a genuine legacy database.
  const constrainedTables = LEGACY_V0_TABLES.filter(
    (table) => (sqlite.prepare(`PRAGMA foreign_key_list('${table}')`).all() as unknown[]).length > 0,
  );
  if (constrainedTables.length > 0) {
    return {
      kind: "version-marker-missing",
      tables: names,
      reason: `foreign keys already exist on ${constrainedTables.join(", ")}`,
    };
  }

  return { kind: "legacy-v0", tables: names, reason: "known Risen Team v0 schema" };
}

/**
 * Checks every relationship that v1 will enforce before any table is renamed
 * or rebuilt. No cleanup is attempted: an ambiguous graph must remain exactly
 * as it was so the operator can recover it from the migration safety copy or a
 * known-good backup.
 */
export function validateLegacyV0Integrity(sqlite: Database.Database): void {
  assertNoRows(
    sqlite,
    `SELECT e.id
       FROM schedule_events e
       LEFT JOIN schedules s ON s.id = e.schedule_id
      WHERE s.id IS NULL
      LIMIT 1`,
    "legacy-orphan-event-schedule",
    "Migration stopped: an event references a missing schedule. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT e.id
       FROM schedule_events e
       LEFT JOIN trainers t ON t.id = e.trainer_id
      WHERE t.id IS NULL
      LIMIT 1`,
    "legacy-orphan-event-trainer",
    "Migration stopped: an event references a missing trainer. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT e.id
       FROM schedule_events e
       LEFT JOIN class_types c ON c.id = e.class_type_id
      WHERE c.id IS NULL
      LIMIT 1`,
    "legacy-orphan-event-class-type",
    "Migration stopped: an event references a missing class type. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT e.id
       FROM schedule_events e
       LEFT JOIN rooms r ON r.id = e.room_id
      WHERE e.room_id IS NOT NULL AND r.id IS NULL
      LIMIT 1`,
    "legacy-orphan-event-room",
    "Migration stopped: an event references a missing room. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT ss.schedule_id
       FROM schedule_settings ss
       LEFT JOIN schedules s ON s.id = ss.schedule_id
      WHERE s.id IS NULL
      LIMIT 1`,
    "legacy-orphan-settings-schedule",
    "Migration stopped: settings reference a missing schedule. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT v.id
       FROM schedule_versions v
       LEFT JOIN schedules s ON s.id = v.schedule_id
      WHERE s.id IS NULL
      LIMIT 1`,
    "legacy-orphan-version-schedule",
    "Migration stopped: a version references a missing schedule. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT l.trainer_id
       FROM trainer_class_types l
       LEFT JOIN trainers t ON t.id = l.trainer_id
      WHERE t.id IS NULL
      LIMIT 1`,
    "legacy-orphan-trainer-class-trainer",
    "Migration stopped: a trainer/class link references a missing trainer. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT l.class_type_id
       FROM trainer_class_types l
       LEFT JOIN class_types c ON c.id = l.class_type_id
      WHERE c.id IS NULL
      LIMIT 1`,
    "legacy-orphan-trainer-class-class-type",
    "Migration stopped: a trainer/class link references a missing class type. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT v.id
       FROM schedule_versions v
       LEFT JOIN schedule_versions target ON target.id = v.restored_from_version_id
      WHERE v.restored_from_version_id IS NOT NULL AND target.id IS NULL
      LIMIT 1`,
    "legacy-orphan-restored-version",
    "Migration stopped: a restored-version reference is missing. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT id FROM schedule_versions
      WHERE restored_from_version_id = id
      LIMIT 1`,
    "legacy-self-restored-version",
    "Migration stopped: a version restores from itself. The database was not changed.",
  );

  assertNoRows(
    sqlite,
    `SELECT id FROM schedules WHERE is_active = 1 AND is_archived = 1 LIMIT 1`,
    "legacy-active-archived-schedule",
    "Migration stopped: an archived schedule is marked active. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT is_active FROM schedules WHERE is_active = 1 GROUP BY is_active HAVING count(*) > 1 LIMIT 1`,
    "legacy-multiple-active-schedules",
    "Migration stopped: more than one schedule is active. The database was not changed.",
  );
  assertNoRows(
    sqlite,
    `SELECT 1
       FROM schedules
      WHERE EXISTS (SELECT 1 FROM schedules WHERE is_archived = 0)
        AND NOT EXISTS (SELECT 1 FROM schedules WHERE is_active = 1)
      LIMIT 1`,
    "legacy-missing-active-schedule",
    "Migration stopped: no non-archived schedule is active. The database was not changed.",
  );

  assertNoDuplicates(sqlite, "app_meta", ["key"], "legacy-duplicate-app-meta-key");
  assertNoDuplicates(sqlite, "schedules", ["id"], "legacy-duplicate-schedule-id");
  assertNoDuplicates(sqlite, "trainers", ["id"], "legacy-duplicate-trainer-id");
  assertNoDuplicates(sqlite, "class_types", ["id"], "legacy-duplicate-class-type-id");
  assertNoDuplicates(sqlite, "rooms", ["id"], "legacy-duplicate-room-id");
  assertNoDuplicates(sqlite, "schedule_events", ["id"], "legacy-duplicate-event-id");
  assertNoDuplicates(sqlite, "schedule_settings", ["schedule_id"], "legacy-duplicate-settings-schedule");
  assertNoDuplicates(sqlite, "schedule_versions", ["id"], "legacy-duplicate-version-id");
  assertNoDuplicates(
    sqlite,
    "trainer_class_types",
    ["trainer_id", "class_type_id"],
    "legacy-duplicate-trainer-class-link",
  );
}

function assertNoRows(
  sqlite: Database.Database,
  statement: string,
  code: string,
  message: string,
): void {
  if (sqlite.prepare(statement).get() !== undefined) {
    throw new DatabaseMigrationError(code, message, code);
  }
}

function assertNoDuplicates(
  sqlite: Database.Database,
  table: string,
  columns: readonly string[],
  code: string,
): void {
  const selected = columns.join(", ");
  const statement = `SELECT ${selected} FROM ${table} GROUP BY ${selected} HAVING count(*) > 1 LIMIT 1`;
  if (sqlite.prepare(statement).get() !== undefined) {
    throw new DatabaseMigrationError(
      code,
      "Migration stopped: legacy data contains duplicate rows that the constrained schema cannot represent. The database was not changed.",
      code,
    );
  }
}
