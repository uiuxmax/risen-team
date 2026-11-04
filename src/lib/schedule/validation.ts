import {
  type ClassType,
  type Conflict,
  type Room,
  type ScheduleEvent,
  type ScheduleSettings,
  type Trainer,
} from "@/lib/domain/types";
import { MIN_PRECISION, intervalsOverlap, timeToMinutes } from "@/lib/schedule/time";
import { englishTranslator, type Translator } from "@/lib/i18n";

/**
 * Shared schedule-state validation boundary.
 *
 * Every persistence path funnels the SAME rules through `validateScheduleState`
 * before anything is written: the Add/Edit dialog, the normal API save,
 * backup import and version restore alike. Results distinguish structural
 * ERRORS (reject the operation) from product WARNINGS (inform only).
 *
 * Structural errors:
 *   - malformed or reversed schedule window (startTime >= endTime);
 *   - malformed event times, reversed event ranges;
 *   - events outside the configured schedule window;
 *   - times that break the 5-minute practical precision rule;
 *   - broken required references (trainer, class type, room).
 *
 * Product warnings (never block):
 *   - trainer/class eligibility mismatches;
 *   - trainer clashes, room clashes, duplicate classes.
 */

export interface ScheduleStateInput {
  settings: Pick<ScheduleSettings, "startTime" | "endTime">;
  events: ScheduleEvent[];
  trainers: Trainer[];
  classTypes: ClassType[];
  rooms: Room[];
}

/** @deprecated Use ScheduleStateInput — kept as the historical name. */
export type ValidationInput = ScheduleStateInput;

export interface ScheduleStateValidation {
  conflicts: Conflict[];
  errors: Conflict[];
  warnings: Conflict[];
  valid: boolean;
}

/**
 * Validates a complete schedule state. The returned `errors` list is the
 * structural boundary: any non-empty result must reject the operation and
 * leave the database untouched.
 */
export function validateScheduleState(
  input: ScheduleStateInput,
  translate: Translator = englishTranslator,
): ScheduleStateValidation {
  const conflicts = collectScheduleStateConflicts(input, translate);
  const errors = conflicts.filter((conflict) => conflict.severity === "error");
  const warnings = conflicts.filter((conflict) => conflict.severity === "warning");
  return { conflicts, errors, warnings, valid: errors.length === 0 };
}

/** Conflict-list view over the same shared engine. */
export function validateSchedule(input: ScheduleStateInput, translate: Translator = englishTranslator): Conflict[] {
  return validateScheduleState(input, translate).conflicts;
}

