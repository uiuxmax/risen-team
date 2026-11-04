import { configuredWorkspaceRoot } from "@/db/paths";
import { storeLogoDataUrl, readLogoDataUrl } from "@/lib/server/assets";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  classTypes,
  rooms,
  scheduleEvents,
  scheduleSettings,
  scheduleVersions,
  schedules,
  trainerClassTypes,
  trainers,
} from "@/db/schema";
import type {
  ClassType,
  Room,
  Schedule,
  ScheduleEvent,
  ScheduleSettings,
  SnapshotContent,
  Trainer,
  VersionSummary,
  Workspace,
} from "@/lib/domain/types";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { snapshotSchema, saveStateSchema } from "@/lib/server/contracts";
import { validateScheduleState } from "@/lib/schedule/validation";
import { createTranslator } from "@/lib/i18n";
import { writeSafetyBackup } from "@/lib/server/backups";
import type { BackupPayload } from "@/lib/server/backup-types";
import type { AppDatabase } from "@/db";
import type { z } from "zod";

const AUTO_SNAPSHOT_INTERVAL_MS = 90 * 1000;

/**
 * Server-side validation messages use the application's default language
 * (Ukrainian). The editor validates in the operator's chosen language first, so
 * these strings only ever surface for unusual failure cases.
 */
export const serverTranslate = createTranslator("uk");

export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Russian/Ukrainian message shown when an operation was fully rolled back. */
export const IMPORT_FAILED_MESSAGE =
  "Не вдалося імпортувати резервну копію. Поточні дані не змінено.";

/**
 * Destructive-operation policy boundary.
 *
 * Operations that can lose data (backup import, version restore, schedule
 * deletion) call this instead of `writeSafetyBackup`: when the safety copy
 * cannot be written the operation is CANCELLED before anything is mutated and
 * the operator gets an actionable, localized error. Operations that merely
 * write a convenience backup (publish) keep using `writeSafetyBackup` directly
 * and are never blocked by a failed backup.
 */
export function requireSafetyBackup(reason: string, backup: BackupPayload = exportBackup()): string {
  const result = writeSafetyBackup(backup, reason);
  if (!result.file) {
    throw new AppError(serverTranslate("api.safetyBackupFailed"), 503);
  }
  return result.file;
}

export function loadWorkspace(preferredScheduleId?: string): Workspace {
  const db = getDb();
  let scheduleRows = db.select().from(schedules).orderBy(desc(schedules.updatedAt)).all();
  if (scheduleRows.length === 0) {
    createStarterSchedule();
    scheduleRows = db.select().from(schedules).orderBy(desc(schedules.updatedAt)).all();
  }

  const activeRow =
    scheduleRows.find((row) => row.id === preferredScheduleId) ??
    scheduleRows.find((row) => row.isActive && !row.isArchived) ??
    scheduleRows[0];

  const trainerRows = db.select().from(trainers).orderBy(trainers.sortOrder, trainers.name).all();
  const classTypeRows = db.select().from(classTypes).orderBy(classTypes.sortOrder, classTypes.name).all();
  const linkRows = db.select().from(trainerClassTypes).all();
  const roomRows = db.select().from(rooms).orderBy(rooms.sortOrder, rooms.name).all();
  const eventRows = db.select().from(scheduleEvents).where(eq(scheduleEvents.scheduleId, activeRow.id)).all();
  const settingsRows = db.select().from(scheduleSettings).where(eq(scheduleSettings.scheduleId, activeRow.id)).limit(1).all();
  const versionRows = db
    .select({
      id: scheduleVersions.id,
      scheduleId: scheduleVersions.scheduleId,
      createdAt: scheduleVersions.createdAt,
      source: scheduleVersions.source,
      description: scheduleVersions.description,
      restoredFromVersionId: scheduleVersions.restoredFromVersionId,
    })
    .from(scheduleVersions)
    .where(eq(scheduleVersions.scheduleId, activeRow.id))
    .orderBy(desc(scheduleVersions.createdAt))
    .limit(60)
    .all();

  const linksByClassType = new Map<string, string[]>();
  for (const link of linkRows) {
    const list = linksByClassType.get(link.classTypeId);
    if (list) list.push(link.trainerId);
    else linksByClassType.set(link.classTypeId, [link.trainerId]);
  }

  return {
    schedules: scheduleRows.map(mapSchedule),
    activeScheduleId: activeRow.id,
      trainers: trainerRows.map<Trainer>((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        initials: row.initials,
        notes: row.notes,
        active: row.active,
        sortOrder: row.sortOrder,
      })),
      classTypes: classTypeRows.map<ClassType>((row) => ({
        id: row.id,
        name: row.name,
        shortName: row.shortName,
        defaultDuration: row.defaultDuration,
        color: row.color,
        description: row.description,
        active: row.active,
        sortOrder: row.sortOrder,
        trainerIds: linksByClassType.get(row.id) ?? [],
      })),
    rooms: roomRows.map<Room>((row) => ({ id: row.id, name: row.name, active: row.active, sortOrder: row.sortOrder })),
    state: {
      schedule: mapSchedule(activeRow),
      settings: settingsRows[0] ? mapSettings(settingsRows[0]) : { ...DEFAULT_SETTINGS },
      events: eventRows.map(mapEvent),
    },
    versions: versionRows.map<VersionSummary>((row) => ({
      id: row.id,
      scheduleId: row.scheduleId,
      createdAt: row.createdAt.toISOString(),
      source: row.source as VersionSummary["source"],
      description: row.description,
      restoredFromVersionId: row.restoredFromVersionId,
    })),
  };
}

