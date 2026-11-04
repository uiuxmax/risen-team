import { BACKUP_APP_ID, BACKUP_SCHEMA_VERSION, KNOWN_BACKUP_APPS, backupSchema } from "@/lib/server/contracts";
import type { BackupPayload } from "@/lib/server/backup-types";
import type { ClassType, Room, ScheduleEvent, Trainer } from "@/lib/domain/types";
import { AppError, IMPORT_FAILED_MESSAGE, serverTranslate } from "@/lib/server/workspace";
import { validateScheduleState } from "@/lib/schedule/validation";

/**
 * Backup/import graph validation.
 *
 * Two boundaries, both funnelled through the SHARED schedule-state engine
 * (`validateScheduleState`) — never a duplicate copy of those rules:
 *
 *   1. `parseBackupPayload` + `validateBackupPreflight` run BEFORE anything is
 *      written (not even the safety-backup file is touched before they pass).
 *      Any failure throws and the database is byte-identical to before.
 *
 *   2. `verifyFinalGraph` runs INSIDE the import transaction, after all writes
 *      but before commit. Any failure throws and SQLite rolls everything back.
 *
 * Product warnings (trainer eligibility, trainer/room clashes, duplicate
 * classes) NEVER block an import — only structural errors do. A backup that
 * merely carries warnings imports exactly like a clean one.
 */

/** Shape error kept byte-identical to the long-standing import message. */
const BACKUP_INCOMPATIBLE_MESSAGE =
  "Це не сумісна резервна копія Risen Team (очікується schemaVersion 1). Поточні дані не змінено.";

function fail(detail: string): never {
  throw new AppError(`${IMPORT_FAILED_MESSAGE} ${detail}`, 422);
}

/**
 * Stage 1 — metadata + shape.
 *
 * Produces specific, actionable errors for the cases operators can actually
 * fix (wrong file, newer app version) instead of one generic message:
 *   - non-object / wrong-typed `schemaVersion` / missing collections → incompatible;
 *   - numeric `schemaVersion` other than 1 → unsupported-version error;
 *   - unknown `app` → invalid-application error;
 *   - unparseable timestamps → invalid-timestamp error.
 */
export function parseBackupPayload(raw: unknown): BackupPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AppError(BACKUP_INCOMPATIBLE_MESSAGE, 422);
  }
  const candidate = raw as Record<string, unknown>;

  const schemaVersion = candidate.schemaVersion;
  if (schemaVersion !== BACKUP_SCHEMA_VERSION) {
    if (typeof schemaVersion === "number") {
      fail(
        serverTranslate("api.backupUnsupportedVersion", {
          received: String(schemaVersion),
          expected: `schemaVersion ${BACKUP_SCHEMA_VERSION}`,
        }),
      );
    }
    throw new AppError(BACKUP_INCOMPATIBLE_MESSAGE, 422);
  }

  const app = candidate.app;
  if (typeof app !== "string" || !(KNOWN_BACKUP_APPS as readonly string[]).includes(app)) {
    fail(
      serverTranslate("api.backupInvalidApp", {
        received: typeof app === "string" && app.length > 0 ? `«${app}»` : "—",
        expected: `«${BACKUP_APP_ID}»`,
      }),
    );
  }

  checkTimestamp(candidate.exportedAt, "exportedAt");
  if (Array.isArray(candidate.schedules)) {
    for (const entry of candidate.schedules) {
      const row = entry as Record<string, unknown> | null;
      if (row && typeof row === "object" && row.publishedAt != null) {
        checkTimestamp(row.publishedAt, "schedules.publishedAt");
      }
    }
  }
  if (Array.isArray(candidate.versions)) {
    for (const entry of candidate.versions) {
      const row = entry as Record<string, unknown> | null;
      if (row && typeof row === "object") {
        checkTimestamp(row.createdAt, "versions.createdAt");
      }
    }
  }

  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(BACKUP_INCOMPATIBLE_MESSAGE, 422);
  }
  return parsed.data as BackupPayload;
}

