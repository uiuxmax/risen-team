import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Risen Team Schedule Builder — local SQLite data model.
 *
 * Design notes
 * ------------
 * - Scheduling data is strictly semantic: an event owns dayOfWeek + start/end
 *   time. Nothing is stored as row/column geometry, so any time (5-minute
 *   precision) can be represented without a schema change.
 * - All primary keys are client-generatable uuid strings. That lets the client
 *   create/undo/restore edits deterministically.
 * - Snapshots (`schedule_versions.snapshot`) hold a full portable state so a
 *   version can be fully recreated.
 * - `app_meta` stores one-off facts such as the demo-seed marker, so intentionally
 *   emptied workspaces are never re-seeded.
 *
 * Database schema policy
 * ----------------------
 * The runtime schema is created only through `src/db/migrations.ts`; this
 * Drizzle model mirrors that constrained v1 schema for type-safe queries.
 * Foreign keys deliberately use RESTRICT/NO ACTION for normal workspace data:
 * administrative flows already perform explicit ordered deletes and shared
 * entities must not disappear through a hidden cascade. The optional
 * `restoredFromVersionId` is the one exception: it is SET NULL if a historical
 * target version is removed.
 */

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** V2 desktop ownership. Legacy tables below intentionally retain their v1
 * query projections; v2 ownership writes use the explicit hall service. */
export const halls = sqliteTable("halls", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"), // draft | published
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("schedules_active_not_archived", sql`NOT (${table.isActive} = 1 AND ${table.isArchived} = 1)`),
    // SQLite cannot express the full "exactly one active non-archived schedule"
    // rule declaratively. The service layer keeps that existing invariant; this
    // partial unique index safely enforces its unambiguous half (at most one).
    uniqueIndex("schedules_one_active_idx").on(table.isActive).where(sql`${table.isActive} = 1`),
  ],
);

export const trainers = sqliteTable("trainers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  initials: text("initials"),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const classTypes = sqliteTable("class_types", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  defaultDuration: integer("default_duration").notNull().default(60), // minutes
  color: text("color"),
  description: text("description"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const trainerClassTypes = sqliteTable(
  "trainer_class_types",
  {
    trainerId: text("trainer_id").notNull(),
    classTypeId: text("class_type_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.trainerId, table.classTypeId] }),
    foreignKey({
      columns: [table.trainerId],
      foreignColumns: [trainers.id],
      name: "trainer_class_types_trainer_fk",
    })
      .onDelete("restrict")
      .onUpdate("no action"),
    foreignKey({
      columns: [table.classTypeId],
      foreignColumns: [classTypes.id],
      name: "trainer_class_types_class_type_fk",
    })
      .onDelete("restrict")
      .onUpdate("no action"),
    index("trainer_class_types_class_type_idx").on(table.classTypeId),
  ],
);

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const scheduleEvents = sqliteTable(
  "schedule_events",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    dayOfWeek: integer("day_of_week").notNull(), // 0 = Monday … 6 = Sunday
    startTime: text("start_time").notNull(), // "HH:MM"
    endTime: text("end_time").notNull(), // "HH:MM"
    trainerId: text("trainer_id").notNull(),
    classTypeId: text("class_type_id").notNull(),
    roomId: text("room_id"),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.scheduleId], foreignColumns: [schedules.id], name: "schedule_events_schedule_fk" })
      .onDelete("restrict")
      .onUpdate("no action"),
    foreignKey({ columns: [table.trainerId], foreignColumns: [trainers.id], name: "schedule_events_trainer_fk" })
      .onDelete("restrict")
      .onUpdate("no action"),
    foreignKey({
      columns: [table.classTypeId],
      foreignColumns: [classTypes.id],
      name: "schedule_events_class_type_fk",
    })
      .onDelete("restrict")
      .onUpdate("no action"),
    foreignKey({ columns: [table.roomId], foreignColumns: [rooms.id], name: "schedule_events_room_fk" })
      .onDelete("restrict")
      .onUpdate("no action"),
    index("schedule_events_schedule_idx").on(table.scheduleId),
    index("schedule_events_trainer_idx").on(table.trainerId),
    index("schedule_events_class_type_idx").on(table.classTypeId),
    index("schedule_events_room_idx").on(table.roomId),
  ],
);

export const scheduleSettings = sqliteTable(
  "schedule_settings",
  {
    scheduleId: text("schedule_id").primaryKey(),
    visibleDays: text("visible_days", { mode: "json" }).$type<number[]>(),
    startTime: text("start_time").notNull().default("08:00"),
    endTime: text("end_time").notNull().default("21:00"),
    defaultInterval: integer("default_interval").notNull().default(60),
    customMarkers: text("custom_markers", { mode: "json" }).$type<string[]>(),
    snapMinutes: integer("snap_minutes").notNull().default(15),
    themeId: text("theme_id").notNull().default("risen-team-dark"),
    showTrainerLegend: integer("show_trainer_legend", { mode: "boolean" }).notNull().default(true),
    legendPosition: text("legend_position").notNull().default("right"), // right | bottom
    showLogo: integer("show_logo", { mode: "boolean" }).notNull().default(true),
    logoDataUrl: text("logo_data_url"),
    scheduleTitle: text("schedule_title").notNull().default("RISEN TEAM"),
    scheduleSubtitle: text("schedule_subtitle").notNull().default("РОЗКЛАД ТРЕНУВАНЬ"),
    effectiveDate: text("effective_date"),
    exportPaper: text("export_paper").notNull().default("original"),
    exportOrientation: text("export_orientation").notNull().default("landscape"),
    exportScale: integer("export_scale").notNull().default(2),
    customExportWidth: integer("custom_export_width").notNull().default(1680),
    customExportHeight: integer("custom_export_height").notNull().default(880),
    autosave: integer("autosave", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.scheduleId],
      foreignColumns: [schedules.id],
      name: "schedule_settings_schedule_fk",
    })
      .onDelete("restrict")
      .onUpdate("no action"),
  ],
);

export const scheduleVersions = sqliteTable(
  "schedule_versions",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    source: text("source").notNull().default("automatic"), // automatic|manual|publish|restore|import|seed
    description: text("description").notNull().default(""),
    snapshot: text("snapshot", { mode: "json" }).$type<unknown>(),
    restoredFromVersionId: text("restored_from_version_id"),
  },
  (table) => [
    check(
      "schedule_versions_not_self_restore",
      sql`${table.restoredFromVersionId} IS NULL OR ${table.restoredFromVersionId} <> ${table.id}`,
    ),
    foreignKey({ columns: [table.scheduleId], foreignColumns: [schedules.id], name: "schedule_versions_schedule_fk" })
      .onDelete("restrict")
      .onUpdate("no action"),
    foreignKey({
      columns: [table.restoredFromVersionId],
      foreignColumns: [table.id],
      name: "schedule_versions_restored_from_fk",
    })
      .onDelete("set null")
      .onUpdate("no action"),
    index("schedule_versions_schedule_idx").on(table.scheduleId),
    index("schedule_versions_restored_from_idx").on(table.restoredFromVersionId),
  ],
);

export type AppMetaRow = typeof appMeta.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type TrainerRow = typeof trainers.$inferSelect;
export type ClassTypeRow = typeof classTypes.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type ScheduleEventRow = typeof scheduleEvents.$inferSelect;
export type ScheduleSettingsRow = typeof scheduleSettings.$inferSelect;
export type ScheduleVersionRow = typeof scheduleVersions.$inferSelect;
