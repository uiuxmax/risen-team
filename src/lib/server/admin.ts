import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
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
import type { ClassType, Room, SnapshotContent, Trainer } from "@/lib/domain/types";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import {
  classTypePayloadSchema,
  roomPayloadSchema,
  scheduleActionSchema,
  trainerPayloadSchema,
} from "@/lib/server/contracts";
import {
  AppError,
  IMPORT_FAILED_MESSAGE,
  buildSnapshot,
  createVersion,
  mapSchedule,
  requireSafetyBackup,
  serverTranslate,
  type DbHandle,
} from "@/lib/server/workspace";
import { exportBackup } from "@/lib/server/export-backup";
import {
  assertActiveScheduleInvariant,
  emptyPreflightContext,
  parseBackupPayload,
  validateBackupPreflight,
  verifyFinalGraph,
} from "@/lib/server/backup-validation";
import type { BackupPayload } from "@/lib/server/backup-types";
import type { DictionaryKey } from "@/lib/i18n";

/**
 * Administrative mutations.
 *
 * Every multi-statement mutation in this module runs inside ONE SQLite
 * transaction: validation, the writes themselves and the resulting-invariant
 * check either all commit or all roll back. Failures never leak internals —
 * `rethrowSafe` logs the original error server-side and returns a localized,
 * actionable message through the normal API error funnel.
 */

/**
 * Keeps a failed administrative mutation observable without exposing internals
 * (SQL text, filesystem paths, stack traces) to the client.
 */
function rethrowSafe(error: unknown, messageKey: DictionaryKey): never {
  if (error instanceof AppError) throw error;
  console.error("[admin]", error instanceof Error ? error.message : error);
  throw new AppError(serverTranslate(messageKey), 500);
}

/** Turns a violated database invariant inside a transaction into a safe 500. */
function failInvariant(reason: string, messageKey: DictionaryKey): never {
  console.error("[admin] invariant:", reason);
  throw new AppError(serverTranslate(messageKey), 500);
}

/** Ids are de-duplicated and trimmed before they ever reach a link table. */
function normalizeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** Rejects unknown trainer ids BEFORE any link row is touched. */
function assertTrainersExist(writer: DbHandle, trainerIds: readonly string[]): void {
  if (trainerIds.length === 0) return;
  const known = new Set(writer.select({ id: trainers.id }).from(trainers).all().map((row) => row.id));
  const missing = trainerIds.find((id) => !known.has(id));
  if (missing) throw new AppError(serverTranslate("api.unknownTrainerId", { id: missing }), 422);
}

/** Every trainer/class-type link row must resolve on both sides (no orphans). */
function assertLinksResolve(writer: DbHandle, messageKey: DictionaryKey): void {
  const trainerIds = new Set(writer.select({ id: trainers.id }).from(trainers).all().map((row) => row.id));
  const classTypeIds = new Set(writer.select({ id: classTypes.id }).from(classTypes).all().map((row) => row.id));
  const orphan = writer
    .select()
    .from(trainerClassTypes)
    .all()
    .find((link) => !trainerIds.has(link.trainerId) || !classTypeIds.has(link.classTypeId));
  if (orphan) {
    failInvariant(
      `link «${orphan.trainerId}» → «${orphan.classTypeId}» does not resolve`,
      messageKey,
    );
  }
}

/**
 * `{ trainer, classTypeIds }` — one trainer save that may update several class
 * links at once. The plain trainer payload stays supported (single upsert,
 * used by reordering-free callers and by tests).
 */
const trainerWithLinksSchema = z.object({
  trainer: trainerPayloadSchema,
  classTypeIds: z.array(z.string().min(1)).max(500),
});

const trainerMutationSchema = z.union([trainerWithLinksSchema, trainerPayloadSchema]);

export async function upsertTrainer(raw: unknown): Promise<Trainer> {
  const parsed = trainerMutationSchema.parse(raw);
  if ("trainer" in parsed) return saveTrainerWithClassLinks(parsed.trainer, parsed.classTypeIds);
  return saveTrainerRow(parsed);
}

/** Single-statement trainer upsert (already atomic on its own). */
function saveTrainerRow(payload: Trainer): Trainer {
  const now = new Date();
  getDb()
    .insert(trainers)
    .values({
      id: payload.id,
      name: payload.name,
      color: payload.color,
      initials: payload.initials ?? null,
      notes: payload.notes ?? null,
      active: payload.active,
      sortOrder: payload.sortOrder,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: trainers.id,
      set: {
        name: payload.name,
        color: payload.color,
        initials: payload.initials ?? null,
        notes: payload.notes ?? null,
        active: payload.active,
        sortOrder: payload.sortOrder,
        updatedAt: now,
      },
    })
    .run();
  return payload;
}