export function mapSchedule(row: {
  id: string;
  name: string;
  status: string;
  isActive: boolean;
  isArchived: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
}): Schedule {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "published" ? "published" : "draft",
    isActive: row.isActive,
    isArchived: row.isArchived,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSettings(row: typeof scheduleSettings.$inferSelect): ScheduleSettings {
  return {
    visibleDays: (row.visibleDays ?? DEFAULT_SETTINGS.visibleDays).filter((day) => day >= 0 && day <= 6),
    startTime: row.startTime,
    endTime: row.endTime,
    defaultInterval: row.defaultInterval,
    customMarkers: row.customMarkers ?? [],
    snapMinutes: (row.snapMinutes as ScheduleSettings["snapMinutes"]) ?? 15,
    themeId: row.themeId,
    showTrainerLegend: row.showTrainerLegend,
    legendPosition: row.legendPosition === "bottom" ? "bottom" : "right",
    showLogo: row.showLogo,
    logoDataUrl: hydrateLogo(row.logoDataUrl),
    scheduleTitle: row.scheduleTitle,
    scheduleSubtitle: row.scheduleSubtitle,
    effectiveDate: row.effectiveDate,
    exportPaper: (row.exportPaper as ScheduleSettings["exportPaper"]) ?? "original",
    exportOrientation: row.exportOrientation === "portrait" ? "portrait" : "landscape",
    exportScale: (Math.min(4, Math.max(1, row.exportScale)) as ScheduleSettings["exportScale"]) ?? 2,
    customExportWidth: row.customExportWidth,
    customExportHeight: row.customExportHeight,
    autosave: row.autosave,
  };
}

function mapEvent(row: typeof scheduleEvents.$inferSelect): ScheduleEvent {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    trainerId: row.trainerId,
    classTypeId: row.classTypeId,
    roomId: row.roomId,
    notes: row.notes,
  };
}