function checkTimestamp(value: unknown, field: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(
      serverTranslate("api.backupInvalidTimestamp", {
        value: typeof value === "string" && value.length > 0 ? value : "—",
        field,
      }),
    );
  }
}

/**
 * Read-only database context for merge-mode preflight.
 *
 * Replace wipes the database, so both sets stay empty; merge keeps untouched
 * schedules, so the backup must not collide with them.
 */
export interface BackupPreflightContext {
  /** Version ids already stored in the database (merge fallback for restore refs). */
  dbVersionIds: Set<string>;
  /** Event ids owned by schedules NOT included in the backup (merge collision guard). */
  protectedEventIds: Set<string>;
}

export function emptyPreflightContext(): BackupPreflightContext {
  return { dbVersionIds: new Set(), protectedEventIds: new Set() };
}

/**
 * Stage 2 — full reference-graph preflight. Throws on the first problem;
 * never writes. Check order is deliberate: cheap structural checks first,
 * and relationship errors surface before schedule-state errors so the
 * operator sees the most actionable message.
 */
export function validateBackupPreflight(
  backup: BackupPayload,
  mode: "merge" | "replace",
  ctx: BackupPreflightContext,
): void {
  validateBackupDuplicates(backup);
  validateBackupActiveInvariant(backup);
  validateBackupRelations(backup, mode, ctx);
  validateBackupSettingsCompleteness(backup);
  validateBackupSnapshots(backup);
  validateBackupScheduleStates(backup);
  if (mode === "merge") {
    validateMergeCollisions(backup, ctx);
  }
}

function findDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function duplicateError(id: string, collection: string): never {
  fail(serverTranslate("api.backupDuplicateId", { id, collection }));
}

/**
 * Duplicate-ID policy.
 *
 * Every collection enforces identifier uniqueness GLOBALLY within itself —
 * in particular event ids are primary keys across ALL schedules, not per
 * schedule, so the same event id on two schedules is rejected here instead
 * of exploding as a SQLite primary-key violation halfway through the import.
 *
 * Different entity types live in separate tables (separate namespaces), so an
 * id reused across, e.g., a schedule and a trainer is NOT treated as a
 * duplicate. Snapshots legitimately repeat top-level ids (they are historical
 * copies), so snapshot↔top-level overlap is also allowed — but ids must still
 * be unique WITHIN each snapshot (see `validateBackupSnapshots`).
 */
function validateBackupDuplicates(backup: BackupPayload): void {
  const duplicateSchedule = findDuplicate(backup.schedules.map((schedule) => schedule.id));
  if (duplicateSchedule) duplicateError(duplicateSchedule, "розклади");

  const duplicateEvent = findDuplicate(backup.events.map((event) => event.id));
  if (duplicateEvent) duplicateError(duplicateEvent, "заняття");

  const duplicateTrainer = findDuplicate(backup.trainers.map((trainer) => trainer.id));
  if (duplicateTrainer) duplicateError(duplicateTrainer, "тренери");

  const duplicateClassType = findDuplicate(backup.classTypes.map((classType) => classType.id));
  if (duplicateClassType) duplicateError(duplicateClassType, "типи занять");

  const duplicateRoom = findDuplicate(backup.rooms.map((room) => room.id));
  if (duplicateRoom) duplicateError(duplicateRoom, "зали");

  const duplicateSettings = findDuplicate(backup.settings.map((settings) => settings.scheduleId));
  if (duplicateSettings) duplicateError(duplicateSettings, "налаштування розкладів");

  const duplicateVersion = findDuplicate(backup.versions.map((version) => version.id));
  if (duplicateVersion) duplicateError(duplicateVersion, "версії");

  // Trainer/class links are stored as `trainerIds` arrays; a repeated trainer
  // inside one class type would violate the link primary key mid-import.
  for (const classType of backup.classTypes) {
    const duplicateLink = findDuplicate(classType.trainerIds);
    if (duplicateLink) duplicateError(duplicateLink, `зв’язки тренерів типу заняття «${classType.name}»`);
  }
}