/**
 * Atomic trainer save that also reconciles this trainer's eligibility links.
 *
 * The trainer form submits the class types the trainer should be eligible for;
 * the server replaces exactly THIS trainer's link rows (links of every other
 * trainer stay untouched) inside one transaction together with the trainer
 * metadata — a trainer save that affects several class links therefore either
 * fully succeeds or fully rolls back. Unknown class-type ids reject the save
 * before anything is written.
 */
function saveTrainerWithClassLinks(payload: Trainer, rawClassTypeIds: readonly string[]): Trainer {
  const classTypeIds = normalizeIds(rawClassTypeIds);
  const now = new Date();
  try {
    getDb().transaction((tx) => {
      const knownClassTypes = new Set(tx.select({ id: classTypes.id }).from(classTypes).all().map((row) => row.id));
      const unknown = classTypeIds.find((id) => !knownClassTypes.has(id));
      if (unknown) throw new AppError(serverTranslate("api.unknownClassTypeId", { id: unknown }), 422);

      tx.insert(trainers)
        .values({
          id: payload.id,
          name: payload.name,
          color: payload.color,
          initials: payload.initials ?? null,
          notes: payload.notes ?? null,
          active: payload.active,
          sortOrder: payload.sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: trainers.id,
          set: {
            name: payload.name,
            color: payload.color,
            initials: payload.initials ?? null,
            notes: payload.notes ?? null,
            active: payload.active,
            sortOrder: payload.sortOrder,
            updatedAt: now,
          },
        })
        .run();

      const currentLinks = tx
        .select()
        .from(trainerClassTypes)
        .where(eq(trainerClassTypes.trainerId, payload.id))
        .all();
      const wanted = new Set(classTypeIds);
      for (const link of currentLinks) {
        if (wanted.has(link.classTypeId)) continue;
        // Scoped to THIS trainer: other trainers' links to the same class type
        // are never touched.
        tx.delete(trainerClassTypes)
          .where(
            and(
              eq(trainerClassTypes.trainerId, payload.id),
              eq(trainerClassTypes.classTypeId, link.classTypeId),
            ),
          )
          .run();
      }
      const currentClassTypeIds = new Set(currentLinks.map((link) => link.classTypeId));
      const added = classTypeIds.filter((classTypeId) => !currentClassTypeIds.has(classTypeId));
      if (added.length > 0) {
        tx.insert(trainerClassTypes)
          .values(added.map((classTypeId) => ({ trainerId: payload.id, classTypeId })))
          .run();
      }
      assertLinksResolve(tx, "api.trainerSaveFailed");
    });
  } catch (error) {
    rethrowSafe(error, "api.trainerSaveFailed");
  }
  return payload;
}

/**
 * Legacy projects use the same explicit cascade policy as hall projects:
 * remove current events, links and the trainer atomically after a safety copy.
 */
export function deleteTrainer(id: string): { deactivated: boolean } {
  const db = getDb();
  requireSafetyBackup(`delete-trainer:${id}`);
  try {
    db.transaction((tx) => {
      tx.delete(scheduleEvents).where(eq(scheduleEvents.trainerId, id)).run();
      tx.delete(trainerClassTypes).where(eq(trainerClassTypes.trainerId, id)).run();
      tx.delete(trainers).where(eq(trainers.id, id)).run();
      assertLinksResolve(tx, "api.trainerDeleteFailed");
    });
  } catch (error) {
    rethrowSafe(error, "api.trainerDeleteFailed");
  }
  return { deactivated: false };
}

/**
 * Atomic class-type update: metadata AND its trainer eligibility links are one
 * operation. Supplied trainer ids are validated first (unknown ids reject the
 * save before anything is written) and the desired set is written wholesale, so
 * a class type can never end up with half-updated eligibility.
 *
 * `trainerIds: []` keeps its long-standing meaning: an UNRESTRICTED class type
 * that any trainer may teach (no link rows = no eligibility restriction).
 */