/** Creates a usable empty schedule (used when a workspace has none at all). */
export function createStarterSchedule(): string {
  const db = getDb();
  const id = "sched-main";
  const now = new Date();
  db.transaction((tx) => {
    tx.insert(schedules)
      .values({
        id,
        name: "Основний розклад",
        status: "draft",
        isActive: true,
        isArchived: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    tx.insert(scheduleSettings)
      .values({ scheduleId: id, ...DEFAULT_SETTINGS, updatedAt: now })
      .onConflictDoNothing()
      .run();
  });
  const existing = db.select({ id: scheduleVersions.id }).from(scheduleVersions).where(eq(scheduleVersions.scheduleId, id)).limit(1).all();
  if (existing.length === 0) createVersion({ scheduleId: id, source: "manual", description: "Розклад створено" });
  return id;
}

export type SaveStatePayload = z.infer<typeof saveStateSchema>;

export interface SaveStateResult {
  savedAt: string;
  versionCreated: VersionSummary | null;
  warnings: string[];
  status: "draft" | "published";
}

export function saveScheduleState(raw: unknown): SaveStateResult {
  const db = getDb();
  const payload = saveStateSchema.parse(raw);
  const scheduleRow = getScheduleRow(payload.scheduleId);

  const trainerRows = db.select().from(trainers).all();
  const classTypeRows = db.select().from(classTypes).all();
  const linkRows = db.select().from(trainerClassTypes).all();
  const roomRows = db.select().from(rooms).all();

  const linksByClassType = new Map<string, string[]>();
  for (const link of linkRows) {
    const list = linksByClassType.get(link.classTypeId);
    if (list) list.push(link.trainerId);
    else linksByClassType.set(link.classTypeId, [link.trainerId]);
  }

  // Shared schedule-state validation boundary: the same semantic rules used by
  // the Add/Edit dialog, backup import and version restore. Structural errors
  // reject the save BEFORE anything is written to SQLite.
  const validation = validateScheduleState(
    {
      settings: payload.settings,
      events: payload.events,
      trainers: trainerRows.map<Trainer>((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        initials: row.initials,
        notes: row.notes,
        active: row.active,
        sortOrder: row.sortOrder,
      })),
      classTypes: classTypeRows.map<ClassType>((row) => ({
        id: row.id,
        name: row.name,
        shortName: row.shortName,
        defaultDuration: row.defaultDuration,
        color: row.color,
        description: row.description,
        active: row.active,
        sortOrder: row.sortOrder,
        trainerIds: linksByClassType.get(row.id) ?? [],
      })),
      rooms: roomRows.map<Room>((row) => ({ id: row.id, name: row.name, active: row.active, sortOrder: row.sortOrder })),
    },
    serverTranslate,
  );

  if (validation.errors.length > 0) {
    throw new AppError([...new Set(validation.errors.map((error) => error.message))].join(" "), 422);
  }

  const now = new Date();
  const publishNow = payload.status === "published";
  const status = publishNow ? "published" : "draft";

  let versionCreated: VersionSummary | null = null;

  db.transaction((tx) => {
    tx.delete(scheduleEvents).where(eq(scheduleEvents.scheduleId, payload.scheduleId)).run();
    if (payload.events.length > 0) {
      tx.insert(scheduleEvents)
        .values(
          payload.events.map((event) => ({
            id: event.id,
            scheduleId: payload.scheduleId,
            dayOfWeek: event.dayOfWeek,
            startTime: event.startTime,
            endTime: event.endTime,
            trainerId: event.trainerId,
            classTypeId: event.classTypeId,
            roomId: event.roomId ?? null,
            notes: event.notes ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
    }

    const root = configuredWorkspaceRoot();
    const logo = payload.settings.logoDataUrl;
    const settingsValues = { scheduleId: payload.scheduleId, ...payload.settings, logoDataUrl: root && logo ? storeLogoDataUrl(root, logo) : logo, updatedAt: now };
    tx.insert(scheduleSettings)
      .values(settingsValues)
      .onConflictDoUpdate({ target: scheduleSettings.scheduleId, set: settingsValues })
      .run();

    tx.update(schedules)
      .set({ status, updatedAt: now, publishedAt: publishNow ? now : scheduleRow.publishedAt })
      .where(eq(schedules.id, payload.scheduleId))
      .run();

    const lastVersion = latestVersion(payload.scheduleId, tx);
    const elapsed = lastVersion ? now.getTime() - lastVersion.createdAt.getTime() : Number.MAX_SAFE_INTEGER;

    if (publishNow) {
      const snapshot = buildSnapshot(
        payload.scheduleId,
        {
          settings: payload.settings,
          events: payload.events,
          status,
        },
        tx,
      );
      versionCreated = createVersion(
        {
          scheduleId: payload.scheduleId,
          source: "publish",
          description: payload.changeDescription ? `Опубліковано — ${payload.changeDescription}` : "Розклад опубліковано",
          snapshot,
          createdAt: now,
        },
        tx,
      );
    } else if (payload.snapshot || elapsed >= AUTO_SNAPSHOT_INTERVAL_MS) {
      const snapshot = buildSnapshot(
        payload.scheduleId,
        {
          settings: payload.settings,
          events: payload.events,
          status,
        },
        tx,
      );
      versionCreated = createVersion(
        {
          scheduleId: payload.scheduleId,
          source: payload.snapshot ? "manual" : "automatic",
          description: payload.changeDescription ?? "Автоматичний знімок",
          snapshot,
          createdAt: now,
        },
        tx,
      );
    }
  });

  if (publishNow) {
    // Convenience backup only: publishing is not destructive (the state +
    // publish checkpoint were already atomically committed above), so a
    // failed backup never blocks it — see the policy note in `backups.ts`.
    try {
      writeSafetyBackup(exportBackup(), "publish");
    } catch {
      // Reading a historical logo can fail before the backup writer is called.
      // The convenience copy must not undo a successful publish or its revision.
    }
  }

  return {
    savedAt: now.toISOString(),
    versionCreated,
    warnings: validation.warnings.map((conflict) => conflict.message),
    status,
  };
}

function getScheduleRow(scheduleId: string, reader: Pick<AppDatabase, "select"> = getDb()) {
  const rows = reader.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1).all();
  if (rows.length === 0) throw new AppError("Такого розкладу більше немає.", 404);
  return rows[0];
}

function latestVersion(scheduleId: string, reader: Pick<AppDatabase, "select"> = getDb()) {
  const rows = reader
    .select({ id: scheduleVersions.id, createdAt: scheduleVersions.createdAt })
    .from(scheduleVersions)
    .where(eq(scheduleVersions.scheduleId, scheduleId))
    .orderBy(desc(scheduleVersions.createdAt))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function buildSnapshot(
  scheduleId: string,
  overrides?: {
    settings?: ScheduleSettings;
    events?: ScheduleEvent[];
    status?: "draft" | "published";
  },
  reader: DbHandle = getDb(),
): SnapshotContent {
  const scheduleRow = getScheduleRow(scheduleId, reader);
  const trainerRows = reader.select().from(trainers).orderBy(trainers.sortOrder, trainers.name).all();
  const classTypeRows = reader.select().from(classTypes).orderBy(classTypes.sortOrder, classTypes.name).all();
  const linkRows = reader.select().from(trainerClassTypes).all();
  const roomRows = reader.select().from(rooms).orderBy(rooms.sortOrder, rooms.name).all();

  const linksByClassType = new Map<string, string[]>();
  for (const link of linkRows) {
    const list = linksByClassType.get(link.classTypeId);
    if (list) list.push(link.trainerId);
    else linksByClassType.set(link.classTypeId, [link.trainerId]);
  }

  let finalSettings: ScheduleSettings;
  if (overrides?.settings) {
    finalSettings = overrides.settings;
  } else {
    const settingsRows = reader.select().from(scheduleSettings).where(eq(scheduleSettings.scheduleId, scheduleId)).limit(1).all();
    finalSettings = settingsRows[0] ? mapSettings(settingsRows[0]) : { ...DEFAULT_SETTINGS };
  }

  let finalEvents: ScheduleEvent[];
  if (overrides?.events) {
    finalEvents = overrides.events;
  } else {
    const eventRows = reader.select().from(scheduleEvents).where(eq(scheduleEvents.scheduleId, scheduleId)).all();
    finalEvents = eventRows.map(mapEvent);
  }

  const ownerIds = scopedCatalogIds(scheduleId);
  const effectiveStatus = overrides?.status ?? mapSchedule(scheduleRow).status;

  return {
    schemaVersion: 1,
    schedule: { id: scheduleRow.id, name: scheduleRow.name, status: effectiveStatus },
    settings: finalSettings,
    events: finalEvents,
    // Frozen trainer/class metadata: kept inside the snapshot so an old version can be
    // displayed correctly even if a trainer was later renamed, deactivated or removed.
    trainers: trainerRows.filter(row => !ownerIds || ownerIds.trainers.has(row.id)).map<Trainer>((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      initials: row.initials,
      notes: row.notes,
      active: row.active,
      sortOrder: row.sortOrder,
    })),
    classTypes: classTypeRows.filter(row => !ownerIds || ownerIds.classTypes.has(row.id)).map<ClassType>((row) => ({
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      defaultDuration: row.defaultDuration,
      color: row.color,
      description: row.description,
      active: row.active,
      sortOrder: row.sortOrder,
      trainerIds: linksByClassType.get(row.id) ?? [],
    })),
    rooms: roomRows.filter(row => !ownerIds || finalEvents.some(e => e.roomId === row.id)).map<Room>((row) => ({ id: row.id, name: row.name, active: row.active, sortOrder: row.sortOrder })),
  };
}

/** Minimal write handle: the pooled connection or a live transaction. */
type DbWriter = Pick<AppDatabase, "insert">;

/** Read+write handle for the atomic administrative mutations in `admin.ts`. */
export type DbHandle = Pick<AppDatabase, "insert" | "select" | "update" | "delete">;

export function createVersion(
  input: {
    scheduleId: string;
    source: VersionSummary["source"];
    description: string;
    snapshot?: SnapshotContent;
    restoredFromVersionId?: string | null;
    id?: string;
    createdAt?: Date;
  },
  writer: DbWriter = getDb(),
): VersionSummary {
  const snapshot = input.snapshot ?? buildSnapshot(input.scheduleId);
  const createdAt = input.createdAt ?? new Date();
  const id = input.id ?? crypto.randomUUID();
  const description = input.description.slice(0, 240);
  writer
    .insert(scheduleVersions)
    .values({
      id,
      scheduleId: input.scheduleId,
      createdAt,
      source: input.source,
      description,
      snapshot,
      restoredFromVersionId: input.restoredFromVersionId ?? null,
    })
    .run();
  return {
    id,
    scheduleId: input.scheduleId,
    createdAt: createdAt.toISOString(),
    source: input.source,
    description,
    restoredFromVersionId: input.restoredFromVersionId ?? null,
  };
}

export function getVersionSnapshot(versionId: string): { scheduleId: string; snapshot: SnapshotContent } {
  const rows = getDb().select().from(scheduleVersions).where(eq(scheduleVersions.id, versionId)).limit(1).all();
  if (rows.length === 0) throw new AppError("Ця версія більше недоступна.", 404);
  const parsed = snapshotSchema.safeParse(rows[0].snapshot);
  if (!parsed.success) throw new AppError("Знімок цієї версії пошкоджений і не може бути відновлений.", 422);
  return { scheduleId: rows[0].scheduleId, snapshot: parsed.data as SnapshotContent };
}

export interface RestoreResult {
  scheduleId: string;
  version: VersionSummary;
}

/**
 * Restores ONE schedule.
 *
 * Only schedule-scoped data is replaced (events, time window, visible days,
 * custom markers, schedule display settings, schedule status). Workspace-level
 * entities — trainers and class types — are never renamed, removed or
 * repointed, so other schedules keep working. If the snapshot references a
 * trainer/class/room that no longer exists at all, the missing entry is
 * re-created (insert-only) with its historical metadata so the restored
 * schedule keeps its correct names, colours and room references. Entities that
 * still exist keep their CURRENT metadata — a restore never overwrites them.
 *
 * History is append-only: the restore itself is recorded as a new version,
 * inside the same transaction as the data replacement, so a failure anywhere
 * rolls back the whole operation.
 */
export function restoreVersion(versionId: string): RestoreResult {
  const db = getDb();
  const { scheduleId, snapshot } = getVersionSnapshot(versionId);
  const original = db
    .select({ createdAt: scheduleVersions.createdAt, description: scheduleVersions.description })
    .from(scheduleVersions)
    .where(eq(scheduleVersions.id, versionId))
    .limit(1)
    .all();

  const currentTrainerRows = db.select().from(trainers).all();
  const currentClassTypeRows = db.select().from(classTypes).all();
  const linkRows = db.select().from(trainerClassTypes).all();
  const currentRoomRows = db.select().from(rooms).all();

  const linksByClassType = new Map<string, string[]>();
  for (const link of linkRows) {
    const list = linksByClassType.get(link.classTypeId);
    if (list) list.push(link.trainerId);
    else linksByClassType.set(link.classTypeId, [link.trainerId]);
  }

  const currentTrainers = currentTrainerRows.map<Trainer>((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    initials: row.initials,
    notes: row.notes,
    active: row.active,
    sortOrder: row.sortOrder,
  }));
  const currentClassTypes = currentClassTypeRows.map<ClassType>((row) => ({
    id: row.id,
    name: row.name,
    shortName: row.shortName,
    defaultDuration: row.defaultDuration,
    color: row.color,
    description: row.description,
    active: row.active,
    sortOrder: row.sortOrder,
    trainerIds: linksByClassType.get(row.id) ?? [],
  }));
  const currentRooms = currentRoomRows.map<Room>((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    sortOrder: row.sortOrder,
  }));

  // Effective post-restore entity universe (current entries win): missing
  // historical entities are re-created insert-only below, so a reference that
  // resolves here is exactly a reference that will resolve after the restore.
  const validation = validateScheduleState(
    {
      settings: snapshot.settings,
      events: snapshot.events,
      trainers: mergeEntities(currentTrainers, snapshot.trainers),
      classTypes: mergeEntities(currentClassTypes, snapshot.classTypes),
      rooms: mergeEntities(currentRooms, snapshot.rooms),
    },
    serverTranslate,
  );
  if (validation.errors.length > 0) {
    throw new AppError([...new Set(validation.errors.map((error) => error.message))].join(" "), 422);
  }

  // A restore replaces the schedule's current state, so it is BACKUP-GATED: if
  // the safety copy cannot be written the restore is cancelled untouched.
  requireSafetyBackup(`restore:${versionId}`);
  const now = new Date();

  const when = original[0]?.createdAt
    ? new Date(original[0].createdAt).toLocaleString("uk-UA", {
        day: "2-digit",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "попередньої версії";
  const restoreDescription = `Відновлено з версії від ${when}`;

  let version!: VersionSummary;
  try {
    // One transaction for entity recreation, state replacement AND the restore
    // checkpoint: partial restores cannot survive a failure.
    db.transaction((tx) => {
      const currentTrainerIds = new Set(currentTrainers.map((trainer) => trainer.id));
      for (const trainer of snapshot.trainers) {
        if (currentTrainerIds.has(trainer.id)) continue;
        tx.insert(trainers)
          .values({
            id: trainer.id,
            name: trainer.name,
            color: trainer.color,
            initials: trainer.initials ?? null,
            notes: trainer.notes ?? null,
            active: false,
            sortOrder: trainer.sortOrder,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
      }

      const currentClassTypeIds = new Set(currentClassTypes.map((classType) => classType.id));
      for (const classType of snapshot.classTypes) {
        if (currentClassTypeIds.has(classType.id)) continue;
        tx.insert(classTypes)
          .values({
            id: classType.id,
            name: classType.name,
            shortName: classType.shortName,
            defaultDuration: classType.defaultDuration,
            color: classType.color ?? null,
            description: classType.description ?? null,
            active: false,
            sortOrder: classType.sortOrder,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
        if (classType.trainerIds.length > 0) {
          tx.insert(trainerClassTypes)
            .values(classType.trainerIds.map((trainerId) => ({ trainerId, classTypeId: classType.id })))
            .onConflictDoNothing()
            .run();
        }
      }

      // Missing rooms referenced by historical events are re-created
      // insert-only with their historical id and metadata. Existing rooms keep
      // their current metadata — never overwritten by older snapshots.
      const currentRoomIds = new Set(currentRooms.map((room) => room.id));
      for (const room of snapshot.rooms) {
        if (currentRoomIds.has(room.id)) continue;
        tx.insert(rooms)
          .values({ id: room.id, name: room.name, active: room.active, sortOrder: room.sortOrder })
          .onConflictDoNothing()
          .run();
      }

      tx.delete(scheduleEvents).where(eq(scheduleEvents.scheduleId, scheduleId)).run();
      if (snapshot.events.length > 0) {
        tx.insert(scheduleEvents)
          .values(
            snapshot.events.map((event) => ({
              id: event.id,
              scheduleId,
              dayOfWeek: event.dayOfWeek,
              startTime: event.startTime,
              endTime: event.endTime,
              trainerId: event.trainerId,
              classTypeId: event.classTypeId,
              roomId: event.roomId ?? null,
              notes: event.notes ?? null,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .run();
      }

      const settingsValues = { scheduleId, ...snapshot.settings, updatedAt: now };
      tx.insert(scheduleSettings)
        .values(settingsValues)
        .onConflictDoUpdate({ target: scheduleSettings.scheduleId, set: settingsValues })
        .run();

      tx.update(schedules)
        .set({ status: snapshot.schedule.status, updatedAt: now })
        .where(eq(schedules.id, scheduleId))
        .run();

      version = createVersion(
        {
          scheduleId,
          source: "restore",
          description: restoreDescription,
          snapshot,
          restoredFromVersionId: versionId,
        },
        tx,
      );
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(serverTranslate("api.restoreFailed"), 422);
  }

  return { scheduleId, version };
}

/** Current entities win; `fallback` fills in historical entries that are gone. */
function mergeEntities<T extends { id: string }>(current: T[], fallback: T[]): T[] {
  const seen = new Set(current.map((entity) => entity.id));
  return [...current, ...fallback.filter((entity) => !seen.has(entity.id))];
}

export function listVersions(scheduleId: string, limit = 60): VersionSummary[] {
  return getDb()
    .select({
      id: scheduleVersions.id,
      scheduleId: scheduleVersions.scheduleId,
      createdAt: scheduleVersions.createdAt,
      source: scheduleVersions.source,
      description: scheduleVersions.description,
      restoredFromVersionId: scheduleVersions.restoredFromVersionId,
    })
    .from(scheduleVersions)
    .where(eq(scheduleVersions.scheduleId, scheduleId))
    .orderBy(desc(scheduleVersions.createdAt))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      scheduleId: row.scheduleId,
      createdAt: row.createdAt.toISOString(),
      source: row.source as VersionSummary["source"],
      description: row.description,
      restoredFromVersionId: row.restoredFromVersionId,
    }));
}

export function schedulesByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return getDb().select().from(schedules).where(inArray(schedules.id, ids)).all();
}

export function countEvents(scheduleId: string): number {
  const rows = getDb()
    .select({ value: sql<number>`count(*)` })
    .from(scheduleEvents)
    .where(and(eq(scheduleEvents.scheduleId, scheduleId)))
    .all();
  return rows[0]?.value ?? 0;
}

// The full-portable export/import lives in admin.ts; re-exported here to avoid
// circular imports between the two service modules.
import { exportBackup as exportBackupImpl } from "@/lib/server/export-backup";
export function exportBackup() {
  return exportBackupImpl();
}

function hydrateLogo(value: string | null): string | null {
  const root = configuredWorkspaceRoot();
  return root && value?.startsWith("assets/logos/") ? readLogoDataUrl(root, value) : value;
}
function scopedCatalogIds(scheduleId: string): { trainers: Set<string>; classTypes: Set<string> } | null {
  const db = getDb().$client;
  if (db.pragma("user_version", { simple: true }) !== 2) return null;
  const owner = db.prepare("SELECT hall_id FROM schedules WHERE id=?").get(scheduleId) as {hall_id: string};
  const ids = (table: string) => new Set((db.prepare("SELECT id FROM " + table + " WHERE hall_id=?").all(owner.hall_id) as {id:string}[]).map(r => r.id));
  return { trainers: ids("trainers"), classTypes: ids("class_types") };
}