/**
 * Active-schedule invariant (backup-internal part).
 *
 * Product invariant: at most one schedule is active, an active schedule is
 * never archived, and a workspace with any non-archived schedule has exactly
 * one active schedule.
 *
 *   - zero schedules → rejected (unchanged legacy behaviour);
 *   - active + archived → rejected (no valid interpretation exists);
 *   - more than one active → rejected (there is no established policy for
 *     picking a winner, so silent normalization is forbidden);
 *   - zero active → ALLOWED and normalized explicitly during import: replace
 *     mode activates the first non-archived backup schedule, merge mode keeps
 *     the workspace selection (see `importBackup`).
 */
function validateBackupActiveInvariant(backup: BackupPayload): void {
  if (backup.schedules.length === 0) {
    fail("У резервній копії немає жодного розкладу.");
  }
  for (const schedule of backup.schedules) {
    if (schedule.isActive && schedule.isArchived) {
      fail(serverTranslate("api.backupActiveArchived", { name: schedule.name }));
    }
  }
  const activeCount = backup.schedules.filter((schedule) => schedule.isActive).length;
  if (activeCount > 1) {
    fail(serverTranslate("api.backupAmbiguousActive", { count: activeCount }));
  }
}

/**
 * Complete top-level reference validation. Historical messages are preserved
 * byte-identical; only the new `restoredFromVersionId` rules add messages.
 *
 * `restoredFromVersionId` domain policy: a restore checkpoint points at the
 * version it was restored FROM, so a non-null value must reference a version
 * that survives the import — one from the backup itself, or (merge only) one
 * already stored in the database. Self-references are always corruption.
 */
function validateBackupRelations(
  backup: BackupPayload,
  mode: "merge" | "replace",
  ctx: BackupPreflightContext,
): void {
  const trainerIds = new Set(backup.trainers.map((trainer) => trainer.id));
  const classTypeIds = new Set(backup.classTypes.map((classType) => classType.id));
  const scheduleIds = new Set(backup.schedules.map((schedule) => schedule.id));
  const roomIds = new Set(backup.rooms.map((room) => room.id));

  for (const classType of backup.classTypes) {
    for (const trainerId of classType.trainerIds) {
      if (!trainerIds.has(trainerId)) {
        fail(`Тип заняття «${classType.name}» посилається на відсутнього тренера.`);
      }
    }
  }

  for (const event of backup.events) {
    if (!scheduleIds.has(event.scheduleId)) {
      fail("Заняття посилається на розклад, якого немає в копії.");
    }
  }
  for (const event of backup.events) {
    if (!trainerIds.has(event.trainerId)) {
      fail("Заняття посилається на відсутнього тренера.");
    }
  }
  for (const event of backup.events) {
    if (!classTypeIds.has(event.classTypeId)) {
      fail("Заняття посилається на відсутній тип заняття.");
    }
  }
  for (const event of backup.events) {
    if (event.roomId && !roomIds.has(event.roomId)) {
      fail("Заняття посилається на відсутній зал.");
    }
  }
  for (const settings of backup.settings) {
    if (!scheduleIds.has(settings.scheduleId)) {
      fail("Налаштування посилаються на відсутній розклад.");
    }
  }
  for (const version of backup.versions) {
    if (!scheduleIds.has(version.scheduleId)) {
      fail("Версія посилається на відсутній розклад.");
    }
  }

  const backupVersionIds = new Set(backup.versions.map((version) => version.id));
  for (const version of backup.versions) {
    const target = version.restoredFromVersionId;
    if (target == null) continue;
    if (target === version.id) {
      fail(serverTranslate("api.backupSelfRestoreRef", { id: version.id }));
    }
    const survives = backupVersionIds.has(target) || (mode === "merge" && ctx.dbVersionIds.has(target));
    if (!survives) {
      fail(serverTranslate("api.backupDanglingRestoreRef", { id: version.id, target }));
    }
  }
}