export async function upsertClassType(raw: unknown): Promise<ClassType> {
  const payload = classTypePayloadSchema.parse(raw);
  const now = new Date();
  const trainerIds = normalizeIds(payload.trainerIds);
  try {
    getDb().transaction((tx) => {
      assertTrainersExist(tx, trainerIds);
      tx.insert(classTypes)
        .values({
          id: payload.id,
          name: payload.name,
          shortName: payload.shortName,
          defaultDuration: payload.defaultDuration,
          color: payload.color ?? null,
          description: payload.description ?? null,
          active: payload.active,
          sortOrder: payload.sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: classTypes.id,
          set: {
            name: payload.name,
            shortName: payload.shortName,
            defaultDuration: payload.defaultDuration,
            color: payload.color ?? null,
            description: payload.description ?? null,
            active: payload.active,
            sortOrder: payload.sortOrder,
            updatedAt: now,
          },
        })
        .run();

      tx.delete(trainerClassTypes).where(eq(trainerClassTypes.classTypeId, payload.id)).run();
      if (trainerIds.length > 0) {
        tx.insert(trainerClassTypes)
          .values(trainerIds.map((trainerId) => ({ trainerId, classTypeId: payload.id })))
          .run();
      }
      assertLinksResolve(tx, "api.classTypeSaveFailed");
    });
  } catch (error) {
    rethrowSafe(error, "api.classTypeSaveFailed");
  }
  return { ...payload, trainerIds };
}

/**
 * Explicit legacy cascade: events, links and class type are one transaction.
 */
export function deleteClassType(id: string): { deactivated: boolean } {
  const db = getDb();
  requireSafetyBackup(`delete-class-type:${id}`);
  try {
    db.transaction((tx) => {
      tx.delete(scheduleEvents).where(eq(scheduleEvents.classTypeId, id)).run();
      tx.delete(trainerClassTypes).where(eq(trainerClassTypes.classTypeId, id)).run();
      tx.delete(classTypes).where(eq(classTypes.id, id)).run();
      assertLinksResolve(tx, "api.classTypeDeleteFailed");
    });
  } catch (error) {
    rethrowSafe(error, "api.classTypeDeleteFailed");
  }
  return { deactivated: false };
}

/** Audit result: a room upsert is a single statement — already atomic. */
export async function upsertRoom(raw: unknown): Promise<Room> {
  const payload = roomPayloadSchema.parse(raw);
  getDb()
    .insert(rooms)
    .values(payload)
    .onConflictDoUpdate({
      target: rooms.id,
      set: { name: payload.name, active: payload.active, sortOrder: payload.sortOrder },
    })
    .run();
  return payload;
}

/** Audit result: a single statement per branch — already atomic. */
export function deleteRoom(id: string): { deactivated: boolean } {
  const db = getDb();
  const rows = db
    .select({ value: sql<number>`count(*)` })
    .from(scheduleEvents)
    .where(eq(scheduleEvents.roomId, id))
    .all();
  if ((rows[0]?.value ?? 0) > 0) {
    db.update(rooms).set({ active: false }).where(eq(rooms.id, id)).run();
    return { deactivated: true };
  }
  db.delete(rooms).where(eq(rooms.id, id)).run();
  return { deactivated: false };
}

const reorderSchema = z.object({
  entity: z.enum(["trainers", "classTypes"]),
  /** The COMPLETE ordered id list of the entity (see `reorderEntities`). */
  order: z.array(z.string().min(1)).min(1).max(500),
});

export interface ReorderResult {
  entity: "trainers" | "classTypes";
  order: string[];
}

/**
 * Atomic batch reorder for trainers / class types.
 *
 * One reorder = one request = one transaction. The submitted list must be the
 * COMPLETE id set of that entity: unknown ids, duplicates and stale lists (a
 * row was added or removed meanwhile) reject BEFORE any write, so unrelated
 * rows can never be reordered and the resulting order is deterministic
 * (dense 0..n-1 in exactly the submitted sequence).
 */
export function reorderEntities(raw: unknown): ReorderResult {
  const payload = reorderSchema.parse(raw);
  const now = new Date();
  try {
    getDb().transaction((tx) => {
      if (payload.entity === "trainers") {
        const rows = tx.select({ id: trainers.id }).from(trainers).all();
        validateOrder(payload.order, rows.map((row) => row.id));
        payload.order.forEach((id, index) => {
          tx.update(trainers)
            .set({ sortOrder: index, updatedAt: now })
            .where(eq(trainers.id, id))
            .run();
        });
      } else {
        const rows = tx.select({ id: classTypes.id }).from(classTypes).all();
        validateOrder(payload.order, rows.map((row) => row.id));
        payload.order.forEach((id, index) => {
          tx.update(classTypes)
            .set({ sortOrder: index, updatedAt: now })
            .where(eq(classTypes.id, id))
            .run();
        });
      }
    });
  } catch (error) {
    rethrowSafe(error, "api.reorderFailed");
  }
  return { entity: payload.entity, order: payload.order };
}

