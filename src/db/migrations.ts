import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { writePreMigrationSafetyBackup } from "@/lib/server/backups";
import { serializeBackup } from "@/lib/server/backup-serialization";
import type { BackupPayload } from "@/lib/server/backup-types";
import {
  DatabaseMigrationError,
  LEGACY_V0_TABLE_COLUMNS,
  LEGACY_V0_TABLES,
  inspectUnversionedSchema,
  validateLegacyV0Integrity,
} from "@/db/migration-validation";

/**
 * SQLite `PRAGMA user_version` managed by this application. It is a single
 * transactional integer stored in the database header, so no application table
 * is needed solely to track migration history.
 */
export const LATEST_SCHEMA_VERSION = 1;

/**
 * Exact unversioned runtime schema from the commit immediately before v1.
 *
 * This is intentionally retained as a test/probe fixture as well as a schema
 * recognizer. Migration tests create v0 files with this SQL, never with v1,
 * proving a real pre-versioning database can be upgraded.
 */
export const LEGACY_V0_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  is_active INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trainers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  initials TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS class_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  default_duration INTEGER NOT NULL DEFAULT 60,
  color TEXT,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trainer_class_types (
  trainer_id TEXT NOT NULL,
  class_type_id TEXT NOT NULL,
  PRIMARY KEY (trainer_id, class_type_id)
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS schedule_events (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  class_type_id TEXT NOT NULL,
  room_id TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_events_schedule_idx ON schedule_events (schedule_id);
CREATE TABLE IF NOT EXISTS schedule_settings (
  schedule_id TEXT PRIMARY KEY,
  visible_days TEXT,
  start_time TEXT NOT NULL DEFAULT '08:00',
  end_time TEXT NOT NULL DEFAULT '21:00',
  default_interval INTEGER NOT NULL DEFAULT 60,
  custom_markers TEXT,
  snap_minutes INTEGER NOT NULL DEFAULT 15,
  theme_id TEXT NOT NULL DEFAULT 'risen-team-dark',
  show_trainer_legend INTEGER NOT NULL DEFAULT 1,
  legend_position TEXT NOT NULL DEFAULT 'right',
  show_logo INTEGER NOT NULL DEFAULT 1,
  logo_data_url TEXT,
  schedule_title TEXT NOT NULL DEFAULT 'RISEN TEAM',
  schedule_subtitle TEXT NOT NULL DEFAULT 'РОЗКЛАД ТРЕНУВАНЬ',
  effective_date TEXT,
  export_paper TEXT NOT NULL DEFAULT 'original',
  export_orientation TEXT NOT NULL DEFAULT 'landscape',
  export_scale INTEGER NOT NULL DEFAULT 2,
  custom_export_width INTEGER NOT NULL DEFAULT 1680,
  custom_export_height INTEGER NOT NULL DEFAULT 880,
  autosave INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_versions (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'automatic',
  description TEXT NOT NULL DEFAULT '',
  snapshot TEXT,
  restored_from_version_id TEXT
);
CREATE INDEX IF NOT EXISTS schedule_versions_schedule_idx ON schedule_versions (schedule_id);
`;

/** Tables only: indexes are created after legacy tables are dropped. */
const V1_CREATE_TABLES = [
  `CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    is_active INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    published_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (NOT (is_active = 1 AND is_archived = 1))
  )`,
  `CREATE TABLE trainers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    initials TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE class_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    default_duration INTEGER NOT NULL DEFAULT 60,
    color TEXT,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE trainer_class_types (
    trainer_id TEXT NOT NULL,
    class_type_id TEXT NOT NULL,
    PRIMARY KEY (trainer_id, class_type_id),
    CONSTRAINT trainer_class_types_trainer_fk
      FOREIGN KEY (trainer_id) REFERENCES trainers(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT trainer_class_types_class_type_fk
      FOREIGN KEY (class_type_id) REFERENCES class_types(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION
  )`,
  `CREATE TABLE schedule_events (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    trainer_id TEXT NOT NULL,
    class_type_id TEXT NOT NULL,
    room_id TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT schedule_events_schedule_fk
      FOREIGN KEY (schedule_id) REFERENCES schedules(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT schedule_events_trainer_fk
      FOREIGN KEY (trainer_id) REFERENCES trainers(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT schedule_events_class_type_fk
      FOREIGN KEY (class_type_id) REFERENCES class_types(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT schedule_events_room_fk
      FOREIGN KEY (room_id) REFERENCES rooms(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION
  )`,
  `CREATE TABLE schedule_settings (
    schedule_id TEXT PRIMARY KEY,
    visible_days TEXT,
    start_time TEXT NOT NULL DEFAULT '08:00',
    end_time TEXT NOT NULL DEFAULT '21:00',
    default_interval INTEGER NOT NULL DEFAULT 60,
    custom_markers TEXT,
    snap_minutes INTEGER NOT NULL DEFAULT 15,
    theme_id TEXT NOT NULL DEFAULT 'risen-team-dark',
    show_trainer_legend INTEGER NOT NULL DEFAULT 1,
    legend_position TEXT NOT NULL DEFAULT 'right',
    show_logo INTEGER NOT NULL DEFAULT 1,
    logo_data_url TEXT,
    schedule_title TEXT NOT NULL DEFAULT 'RISEN TEAM',
    schedule_subtitle TEXT NOT NULL DEFAULT 'РОЗКЛАД ТРЕНУВАНЬ',
    effective_date TEXT,
    export_paper TEXT NOT NULL DEFAULT 'original',
    export_orientation TEXT NOT NULL DEFAULT 'landscape',
    export_scale INTEGER NOT NULL DEFAULT 2,
    custom_export_width INTEGER NOT NULL DEFAULT 1680,
    custom_export_height INTEGER NOT NULL DEFAULT 880,
    autosave INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    CONSTRAINT schedule_settings_schedule_fk
      FOREIGN KEY (schedule_id) REFERENCES schedules(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION
  )`,
  `CREATE TABLE schedule_versions (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'automatic',
    description TEXT NOT NULL DEFAULT '',
    snapshot TEXT,
    restored_from_version_id TEXT,
    CONSTRAINT schedule_versions_not_self_restore
      CHECK (restored_from_version_id IS NULL OR restored_from_version_id <> id),
    CONSTRAINT schedule_versions_schedule_fk
      FOREIGN KEY (schedule_id) REFERENCES schedules(id)
      ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT schedule_versions_restored_from_fk
      FOREIGN KEY (restored_from_version_id) REFERENCES schedule_versions(id)
      ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
] as const;

const V1_CREATE_INDEXES = [
  "CREATE UNIQUE INDEX schedules_one_active_idx ON schedules (is_active) WHERE is_active = 1",
  "CREATE INDEX trainer_class_types_class_type_idx ON trainer_class_types (class_type_id)",
  "CREATE INDEX schedule_events_schedule_idx ON schedule_events (schedule_id)",
  "CREATE INDEX schedule_events_trainer_idx ON schedule_events (trainer_id)",
  "CREATE INDEX schedule_events_class_type_idx ON schedule_events (class_type_id)",
  "CREATE INDEX schedule_events_room_idx ON schedule_events (room_id)",
  "CREATE INDEX schedule_versions_schedule_idx ON schedule_versions (schedule_id)",
  "CREATE INDEX schedule_versions_restored_from_idx ON schedule_versions (restored_from_version_id)",
] as const;

const LEGACY_RENAME_PREFIX = "__risen_v0_";

type ForeignKeyExpectation = {
  from: string;
  table: string;
  to: string;
  onDelete: "RESTRICT" | "SET NULL";
  onUpdate: "NO ACTION";
};

const EXPECTED_FOREIGN_KEYS: Record<string, ForeignKeyExpectation[]> = {
  trainer_class_types: [
    { from: "trainer_id", table: "trainers", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
    { from: "class_type_id", table: "class_types", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
  ],
  schedule_events: [
    { from: "schedule_id", table: "schedules", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
    { from: "trainer_id", table: "trainers", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
    { from: "class_type_id", table: "class_types", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
    { from: "room_id", table: "rooms", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
  ],
  schedule_settings: [
    { from: "schedule_id", table: "schedules", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
  ],
  schedule_versions: [
    { from: "schedule_id", table: "schedules", to: "id", onDelete: "RESTRICT", onUpdate: "NO ACTION" },
    { from: "restored_from_version_id", table: "schedule_versions", to: "id", onDelete: "SET NULL", onUpdate: "NO ACTION" },
  ],
};

const EXPECTED_INDEXES = [
  { table: "schedules", name: "schedules_one_active_idx", columns: ["is_active"], unique: true, partial: true },
  {
    table: "trainer_class_types",
    name: "trainer_class_types_class_type_idx",
    columns: ["class_type_id"],
    unique: false,
    partial: false,
  },
  { table: "schedule_events", name: "schedule_events_schedule_idx", columns: ["schedule_id"], unique: false, partial: false },
  { table: "schedule_events", name: "schedule_events_trainer_idx", columns: ["trainer_id"], unique: false, partial: false },
  {
    table: "schedule_events",
    name: "schedule_events_class_type_idx",
    columns: ["class_type_id"],
    unique: false,
    partial: false,
  },
  { table: "schedule_events", name: "schedule_events_room_idx", columns: ["room_id"], unique: false, partial: false },
  {
    table: "schedule_versions",
    name: "schedule_versions_schedule_idx",
    columns: ["schedule_id"],
    unique: false,
    partial: false,
  },
  {
    table: "schedule_versions",
    name: "schedule_versions_restored_from_idx",
    columns: ["restored_from_version_id"],
    unique: false,
    partial: false,
  },
] as const;

export type MigrationFailurePoint =
  | "after-first-table-rebuild"
  | "midway-through-data-copy"
  | "during-index-creation"
  | "before-foreign-key-check"
  | "before-schema-version-update";

/**
 * Narrow test seam used by rollback tests only. It is inert in production and
 * deliberately fires inside the same SQLite transaction as every DDL/DML step.
 */
export const migrationTestHooks: {
  failAt: MigrationFailurePoint | null;
  onStage: ((point: MigrationFailurePoint) => void) | null;
} = {
  failAt: null,
  onStage: null,
};

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  migrated: boolean;
  safetyBackup: string | null;
}

interface ForwardMigration {
  fromVersion: number;
  toVersion: number;
  /** The v0 migration has a blank-bootstrap and a validated legacy-copy mode. */
  apply: (sqlite: Database.Database, source?: "blank" | "legacy-v0") => void;
  /** Verifies precisely the target schema before its version marker advances. */
  verify: (sqlite: Database.Database) => void;
}

/**
 * Ordered, append-only migration registry. New released migrations are added
 * here with a new `fromVersion`/`toVersion` pair; existing entries are never
 * edited because they are part of users' durable history.
 */
const FORWARD_MIGRATIONS: readonly ForwardMigration[] = [
  {
    fromVersion: 0,
    toVersion: 1,
    apply: (sqlite, source) => {
      if (source === "blank") createLatestSchema(sqlite);
      else if (source === "legacy-v0") migrateV0ToV1(sqlite);
      else throw new Error("v0 migration requires an inspected source schema");
    },
    verify: verifyLatestSchema,
  },
];

/** Reads SQLite's transactional schema-version marker. */
export function readSchemaVersion(sqlite: Database.Database): number {
  return Number(sqlite.pragma("user_version", { simple: true }));
}

/**
 * Intentional startup migration entry point. It never runs on module import.
 * `openDatabase` configures runtime pragmas and then calls this once for the
 * opened connection before exposing any Drizzle queries.
 */
export function initializeDatabaseSchema(sqlite: Database.Database, dbPath: string): MigrationResult {
  ensureForeignKeysEnabled(sqlite);

  const currentVersion = readSchemaVersion(sqlite);
  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new DatabaseMigrationError(
      "future-schema-version",
      "This workspace was created by a newer Risen Team version. Update the application before opening it; the database was not changed.",
      `user_version ${currentVersion} is newer than supported ${LATEST_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion < 0) {
    throw new DatabaseMigrationError(
      "invalid-schema-version",
      "This workspace has an invalid schema version. The database was not changed.",
      `user_version ${currentVersion} is negative`,
    );
  }

  if (currentVersion === LATEST_SCHEMA_VERSION) {
    verifyLatestSchema(sqlite);
    return { fromVersion: currentVersion, toVersion: currentVersion, migrated: false, safetyBackup: null };
  }

  // v0 was released before an explicit marker existed. Only a known legacy
  // layout or a truly blank file can proceed; all other files are left alone.
  // Later migration entries start from an already-versioned schema and do not
  // re-run this legacy detector.
  let v0Source: "blank" | "legacy-v0" | undefined;
  let safetyBackup: string | null = null;
  if (currentVersion === 0) {
    const inspection = inspectUnversionedSchema(sqlite);
    if (inspection.kind === "unsupported") {
      throw new DatabaseMigrationError(
        "unknown-unversioned-schema",
        "This SQLite file is not a recognized Risen Team workspace. The database was not changed.",
        inspection.reason,
      );
    }
    if (inspection.kind === "version-marker-missing") {
      throw new DatabaseMigrationError(
        "missing-schema-version-marker",
        "This workspace has constrained tables but no schema version marker. The database was not changed to avoid a risky rebuild.",
        inspection.reason,
      );
    }
    v0Source = inspection.kind;

    if (v0Source === "legacy-v0") {
      // Preflight comes first: invalid legacy data has no schema-changing path,
      // so it is not silently repaired, copied or backed up as if migration ran.
      validateLegacyV0Integrity(sqlite);

      // The backup is mandatory for every existing v0 schema, including an
      // empty one: it preserves the exact old file shape before recreation.
      let portableBackup: BackupPayload;
      try {
        portableBackup = serializeBackup(drizzle(sqlite, { schema }));
      } catch (error) {
        throw new DatabaseMigrationError(
          "migration-safety-backup-serialization-failed",
          "Migration stopped because the required safety backup could not be prepared. The database was not changed.",
          error instanceof Error
            ? `migration safety backup serialization failed: ${error.message}`
            : "migration safety backup serialization failed",
        );
      }
      const backup = writePreMigrationSafetyBackup(portableBackup, 0, 1, dbPath);
      if (!backup.file) {
        throw new DatabaseMigrationError(
          "migration-safety-backup-failed",
          "Migration stopped because the required safety backup could not be created. The database was not changed.",
          `migration safety backup failed: ${backup.skipped ?? "unknown error"}`,
        );
      }
      safetyBackup = backup.file;
    }
  }

  let appliedVersion = currentVersion;
  try {
    // Follow the ordered registry one edge at a time. Each edge has its own
    // committed version marker only after its DDL, copied data and verifier
    // all succeed, so a retry always starts at the last completed edge.
    while (appliedVersion < LATEST_SCHEMA_VERSION) {
      const migration = nextForwardMigration(appliedVersion);
      const source = migration.fromVersion === 0 ? v0Source : undefined;
      runInImmediateTransaction(sqlite, () => {
        migration.apply(sqlite, source);
        migration.verify(sqlite);
        reachMigrationStage("before-schema-version-update");
        // This is the final durable marker for this migration edge, in the same
        // transaction as its full rebuild. A crash can never expose a
        // half-migrated schema marked as the target version.
        sqlite.exec(`PRAGMA user_version = ${migration.toVersion}`);
      });
      appliedVersion = migration.toVersion;
    }
  } catch (error) {
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError(
      "migration-failed",
      "Migration could not be completed. The database was rolled back and was not changed.",
      error instanceof Error ? error.message : "unknown migration error",
    );
  }

  return { fromVersion: currentVersion, toVersion: appliedVersion, migrated: true, safetyBackup };
}

/** Ensures every application connection actually has FK enforcement enabled. */
export function ensureForeignKeysEnabled(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  if (Number(sqlite.pragma("foreign_keys", { simple: true })) !== 1) {
    throw new DatabaseMigrationError(
      "foreign-keys-disabled",
      "The database could not enable required integrity checks. The database was not changed.",
      "PRAGMA foreign_keys did not return 1",
    );
  }
}

/**
 * Public verifier used both after a migration and on a database already marked
 * current. It checks table layout, exact FK policy, key indexes, runtime FK
 * enforcement and SQLite's own `foreign_key_check` result.
 */
export function verifyLatestSchema(sqlite: Database.Database): void {
  ensureForeignKeysEnabled(sqlite);

  const tableNames = new Set(
    (sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[])
      .map((row) => row.name),
  );
  for (const table of LEGACY_V0_TABLES) {
    if (!tableNames.has(table)) {
      throw schemaVerificationError(`missing required table ${table}`);
    }
    const actualColumns = (sqlite.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[])
      .map((row) => row.name)
      .sort();
    const expectedColumns = [...LEGACY_V0_TABLE_COLUMNS[table]].sort();
    if (
      expectedColumns.length !== actualColumns.length ||
      expectedColumns.some((column, index) => column !== actualColumns[index])
    ) {
      throw schemaVerificationError(`unexpected columns in ${table}`);
    }
  }

  for (const [table, expected] of Object.entries(EXPECTED_FOREIGN_KEYS)) {
    const actual = sqlite.prepare(`PRAGMA foreign_key_list('${table}')`).all() as {
      from: string;
      table: string;
      to: string;
      on_delete: string;
      on_update: string;
    }[];
    for (const fk of expected) {
      const found = actual.some(
        (candidate) =>
          candidate.from === fk.from &&
          candidate.table === fk.table &&
          candidate.to === fk.to &&
          candidate.on_delete.toUpperCase() === fk.onDelete &&
          candidate.on_update.toUpperCase() === fk.onUpdate,
      );
      if (!found) throw schemaVerificationError(`missing expected foreign key ${table}.${fk.from}`);
    }
    if (actual.length !== expected.length) {
      throw schemaVerificationError(`unexpected foreign key count on ${table}`);
    }
  }

  for (const expected of EXPECTED_INDEXES) {
    const actual = sqlite.prepare(`PRAGMA index_list('${expected.table}')`).all() as {
      name: string;
      unique: number;
      partial: number;
    }[];
    const found = actual.find((index) => index.name === expected.name);
    if (!found) throw schemaVerificationError(`missing expected index ${expected.name}`);
    if (Boolean(found.unique) !== expected.unique || Boolean(found.partial) !== expected.partial) {
      throw schemaVerificationError(`unexpected uniqueness/partial policy for ${expected.name}`);
    }
    const columns = (sqlite.prepare(`PRAGMA index_info('${expected.name}')`).all() as { name: string }[]).map(
      (column) => column.name,
    );
    if (columns.length !== expected.columns.length || columns.some((column, index) => column !== expected.columns[index])) {
      throw schemaVerificationError(`unexpected columns for index ${expected.name}`);
    }
  }

  const scheduleSql = (
    sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get() as { sql?: string } | undefined
  )?.sql;
  const normalizedScheduleSql = scheduleSql?.toLowerCase().replace(/\s+/g, "") ?? "";
  if (!normalizedScheduleSql.includes("check(not(is_active=1andis_archived=1))")) {
    throw schemaVerificationError("missing active/archived schedule check constraint");
  }
  const versionSql = (
    sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedule_versions'").get() as
      | { sql?: string }
      | undefined
  )?.sql;
  const normalizedVersionSql = versionSql?.toLowerCase().replace(/\s+/g, "") ?? "";
  if (!normalizedVersionSql.includes("check(restored_from_version_idisnullorrestored_from_version_id<>id)")) {
    throw schemaVerificationError("missing self-restored-version check constraint");
  }

  reachMigrationStage("before-foreign-key-check");
  const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new DatabaseMigrationError(
      "foreign-key-check-failed",
      "Migration stopped because integrity checks found invalid references. The database was rolled back and was not changed.",
      `PRAGMA foreign_key_check returned ${violations.length} row(s)`,
    );
  }
}

function migrateV0ToV1(sqlite: Database.Database): void {
  for (const table of LEGACY_V0_TABLES) {
    sqlite.exec(`ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(legacyTableName(table))}`);
  }

  // Build and populate one representative table before the rollback test seam.
  sqlite.exec(V1_CREATE_TABLES[0]);
  copyTable(sqlite, "app_meta");
  reachMigrationStage("after-first-table-rebuild");

  for (const statement of V1_CREATE_TABLES.slice(1)) sqlite.exec(statement);

  // Parents first; every child insert is therefore checked by the new real FKs.
  copyTable(sqlite, "schedules");
  copyTable(sqlite, "trainers");
  copyTable(sqlite, "class_types");
  copyTable(sqlite, "rooms");
  copyTable(sqlite, "trainer_class_types");
  reachMigrationStage("midway-through-data-copy");
  copyTable(sqlite, "schedule_events");
  copyTable(sqlite, "schedule_settings");
  copyVersionsWithStagedRestoreReferences(sqlite);

  for (const table of LEGACY_V0_TABLES) verifyCopiedRowCount(sqlite, table);
  for (const table of LEGACY_V0_TABLES) sqlite.exec(`DROP TABLE ${quoteIdentifier(legacyTableName(table))}`);

  for (let index = 0; index < V1_CREATE_INDEXES.length; index += 1) {
    sqlite.exec(V1_CREATE_INDEXES[index]);
    if (index === 0) reachMigrationStage("during-index-creation");
  }
}

function createLatestSchema(sqlite: Database.Database): void {
  for (const statement of V1_CREATE_TABLES) sqlite.exec(statement);
  for (const statement of V1_CREATE_INDEXES) sqlite.exec(statement);
}

function copyTable(sqlite: Database.Database, table: keyof typeof LEGACY_V0_TABLE_COLUMNS): void {
  const columns = LEGACY_V0_TABLE_COLUMNS[table];
  const renderedColumns = columns.map(quoteIdentifier).join(", ");
  sqlite.exec(
    `INSERT INTO ${quoteIdentifier(table)} (${renderedColumns})
     SELECT ${renderedColumns} FROM ${quoteIdentifier(legacyTableName(table))}`,
  );
}

/**
 * The self-reference can point to a version that appears later in table order.
 * Stage it as NULL until every version id has been copied, then restore the
 * exact legacy values. This preserves arbitrary valid history ordering without
 * disabling foreign-key enforcement.
 */
function copyVersionsWithStagedRestoreReferences(sqlite: Database.Database): void {
  const table = "schedule_versions";
  const columns = LEGACY_V0_TABLE_COLUMNS[table];
  const copiedColumns = columns.filter((column) => column !== "restored_from_version_id");
  const targetColumns = columns.map(quoteIdentifier).join(", ");
  const sourceColumns = copiedColumns.map(quoteIdentifier).join(", ");
  sqlite.exec(
    `INSERT INTO ${quoteIdentifier(table)} (${targetColumns})
     SELECT ${sourceColumns}, NULL FROM ${quoteIdentifier(legacyTableName(table))}`,
  );
  sqlite.exec(
    `UPDATE schedule_versions
        SET restored_from_version_id = (
          SELECT old.restored_from_version_id
            FROM ${quoteIdentifier(legacyTableName(table))} old
           WHERE old.id = schedule_versions.id
        )
      WHERE EXISTS (
          SELECT 1
            FROM ${quoteIdentifier(legacyTableName(table))} old
           WHERE old.id = schedule_versions.id
             AND old.restored_from_version_id IS NOT NULL
        )`,
  );
}

function verifyCopiedRowCount(sqlite: Database.Database, table: keyof typeof LEGACY_V0_TABLE_COLUMNS): void {
  const previous = Number(
    (sqlite.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(legacyTableName(table))}`).get() as { count: number }).count,
  );
  const copied = Number(
    (sqlite.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number }).count,
  );
  if (previous !== copied) {
    throw new DatabaseMigrationError(
      "migration-row-count-mismatch",
      "Migration could not verify all copied data. The database was rolled back and was not changed.",
      `${table}: expected ${previous} copied row(s), found ${copied}`,
    );
  }
}

function nextForwardMigration(fromVersion: number): ForwardMigration {
  const matches = FORWARD_MIGRATIONS.filter((candidate) => candidate.fromVersion === fromVersion);
  if (matches.length !== 1 || matches[0].toVersion <= fromVersion) {
    throw new DatabaseMigrationError(
      "missing-forward-migration",
      "This workspace needs a migration this application does not provide. The database was not changed.",
      matches.length === 0
        ? `no forward migration registered from user_version ${fromVersion}`
        : `ambiguous/invalid forward migration registry from user_version ${fromVersion}`,
    );
  }
  return matches[0];
}

function runInImmediateTransaction(sqlite: Database.Database, work: () => void): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    work();
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // The original error is the actionable one. A best-effort rollback is
      // enough if SQLite already unwound a failed statement/transaction.
    }
    throw error;
  }
}

function reachMigrationStage(point: MigrationFailurePoint): void {
  migrationTestHooks.onStage?.(point);
  if (migrationTestHooks.failAt === point) {
    throw new Error(`Injected migration failure at ${point}`);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function legacyTableName(table: string): string {
  return `${LEGACY_RENAME_PREFIX}${table}`;
}

function schemaVerificationError(diagnostic: string): DatabaseMigrationError {
  return new DatabaseMigrationError(
    "schema-verification-failed",
    "The database schema could not be verified safely. The database was not changed.",
    diagnostic,
  );
}

export { DatabaseMigrationError } from "@/db/migration-validation";