/**
 * Completeness rule: every schedule included in the backup must bring its own
 * settings row. A missing row means the payload is incomplete, and importing
 * it must NEVER silently erase the schedule's current events/settings — in
 * merge mode by falling back to defaults, in replace mode by inventing state
 * that was never exported. Reject instead, in both modes.
 */
function validateBackupSettingsCompleteness(backup: BackupPayload): void {
  const settingsSchedules = new Set(backup.settings.map((settings) => settings.scheduleId));
  for (const schedule of backup.schedules) {
    if (!settingsSchedules.has(schedule.id)) {
      fail(serverTranslate("api.backupMissingSettings", { name: schedule.name }));
    }
  }
}

/**
 * Recursive historical-snapshot validation.
 *
 * Every imported version snapshot must itself be semantically valid, otherwise
 * a corrupt snapshot would sit in history only to fail later during Restore:
 *   - the snapshot's schedule id matches the version owner (and so does every
 *     snapshot event's schedule id);
 *   - ids are unique within the snapshot (events, trainers, class types, rooms);
 *   - snapshot trainer/class links resolve within the snapshot;
 *   - the snapshot state passes the SHARED schedule-state engine (window,
 *     bounds, time ordering, precision, trainer/class/room references).
 * Snapshot warnings (eligibility, clashes, duplicates) stay warnings.
 */
function validateBackupSnapshots(backup: BackupPayload): void {
  for (const version of backup.versions) {
    const snapshot = version.snapshot;

    if (snapshot.schedule.id !== version.scheduleId) {
      fail(
        serverTranslate("api.backupSnapshotMismatch", {
          snapshotId: snapshot.schedule.id,
          ownerId: version.scheduleId,
        }),
      );
    }
    for (const event of snapshot.events) {
      if (event.scheduleId !== version.scheduleId) {
        fail(
          serverTranslate("api.backupInvalidSnapshot", {
            id: version.id,
            reason: `заняття «${event.id}» належить розкладу «${event.scheduleId}»`,
          }),
        );
      }
    }

    const snapshotLabel = `знімок версії «${version.id}»`;
    const duplicateSnapshotEvent = findDuplicate(snapshot.events.map((event) => event.id));
    if (duplicateSnapshotEvent) duplicateError(duplicateSnapshotEvent, snapshotLabel);
    const duplicateSnapshotTrainer = findDuplicate(snapshot.trainers.map((trainer) => trainer.id));
    if (duplicateSnapshotTrainer) duplicateError(duplicateSnapshotTrainer, snapshotLabel);
    const duplicateSnapshotClass = findDuplicate(snapshot.classTypes.map((classType) => classType.id));
    if (duplicateSnapshotClass) duplicateError(duplicateSnapshotClass, snapshotLabel);
    const duplicateSnapshotRoom = findDuplicate(snapshot.rooms.map((room) => room.id));
    if (duplicateSnapshotRoom) duplicateError(duplicateSnapshotRoom, snapshotLabel);
    for (const classType of snapshot.classTypes) {
      const duplicateLink = findDuplicate(classType.trainerIds);
      if (duplicateLink) duplicateError(duplicateLink, snapshotLabel);
    }

    const snapshotTrainerIds = new Set(snapshot.trainers.map((trainer) => trainer.id));
    for (const classType of snapshot.classTypes) {
      for (const trainerId of classType.trainerIds) {
        if (!snapshotTrainerIds.has(trainerId)) {
          fail(
            serverTranslate("api.backupInvalidSnapshot", {
              id: version.id,
              reason: `тип заняття «${classType.name}» посилається на відсутнього тренера`,
            }),
          );
        }
      }
    }

    const validation = validateScheduleState(
      {
        settings: snapshot.settings,
        events: snapshot.events,
        trainers: snapshot.trainers,
        classTypes: snapshot.classTypes,
        rooms: snapshot.rooms,
      },
      serverTranslate,
    );
    if (validation.errors.length > 0) {
      fail(
        serverTranslate("api.backupInvalidSnapshot", {
          id: version.id,
          reason: validation.errors[0].message,
        }),
      );
    }
  }
}