/** Rejects unknown, duplicated or incomplete order lists before any write. */
function validateOrder(order: readonly string[], existingIds: readonly string[]): void {
  const existing = new Set(existingIds);
  const seen = new Set<string>();
  for (const id of order) {
    if (!existing.has(id)) throw new AppError(serverTranslate("api.reorderUnknownId", { id }), 422);
    if (seen.has(id)) throw new AppError(serverTranslate("api.reorderDuplicateId", { id }), 422);
    seen.add(id);
  }
  if (seen.size !== existing.size) throw new AppError(serverTranslate("api.reorderIncomplete"), 409);
}

/**
 * Schedule actions (create / duplicate / rename / archive / unarchive /
 * activate / delete).
 *
 * The parsed payload is handed to the action itself; this wrapper is the single
 * funnel that guarantees a failure can only ever surface as a localized
 * AppError — never as a raw SQLite message, filesystem path or stack trace.
 * `delete` gets its own wording because it is the destructive one.
 */
export async function scheduleAction(raw: unknown): Promise<{ activeScheduleId: string | null }> {
  const payload = scheduleActionSchema.parse(raw);
  try {
    return await runScheduleAction(payload);
  } catch (error) {
    rethrowSafe(error, payload.action === "delete" ? "api.scheduleDeleteFailed" : "api.scheduleActionFailed");
  }
}

async function runScheduleAction(
  payload: z.infer<typeof scheduleActionSchema>,
): Promise<{ activeScheduleId: string | null }> {
  const db = getDb();
  const now = new Date();

  if (payload.action === "create") {
    const id = crypto.randomUUID();
    const name = payload.name?.trim() || "Новий розклад";
    db.transaction((tx) => {
      tx.update(schedules).set({ isActive: false }).where(eq(schedules.isActive, true)).run();
      tx.insert(schedules)
        .values({ id, name, status: "draft", isActive: true, isArchived: false, createdAt: now, updatedAt: now })
        .run();
      tx.insert(scheduleSettings).values({ scheduleId: id, ...DEFAULT_SETTINGS, updatedAt: now }).run();
      assertActiveScheduleInvariant(tx.select().from(schedules).all(), (reason) =>
        failInvariant(reason, "api.scheduleActionFailed"),
      );
      // The checkpoint belongs to the creation: a schedule never appears
      // without its history entry (same transaction as the schedule itself).
      createVersion({ scheduleId: id, source: "manual", description: "Розклад створено" }, tx);
    });
    return { activeScheduleId: id };
  }

  if (payload.action === "duplicate") {
    const sourceId = payload.sourceId ?? payload.id;
    if (!sourceId) throw new AppError("Немає чого дублювати.");
    const snapshot = buildSnapshot(sourceId);
    const row = db.select().from(schedules).where(eq(schedules.id, sourceId)).limit(1).all()[0];
    if (!row) throw new AppError("Такого розкладу більше немає.", 404);

    const newId = crypto.randomUUID();
    const name = payload.name?.trim() || `${row.name} (копія)`;
    const events = snapshot.events.map((event) => ({ ...event, id: crypto.randomUUID(), scheduleId: newId }));

    db.transaction((tx) => {
      tx.update(schedules).set({ isActive: false }).where(eq(schedules.isActive, true)).run();
      tx.insert(schedules)
        .values({ id: newId, name, status: "draft", isActive: true, isArchived: false, createdAt: now, updatedAt: now })
        .run();
      tx.insert(scheduleSettings)
        .values({ scheduleId: newId, ...snapshot.settings, scheduleTitle: snapshot.settings.scheduleTitle, updatedAt: now })
        .run();
      if (events.length > 0) {
        tx.insert(scheduleEvents)
          .values(
            events.map((event) => ({
              ...event,
              roomId: event.roomId ?? null,
              notes: event.notes ?? null,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .run();
      }
      assertActiveScheduleInvariant(tx.select().from(schedules).all(), (reason) =>
        failInvariant(reason, "api.scheduleActionFailed"),
      );
      createVersion({ scheduleId: newId, source: "manual", description: `Дубльовано з «${row.name}»` }, tx);
    });

    return { activeScheduleId: newId };
  }

  const id = payload.id;
  if (!id) throw new AppError("Не вказано розклад.");

  switch (payload.action) {
    case "rename": {
      const name = payload.name?.trim();
      if (!name) throw new AppError("Вкажіть назву розкладу.");
      // The rename and its history entry are one transaction: a schedule can
      // never be renamed without the matching version record.
      try {
        db.transaction((tx) => {
          assertScheduleExists(tx, id);
          tx.update(schedules).set({ name, updatedAt: now }).where(eq(schedules.id, id)).run();
          createVersion({ scheduleId: id, source: "manual", description: `Перейменовано на «${name}»` }, tx);
        });
      } catch (error) {
        rethrowSafe(error, "api.scheduleActionFailed");
      }
      return { activeScheduleId: id };
    }
    case "archive":
      return archiveScheduleAtomically(id, now);
    case "unarchive":
      return unarchiveScheduleAtomically(id, now);
    case "activate": {
      try {
        db.transaction((tx) => {
          assertScheduleExists(tx, id);
          const target = tx.select().from(schedules).where(eq(schedules.id, id)).limit(1).all()[0];
          if (target?.isArchived) {
            // Archived schedules stay viewable from the selector, but they never
            // become the active one (active + archived is a forbidden state):
            // the existing active selection is kept and only repaired if the
            // workspace has none.
            settleActiveSchedule(tx);
          } else {
            tx.update(schedules).set({ isActive: false }).where(eq(schedules.isActive, true)).run();
            tx.update(schedules).set({ isActive: true, updatedAt: now }).where(eq(schedules.id, id)).run();
          }
          assertActiveScheduleInvariant(tx.select().from(schedules).all(), (reason) =>
            failInvariant(reason, "api.scheduleActionFailed"),
          );
        });
      } catch (error) {
        rethrowSafe(error, "api.scheduleActionFailed");
      }
      return { activeScheduleId: id };
    }
    case "delete":
      return deleteScheduleAtomically(id);
    default:
      throw new AppError("Непідтримувана дія з розкладом.");
  }
}

function assertScheduleExists(writer: DbHandle, id: string): void {
  const rows = writer.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, id)).limit(1).all();
  if (rows.length === 0) throw new AppError(serverTranslate("api.scheduleMissing"), 404);
}

/**
 * Resulting-active-schedule settlement, shared by delete/archive/unarchive.
 *
 * Product rule (now enforced as an invariant instead of relying on statement
 * order): an archived schedule is never active, at most one schedule is active,
 * and as long as any non-archived schedule exists exactly one of them is
 * active. The fallback is the most recently updated non-archived schedule — the
 * same row `loadWorkspace` would open — with the id as a deterministic
 * tie-breaker. Returns the id the caller should show next.
 */
function settleActiveSchedule(writer: DbHandle): string | null {
  const rows = writer.select().from(schedules).all();
  const candidates = rows.filter((row) => !row.isArchived);
  const keep =
    candidates.find((row) => row.isActive) ??
    [...candidates].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id),
    )[0];

  for (const row of rows) {
    if (row.isActive && row.id !== keep?.id) {
      writer.update(schedules).set({ isActive: false }).where(eq(schedules.id, row.id)).run();
    }
  }
  if (keep && !keep.isActive) {
    writer.update(schedules).set({ isActive: true }).where(eq(schedules.id, keep.id)).run();
  }
  return keep?.id ?? null;
}