function collectScheduleStateConflicts(input: ScheduleStateInput, translate: Translator): Conflict[] {
  const conflicts: Conflict[] = [];
  const trainerIds = new Set(input.trainers.map((trainer) => trainer.id));
  const classTypeIds = new Set(input.classTypes.map((classType) => classType.id));
  const roomIds = new Set(input.rooms.map((room) => room.id));
  const trainerName = (id: string) => input.trainers.find((trainer) => trainer.id === id)?.name ?? "—";
  const roomName = (id: string | null | undefined) =>
    input.rooms.find((room) => room.id === id)?.name ?? "—";
  const dayName = (dayOfWeek: number) => translate(`day.${dayOfWeek}` as "day.0");

  // Schedule window: startTime < endTime. Never silently normalized.
  const windowStart = timeToMinutes(input.settings.startTime);
  const windowEnd = timeToMinutes(input.settings.endTime);
  const windowValid = !Number.isNaN(windowStart) && !Number.isNaN(windowEnd) && windowStart < windowEnd;
  if (!windowValid) {
    conflicts.push({
      id: "invalid-window",
      severity: "error",
      message: translate("conflict.invalidWindow", { start: input.settings.startTime, end: input.settings.endTime }),
      eventIds: [],
    });
  }

  for (const event of input.events) {
    const start = timeToMinutes(event.startTime);
    const end = timeToMinutes(event.endTime);
    const day = dayName(event.dayOfWeek);

    if (Number.isNaN(start) || Number.isNaN(end)) {
      conflicts.push({
        id: `invalid-time-${event.id}`,
        severity: "error",
        message: translate("conflict.invalidTime", { day }),
        eventIds: [event.id],
      });
      continue;
    }
    if (end <= start) {
      conflicts.push({
        id: `range-${event.id}`,
        severity: "error",
        message: translate("conflict.endBeforeStart", { day, start: event.startTime }),
        eventIds: [event.id],
      });
    }
    if (start % MIN_PRECISION !== 0 || end % MIN_PRECISION !== 0) {
      conflicts.push({
        id: `precision-${event.id}`,
        severity: "error",
        message: translate("conflict.impreciseTime", { day, start: event.startTime, end: event.endTime }),
        eventIds: [event.id],
      });
    }
    // Event bounds: the event must sit inside the configured schedule window
    // (boundary-exact). Manual entry is never silently clamped — the caller
    // surfaces these messages instead.
    if (windowValid) {
      if (start < windowStart) {
        conflicts.push({
          id: `before-window-${event.id}`,
          severity: "error",
          message: translate("conflict.eventBeforeStart", { start: input.settings.startTime }),
          eventIds: [event.id],
        });
      }
      if (end > windowEnd) {
        conflicts.push({
          id: `after-window-${event.id}`,
          severity: "error",
          message: translate("conflict.eventAfterEnd", { end: input.settings.endTime }),
          eventIds: [event.id],
        });
      }
    }
    if (!trainerIds.has(event.trainerId)) {
      conflicts.push({
        id: `trainer-${event.id}`,
        severity: "error",
        message: event.trainerId ? translate("conflict.unknownTrainer", { day }) : translate("dialog.errTrainer"),
        eventIds: [event.id],
      });
    }
    if (!classTypeIds.has(event.classTypeId)) {
      conflicts.push({
        id: `class-${event.id}`,
        severity: "error",
        message: event.classTypeId ? translate("conflict.unknownClass", { day }) : translate("dialog.errClass"),
        eventIds: [event.id],
      });
    }
    // A room is optional, but a set reference must resolve — an orphan room id
    // is structural invalidity, never a warning.
    if (event.roomId && !roomIds.has(event.roomId)) {
      conflicts.push({
        id: `room-${event.id}`,
        severity: "error",
        message: translate("conflict.unknownRoom", { day }),
        eventIds: [event.id],
      });
    }
    // Eligibility: a class type can declare which trainers teach it. Dropdowns are
    // filtered, but the relationship is validated here too so imports, restores and
    // quick edits cannot silently create impossible assignments.
    const classType = input.classTypes.find((item) => item.id === event.classTypeId);
    if (classType && classType.trainerIds.length > 0 && !classType.trainerIds.includes(event.trainerId)) {
      conflicts.push({
        id: `eligibility-${event.id}`,
        severity: "warning",
        message: translate("conflict.trainerNotEligible", {
          trainer: trainerName(event.trainerId),
          className: classType.name,
          day,
        }),
        eventIds: [event.id],
      });
    }
  }

  for (let i = 0; i < input.events.length; i += 1) {
    for (let j = i + 1; j < input.events.length; j += 1) {
      const a = input.events[i];
      const b = input.events[j];
      if (a.dayOfWeek !== b.dayOfWeek) continue;
      const aStart = timeToMinutes(a.startTime);
      const aEnd = timeToMinutes(a.endTime);
      const bStart = timeToMinutes(b.startTime);
      const bEnd = timeToMinutes(b.endTime);
      if (Number.isNaN(aStart) || Number.isNaN(bStart)) continue;
      if (!intervalsOverlap({ start: aStart, end: aEnd }, { start: bStart, end: bEnd })) continue;

      const day = dayName(a.dayOfWeek);
      if (a.trainerId === b.trainerId) {
        conflicts.push({
          id: `trainer-clash-${a.id}-${b.id}`,
          severity: "warning",
          message: translate("conflict.trainerClash", {
            trainer: trainerName(a.trainerId),
            day,
            start: a.startTime,
            end: a.endTime,
          }),
          eventIds: [a.id, b.id],
        });
      }
      if (a.roomId && b.roomId && a.roomId === b.roomId) {
        conflicts.push({
          id: `room-clash-${a.id}-${b.id}`,
          severity: "warning",
          message: translate("conflict.roomClash", {
            room: roomName(a.roomId),
            day,
            start: a.startTime,
            end: a.endTime,
          }),
          eventIds: [a.id, b.id],
        });
      }
      if (a.classTypeId === b.classTypeId && a.startTime === b.startTime && a.trainerId === b.trainerId) {
        conflicts.push({
          id: `duplicate-${a.id}-${b.id}`,
          severity: "warning",
          message: translate("conflict.duplicate", { day, start: a.startTime }),
          eventIds: [a.id, b.id],
        });
      }
    }
  }

  return conflicts;
}

export function conflictCounts(conflicts: Conflict[]): { errors: number; warnings: number } {
  return {
    errors: conflicts.filter((conflict) => conflict.severity === "error").length,
    warnings: conflicts.filter((conflict) => conflict.severity === "warning").length,
  };
}

export function conflictsForEvent(conflicts: Conflict[], eventId: string): Conflict[] {
  return conflicts.filter((conflict) => conflict.eventIds.includes(eventId));
}

export function sortEvents(events: ScheduleEvent[]): ScheduleEvent[] {
  return [...events].sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek ||
      timeToMinutes(a.startTime) - timeToMinutes(b.startTime) ||
      a.id.localeCompare(b.id),
  );
}