/**
 * Current-state validation through the shared engine (unchanged semantics,
 * minus the old silent `DEFAULT_SETTINGS` fallback — completeness is now
 * guaranteed by `validateBackupSettingsCompleteness` above).
 */
function validateBackupScheduleStates(backup: BackupPayload): void {
  for (const schedule of backup.schedules) {
    const settings = backup.settings.find((item) => item.scheduleId === schedule.id);
    if (!settings) {
      // Unreachable after the completeness check; defensive only — a missing
      // row must reject, never silently fall back to defaults.
      fail(serverTranslate("api.backupMissingSettings", { name: schedule.name }));
    }
    const validation = validateScheduleState(
      {
        settings,
        events: backup.events.filter((item) => item.scheduleId === schedule.id),
        trainers: backup.trainers,
        classTypes: backup.classTypes,
        rooms: backup.rooms,
      },
      serverTranslate,
    );
    if (validation.errors.length > 0) {
      throw new AppError(`${IMPORT_FAILED_MESSAGE} ${validation.errors[0].message}`, 422);
    }
  }
}

/**
 * Merge-only collision guard: a backup event id already owned by a schedule
 * the backup does NOT include would violate the event primary key mid-import
 * (untouched schedules are never deleted). Rejected here instead.
 */
function validateMergeCollisions(backup: BackupPayload, ctx: BackupPreflightContext): void {
  for (const event of backup.events) {
    if (ctx.protectedEventIds.has(event.id)) {
      fail(serverTranslate("api.backupMergeCollision", { id: event.id }));
    }
  }
}

/**
 * Final graph verification — runs INSIDE the import transaction, after all
 * writes but before commit. Pure function over the resulting rows: any failure
 * throws and SQLite rolls the whole import back.
 *
 * Checks the RESULTING workspace graph (not just the backup):
 *   - every event resolves its schedule/trainer/class/room;
 *   - every settings row maps to a schedule;
 *   - every version maps to a schedule and its restore reference resolves;
 *   - every trainer/class link resolves on both sides;
 *   - the active-schedule invariant holds over the whole workspace;
 *   - every IMPORTED schedule state is still structurally valid (shared
 *     engine, warnings pass).
 *
 * Note: untouched schedules keep their pre-existing state, but the resulting
 * graph must still be fully valid — a merge into a workspace with pre-existing
 * corruption is rejected until the workspace is repaired (via the normal UI
 * actions) or replaced. Replace mode always yields exactly the backup graph.
 */
export interface FinalGraphInput {
  schedules: { id: string; name: string; isActive: boolean; isArchived: boolean }[];
  trainers: { id: string; name: string }[];
  classTypes: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  events: {
    id: string;
    scheduleId: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    trainerId: string;
    classTypeId: string;
    roomId: string | null;
  }[];
  settings: { scheduleId: string; startTime: string; endTime: string }[];
  versions: { id: string; scheduleId: string; restoredFromVersionId: string | null }[];
  links: { trainerId: string; classTypeId: string }[];
}

/**
 * Active-schedule invariant over a set of schedule rows.
 *
 * Shared boundary (product rules): an active schedule is never archived, a
 * workspace can never hold two active schedules, and as long as any
 * non-archived schedule exists exactly one of them is active. Used by the
 * import final-verification below AND by the administrative mutations in
 * `admin.ts` (delete/archive/unarchive), so both sides check the very same
 * rule set instead of maintaining two copies.
 */