/** Post-condition: nothing of the deleted schedule may remain behind. */
function assertScheduleRowsGone(writer: DbHandle, id: string): void {
  const leftovers =
    writer.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, id)).all().length +
    writer
      .select({ id: scheduleSettings.scheduleId })
      .from(scheduleSettings)
      .where(eq(scheduleSettings.scheduleId, id))
      .all().length +
    writer.select({ id: scheduleEvents.id }).from(scheduleEvents).where(eq(scheduleEvents.scheduleId, id)).all()
      .length +
    writer
      .select({ id: scheduleVersions.id })
      .from(scheduleVersions)
      .where(eq(scheduleVersions.scheduleId, id))
      .all().length;
  if (leftovers > 0) {
    failInvariant(`schedule «${id}» left ${leftovers} row(s) behind`, "api.scheduleDeleteFailed");
  }
}

/**
 * Atomic schedule deletion.
 *
 * Target validation, the removal of every schedule-scoped row (settings,
 * events, versions, schedule), the fallback selection, the resulting
 * active-schedule invariant and a "nothing left behind" check are ONE
 * transaction: any failure rolls the whole deletion back, so no partially
 * deleted schedule can survive.
 *
 * Destructive-operation policy: the safety backup is part of this operation's
 * protection, so a backup that cannot be written cancels the deletion (the
 * operator is told to retry instead of losing the schedule silently).
 */
function deleteScheduleAtomically(id: string): { activeScheduleId: string | null } {
  const db = getDb();
  // Cheap refusals first — a rejected deletion must not even write a safety copy.
  assertScheduleExists(db, id);
  const scheduleCount = db.select({ id: schedules.id }).from(schedules).all().length;
  if (scheduleCount <= 1) throw new AppError(serverTranslate("api.onlySchedule"));
  requireSafetyBackup(`delete-schedule:${id}`);

  let activeScheduleId: string | null = null;
  try {
    db.transaction((tx) => {
      assertScheduleExists(tx, id);
      tx.delete(scheduleSettings).where(eq(scheduleSettings.scheduleId, id)).run();
      tx.delete(scheduleEvents).where(eq(scheduleEvents.scheduleId, id)).run();
      tx.delete(scheduleVersions).where(eq(scheduleVersions.scheduleId, id)).run();
      tx.delete(schedules).where(eq(schedules.id, id)).run();
      assertScheduleRowsGone(tx, id);
      activeScheduleId = settleActiveSchedule(tx);
      assertActiveScheduleInvariant(tx.select().from(schedules).all(), (reason) =>
        failInvariant(reason, "api.scheduleDeleteFailed"),
      );
    });
  } catch (error) {
    rethrowSafe(error, "api.scheduleDeleteFailed");
  }
  return { activeScheduleId };
}

/** Archive is the same settlement problem as delete, in one transaction. */
function archiveScheduleAtomically(id: string, now: Date): { activeScheduleId: string | null } {
  const db = getDb();
  let activeScheduleId: string | null = null;
  try {
    db.transaction((tx) => {
      assertScheduleExists(tx, id);
      tx.update(schedules)
        .set({ isArchived: true, isActive: false, updatedAt: now })
        .where(eq(schedules.id, id))
        .run();
      activeScheduleId = settleActiveSchedule(tx);
      assertActiveScheduleInvariant(tx.select().from(schedules).all(), (reason) =>
        failInvariant(reason, "api.scheduleActionFailed"),
      );
    });
  } catch (error) {
    rethrowSafe(error, "api.scheduleActionFailed");
  }
  return { activeScheduleId };
}

/**
 * Unarchiving only repairs the active selection when the workspace has none;
 * an already active schedule stays active, and the UI keeps opening the
 * schedule the operator just restored.
 */
function unarchiveScheduleAtomically(id: string, now: Date): { activeScheduleId: string | null } {
  const db = getDb();
  try {
    db.transaction((tx) => {
      assertScheduleExists(tx, id);
      tx.update(schedules).set({ isArchived: false, updatedAt: now }).where(eq(schedules.id, id)).run();
      settleActiveSchedule(tx);
      assertActiveScheduleInvariant(tx.select().from(schedules).all(), (reason) =>
        failInvariant(reason, "api.scheduleActionFailed"),
      );
    });
  } catch (error) {
    rethrowSafe(error, "api.scheduleActionFailed");
  }
  return { activeScheduleId: id };
}

export interface ImportResult {
  schedules: number;
  events: number;
  mode: string;
  safetyBackup: string | null;
}

/**
 * Atomic backup import.
 *
 * Flow:
 *   1. parse + full graph preflight (app id, schema version, timestamps,
 *      duplicate ids, active invariant, references, settings completeness,
 *      recursive snapshot validation, schedule states) — BEFORE anything is
 *      written; any failure leaves the database untouched;
 *   2. write a rotating safety backup of the current data to ./data/backups —
 *      BACKUP-GATED: an import replaces existing data, so a safety copy that
 *      cannot be written cancels the import and returns a localized error
 *      instead of silently proceeding without a safety net;
 *   3. apply imported data inside ONE SQLite transaction (replace or merge);
 *   4. verify the RESULTING graph inside the same transaction;
 *   5. commit (or roll back automatically on any throw).
 *
 * MERGE semantics (UI: “Import and keep current data”) — explicit:
 *   - workspace-level entities (trainers, class types, rooms) are upserted;
 *     a class type's trainer links are replaced wholesale with the backup's;
 *   - every schedule INCLUDED in the backup is replaced as a COMPLETE unit:
 *     its events are deleted and re-created from the backup (possibly zero —
 *     an empty schedule is legitimate), its settings row is overwritten, its
 *     name/status/archived flag are taken from the backup;
 *   - schedules ABSENT from the backup (with their events, settings and
 *     versions) remain byte-identical — never deleted, never deactivated;
 *   - imported versions are inserted unless their id already exists;
 *   - the workspace active selection is preserved: existing schedules keep
 *     their active flag (except a schedule the backup archives, which is
 *     deactivated like the normal Archive action does), new schedules are
 *     inserted inactive; only if the workspace would end up with NO active
 *     schedule does the backup's designated schedule (else the first
 *     non-archived schedule) become active;
 *   - an included schedule WITHOUT a settings row in the backup is an
 *     incomplete payload and rejects the whole import — current
 *     events/settings are never silently erased or reset to defaults.
 *
 * REPLACE semantics (UI: “Wipe and replace”) — explicit:
 *   - the database is wiped and rebuilt EXACTLY from the backup graph;
 *   - the backup's active schedule stays active; a backup with no active
 *     schedule activates its first non-archived schedule (none if
 *     all are archived);
 *   - any failure rolls back to the pre-import database.
 */