export function assertActiveScheduleInvariant(
  schedules: { id: string; name: string; isActive: boolean; isArchived: boolean }[],
  onError: (reason: string) => never,
): void {
  for (const schedule of schedules) {
    if (schedule.isActive && schedule.isArchived) {
      onError(`розклад «${schedule.name}» позначено одночасно активним і архівованим`);
    }
  }
  const activeCount = schedules.filter((schedule) => schedule.isActive).length;
  if (activeCount > 1) {
    onError("у робочому просторі кілька активних розкладів");
  }
  if (activeCount === 0 && schedules.some((schedule) => !schedule.isArchived)) {
    onError("у робочому просторі немає активного розкладу");
  }
}

export function verifyFinalGraph(final: FinalGraphInput, importedScheduleIds: Set<string>): void {
  const failFinal = (reason: string): never => {
    fail(serverTranslate("api.backupFinalCheck", { reason }));
  };

  const scheduleIds = new Set(final.schedules.map((schedule) => schedule.id));
  const trainerIds = new Set(final.trainers.map((trainer) => trainer.id));
  const classTypeIds = new Set(final.classTypes.map((classType) => classType.id));
  const roomIds = new Set(final.rooms.map((room) => room.id));
  const versionIds = new Set(final.versions.map((version) => version.id));

  for (const event of final.events) {
    if (!scheduleIds.has(event.scheduleId)) {
      failFinal(`заняття «${event.id}» посилається на відсутній розклад`);
    }
    if (!trainerIds.has(event.trainerId)) {
      failFinal(`заняття «${event.id}» посилається на відсутнього тренера`);
    }
    if (!classTypeIds.has(event.classTypeId)) {
      failFinal(`заняття «${event.id}» посилається на відсутній тип заняття`);
    }
    if (event.roomId && !roomIds.has(event.roomId)) {
      failFinal(`заняття «${event.id}» посилається на відсутній зал`);
    }
  }
  for (const settings of final.settings) {
    if (!scheduleIds.has(settings.scheduleId)) {
      failFinal("налаштування посилаються на відсутній розклад");
    }
  }
  for (const version of final.versions) {
    if (!scheduleIds.has(version.scheduleId)) {
      failFinal(`версія «${version.id}» посилається на відсутній розклад`);
    }
    if (version.restoredFromVersionId && !versionIds.has(version.restoredFromVersionId)) {
      failFinal(`версія «${version.id}» посилається на відсутню версію`);
    }
  }
  for (const link of final.links) {
    if (!trainerIds.has(link.trainerId) || !classTypeIds.has(link.classTypeId)) {
      failFinal("зв’язок тренера й типу заняття посилається на відсутній запис");
    }
  }

  assertActiveScheduleInvariant(final.schedules, failFinal);

  const linksByClassType = new Map<string, string[]>();
  for (const link of final.links) {
    const list = linksByClassType.get(link.classTypeId);
    if (list) list.push(link.trainerId);
    else linksByClassType.set(link.classTypeId, [link.trainerId]);
  }
  // Minimal shapes carry every field the shared engine reads for structural
  // errors (ids, names, links, times); the casts below are safe by construction.
  const trainers = final.trainers as Trainer[];
  const classTypes = final.classTypes.map(
    (classType) =>
      ({ ...classType, trainerIds: linksByClassType.get(classType.id) ?? [] }) as ClassType,
  );
  const rooms = final.rooms as Room[];
  for (const scheduleId of importedScheduleIds) {
    const settings =
      final.settings.find((item) => item.scheduleId === scheduleId) ??
      failFinal(`розклад «${scheduleId}» не має налаштувань після імпорту`);
    const validation = validateScheduleState(
      {
        settings: { startTime: settings.startTime, endTime: settings.endTime },
        events: final.events.filter((event) => event.scheduleId === scheduleId) as ScheduleEvent[],
        trainers,
        classTypes,
        rooms,
      },
      serverTranslate,
    );
    if (validation.errors.length > 0) {
      failFinal(validation.errors[0].message);
    }
  }
}