export function importBackup(raw: unknown, mode: "merge" | "replace" = "merge"): ImportResult {
  const backup = parseBackupPayload(raw);
  const db = getDb();

  // Merge-only preflight context (read-only): version ids already stored plus
  // event ids owned by schedules the backup does not include.
  const ctx = emptyPreflightContext();
  if (mode === "merge") {
    const included = new Set(backup.schedules.map((schedule) => schedule.id));
    for (const row of db.select({ id: scheduleVersions.id }).from(scheduleVersions).all()) {
      ctx.dbVersionIds.add(row.id);
    }
    for (const row of db.select({ id: scheduleEvents.id, scheduleId: scheduleEvents.scheduleId }).from(scheduleEvents).all()) {
      if (!included.has(row.scheduleId)) ctx.protectedEventIds.add(row.id);
    }
  }
  validateBackupPreflight(backup, mode, ctx);

  const safetyBackup = requireSafetyBackup(`import:${mode}`);
  const now = new Date();
  const importedScheduleIds = new Set(backup.schedules.map((schedule) => schedule.id));
  const designatedActiveId = backup.schedules.find((schedule) => schedule.isActive)?.id ?? null;

  try {
    db.transaction((tx) => {
      if (mode === "replace") {
        tx.delete(scheduleVersions).run();
        tx.delete(scheduleEvents).run();
        tx.delete(scheduleSettings).run();
        tx.delete(schedules).run();
        tx.delete(trainerClassTypes).run();
        tx.delete(trainers).run();
        tx.delete(classTypes).run();
        tx.delete(rooms).run();
      }

      // Merge reads the pre-import active flags once so existing schedules can
      // keep the workspace selection (see the merge policy above).
      const preImportActive =
        mode === "merge"
          ? new Map(
              tx
                .select({ id: schedules.id, isActive: schedules.isActive })
                .from(schedules)
                .all()
                .map((row) => [row.id, row.isActive] as const),
            )
          : null;

      for (const trainer of backup.trainers) {
        if (mode === "replace") {
          tx.insert(trainers)
            .values({
              id: trainer.id,
              name: trainer.name,
              color: trainer.color,
              initials: trainer.initials ?? null,
              notes: trainer.notes ?? null,
              active: trainer.active,
              sortOrder: trainer.sortOrder,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        } else {
          tx.insert(trainers)
            .values({
              id: trainer.id,
              name: trainer.name,
              color: trainer.color,
              initials: trainer.initials ?? null,
              notes: trainer.notes ?? null,
              active: trainer.active,
              sortOrder: trainer.sortOrder,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: trainers.id,
              set: {
                name: trainer.name,
                color: trainer.color,
                initials: trainer.initials ?? null,
                notes: trainer.notes ?? null,
                active: trainer.active,
                sortOrder: trainer.sortOrder,
                updatedAt: now,
              },
            })
            .run();
        }
      }

      for (const classType of backup.classTypes) {
        tx.insert(classTypes)
          .values({
            id: classType.id,
            name: classType.name,
            shortName: classType.shortName,
            defaultDuration: classType.defaultDuration,
            color: classType.color ?? null,
            description: classType.description ?? null,
            active: classType.active,
            sortOrder: classType.sortOrder,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: classTypes.id,
            set: {
              name: classType.name,
              shortName: classType.shortName,
              defaultDuration: classType.defaultDuration,
              color: classType.color ?? null,
              description: classType.description ?? null,
              active: classType.active,
              sortOrder: classType.sortOrder,
              updatedAt: now,
            },
          })
          .run();
        tx.delete(trainerClassTypes).where(eq(trainerClassTypes.classTypeId, classType.id)).run();
        if (classType.trainerIds.length > 0) {
          tx.insert(trainerClassTypes)
            .values(classType.trainerIds.map((trainerId) => ({ trainerId, classTypeId: classType.id })))
            .run();
        }
      }

      for (const room of backup.rooms) {
        tx.insert(rooms)
          .values(room)
          .onConflictDoUpdate({
            target: rooms.id,
            set: { name: room.name, active: room.active, sortOrder: room.sortOrder },
          })
          .run();
      }

      for (const schedule of backup.schedules) {
        // Active flag per the explicit per-mode policy (preflight guarantees
        // the backup itself holds at most one active, never archived):
        //   - replace: the backup value applies directly;
        //   - merge: existing schedules keep the workspace selection, except a
        //     schedule the backup archives is deactivated (same as Archive);
        //     brand-new schedules are inserted inactive.
        const mergedIsActive =
          mode === "replace"
            ? schedule.isActive
            : preImportActive?.get(schedule.id) === true && !schedule.isArchived;
        tx.insert(schedules)
          .values({
            id: schedule.id,
            name: schedule.name,
            status: schedule.status,
            isActive: mergedIsActive,
            isArchived: schedule.isArchived,
            publishedAt: schedule.publishedAt ? new Date(schedule.publishedAt) : null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schedules.id,
            set: {
              name: schedule.name,
              status: schedule.status,
              isActive: mergedIsActive,
              isArchived: schedule.isArchived,
              updatedAt: now,
            },
          })
          .run();

        const scheduleEventsForSchedule = backup.events.filter((event) => event.scheduleId === schedule.id);
        tx.delete(scheduleEvents).where(eq(scheduleEvents.scheduleId, schedule.id)).run();
        if (scheduleEventsForSchedule.length > 0) {
          tx.insert(scheduleEvents)
            .values(
              scheduleEventsForSchedule.map((event) => ({
                id: event.id,
                scheduleId: schedule.id,
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

        const settings = backup.settings.find((item) => item.scheduleId === schedule.id);
        if (!settings) {
          // Unreachable: preflight guarantees one settings row per included
          // schedule. An incomplete payload must reject, never silently fall
          // back to defaults and erase current state.
          throw new AppError(`${IMPORT_FAILED_MESSAGE} Налаштування посилаються на відсутній розклад.`, 422);
        }
        const { scheduleId: _settingsScheduleId, ...rest } = settings;
        tx.insert(scheduleSettings)
          .values({ scheduleId: schedule.id, ...rest, updatedAt: now })
          .onConflictDoUpdate({ target: scheduleSettings.scheduleId, set: { ...rest, updatedAt: now } })
          .run();
      }

      const existingVersionIds = new Set(
        tx.select({ id: scheduleVersions.id }).from(scheduleVersions).all().map((row) => row.id),
      );
      const insertedVersions = backup.versions.filter((version) => !existingVersionIds.has(version.id));
      // A restored checkpoint may point at a version that appears later in the
      // portable array. Insert every row first, then restore those optional
      // links once every target id exists; this preserves valid backup ordering
      // under the real immediate SQLite FK instead of weakening that FK.
      for (const version of insertedVersions) {
        tx.insert(scheduleVersions)
          .values({
            id: version.id,
            scheduleId: version.scheduleId,
            createdAt: new Date(version.createdAt),
            source: version.source,
            description: version.description,
            snapshot: version.snapshot as SnapshotContent,
            restoredFromVersionId: null,
          })
          .run();
      }
      for (const version of insertedVersions) {
        if (!version.restoredFromVersionId) continue;
        tx.update(scheduleVersions)
          .set({ restoredFromVersionId: version.restoredFromVersionId })
          .where(eq(scheduleVersions.id, version.id))
          .run();
      }

      // Explicit zero-active normalization (a backup with several active
      // schedules was already rejected in preflight — never normalized).
      if (mode === "replace") {
        if (!backup.schedules.some((schedule) => schedule.isActive)) {
          const fallback = backup.schedules.find((schedule) => !schedule.isArchived);
          if (fallback) tx.update(schedules).set({ isActive: true }).where(eq(schedules.id, fallback.id)).run();
        }
      } else {
        const rows = tx.select().from(schedules).all();
        const hasActive = rows.some((row) => row.isActive);
        if (!hasActive && rows.some((row) => !row.isArchived)) {
          const designated =
            designatedActiveId != null && rows.some((row) => row.id === designatedActiveId && !row.isArchived)
              ? designatedActiveId
              : rows.find((row) => !row.isArchived)?.id;
          if (designated) {
            tx.update(schedules).set({ isActive: true }).where(eq(schedules.id, designated)).run();
          }
        }
      }

      // Final graph verification inside the transaction: a broken reference,
      // an ambiguous active schedule or an invalid imported state here throws
      // and rolls the whole import back.
      verifyFinalGraph(
        {
          schedules: tx.select().from(schedules).all(),
          trainers: tx.select().from(trainers).all(),
          classTypes: tx.select().from(classTypes).all(),
          rooms: tx.select().from(rooms).all(),
          events: tx.select().from(scheduleEvents).all(),
          settings: tx.select().from(scheduleSettings).all(),
          versions: tx.select().from(scheduleVersions).all(),
          links: tx.select().from(trainerClassTypes).all(),
        },
        importedScheduleIds,
      );
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(IMPORT_FAILED_MESSAGE, 422);
  }

  return {
    schedules: backup.schedules.length,
    events: backup.events.length,
    mode,
    safetyBackup,
  };
}

export { exportBackup };
export type { BackupPayload };
export { mapSchedule };
