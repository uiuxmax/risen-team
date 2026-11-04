import { describe, expect, it } from "vitest";
import { conflictCounts, validateSchedule, validateScheduleState } from "@/lib/schedule/validation";
import { createTranslator } from "@/lib/i18n";
import type { ClassType, Room, ScheduleEvent, Trainer } from "@/lib/domain/types";

const trainers: Trainer[] = [
  { id: "trn-oleh", name: "Oleh", color: "#f59e0b", active: true, sortOrder: 0 },
  { id: "trn-anastasia", name: "Anastasia", color: "#8b5cf6", active: true, sortOrder: 1 },
];
const classTypes: ClassType[] = [
  { id: "cls-boxing", name: "Boxing", shortName: "BOX", defaultDuration: 60, active: true, sortOrder: 0, trainerIds: ["trn-oleh"] },
  { id: "cls-trx", name: "TRX", shortName: "TRX", defaultDuration: 45, active: true, sortOrder: 1, trainerIds: ["trn-anastasia"] },
];
const rooms: Room[] = [{ id: "room-main", name: "Main Hall", active: true, sortOrder: 0 }];
const settings = { startTime: "07:00", endTime: "21:00" };

const event = (overrides: Partial<ScheduleEvent>): ScheduleEvent => ({
  id: "e1",
  scheduleId: "sched",
  dayOfWeek: 0,
  startTime: "16:00",
  endTime: "17:00",
  trainerId: "trn-oleh",
  classTypeId: "cls-boxing",
  roomId: null,
  notes: null,
  ...overrides,
});

describe("conflict detection", () => {
  it("flags an end time before the start time as an error", () => {
    const conflicts = validateSchedule({
      settings,
      events: [event({ endTime: "15:00" })],
      trainers,
      classTypes,
      rooms,
    });
    const counts = conflictCounts(conflicts);
    expect(counts.errors).toBe(1);
    expect(conflicts[0].message).toContain("End time must be later");
  });

  it("warns about a trainer double booking", () => {
    const conflicts = validateSchedule({
      settings,
      events: [event({ id: "a" }), event({ id: "b", classTypeId: "cls-trx" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(conflicts.some((conflict) => conflict.message.includes("Oleh already has another class"))).toBe(true);
    expect(conflicts.every((conflict) => conflict.severity === "warning")).toBe(true);
  });

  it("warns about room double booking", () => {
    const conflicts = validateSchedule({
      settings,
      events: [event({ id: "a", roomId: "room-main" }), event({ id: "b", trainerId: "trn-anastasia", roomId: "room-main" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(conflicts.some((conflict) => conflict.message.includes("Main Hall is already occupied"))).toBe(true);
  });

  it("does not warn for back-to-back classes", () => {
    const conflicts = validateSchedule({
      settings,
      events: [
        event({ id: "a", endTime: "17:00" }),
        event({
          id: "b",
          startTime: "17:00",
          endTime: "18:00",
          classTypeId: "cls-trx",
          trainerId: "trn-anastasia",
        }),
      ],
      trainers,
      classTypes,
      rooms,
    });
    expect(conflicts).toHaveLength(0);
  });

  it("detects duplicates and missing references", () => {
    const conflicts = validateSchedule({
      settings,
      events: [event({ id: "a" }), event({ id: "b" }), event({ id: "c", trainerId: "trn-missing" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(conflicts.some((conflict) => conflict.id.includes("duplicate"))).toBe(true);
    expect(conflicts.some((conflict) => conflict.severity === "error")).toBe(true);
  });

  it("warns when a trainer is not assigned to the class type", () => {
    // TRX is configured for Anastasia only, so Oleh teaching TRX is flagged.
    // Messages follow the requested interface language.
    const conflicts = validateSchedule(
      {
        settings,
      events: [event({ trainerId: "trn-oleh", classTypeId: "cls-trx" })],
        trainers,
        classTypes,
        rooms,
      },
      createTranslator("uk"),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("warning");
    expect(conflicts[0].message).toContain("не закріплений");

    const eligible = validateSchedule({
      settings,
      events: [event({ trainerId: "trn-anastasia", classTypeId: "cls-trx" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(eligible).toHaveLength(0);

    // A class type with no trainer restrictions accepts anyone.
    const unrestricted = validateSchedule({
      settings,
      events: [event({ trainerId: "trn-oleh", classTypeId: "cls-boxing" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(unrestricted).toHaveLength(0);
  });

  it("keeps a valid schedule clean even with 5-minute offsets", () => {
    const conflicts = validateSchedule({
      settings,
      events: [event({ id: "a", startTime: "15:45", endTime: "16:30" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(conflicts).toHaveLength(0);
  });
});

describe("schedule-state structural validation", () => {
  // TEST A — schedule window ordering.
  it("accepts a window that starts before it ends and rejects reversed or empty windows", () => {
    const valid = validateScheduleState({ settings: { startTime: "07:00", endTime: "21:00" }, events: [], trainers, classTypes, rooms });
    expect(valid.valid).toBe(true);
    expect(valid.errors).toHaveLength(0);

    const reversed = validateScheduleState({ settings: { startTime: "21:00", endTime: "07:00" }, events: [], trainers, classTypes, rooms });
    expect(reversed.valid).toBe(false);
    expect(reversed.errors.some((error) => error.id === "invalid-window")).toBe(true);

    const empty = validateScheduleState({ settings: { startTime: "07:00", endTime: "07:00" }, events: [], trainers, classTypes, rooms });
    expect(empty.valid).toBe(false);
    expect(empty.errors.some((error) => error.id === "invalid-window")).toBe(true);
  });

  it("localises the window error in both languages", () => {
    const ukErrors = validateScheduleState(
      { settings: { startTime: "21:00", endTime: "07:00" }, events: [], trainers, classTypes, rooms },
      createTranslator("uk"),
    ).errors;
    expect(ukErrors[0].message).toContain("Розклад має починатися раніше");

    const enErrors = validateScheduleState(
      { settings: { startTime: "21:00", endTime: "07:00" }, events: [], trainers, classTypes, rooms },
    ).errors;
    expect(enErrors[0].message).toContain("must start before it ends");
  });

  // TEST C/D — event bounds (boundary-exact).
  it("rejects events outside the schedule window and accepts exact boundaries", () => {
    const before = validateScheduleState({
      settings,
      events: [event({ id: "a", startTime: "05:00", endTime: "05:30" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(before.valid).toBe(false);
    expect(before.errors.some((error) => error.id === "before-window-a")).toBe(true);
    expect(before.errors.map((error) => error.message).join(" ")).toContain("cannot start before 07:00");

    const after = validateScheduleState({
      settings,
      events: [event({ id: "b", startTime: "20:30", endTime: "21:30" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(after.valid).toBe(false);
    expect(after.errors.some((error) => error.id === "after-window-b")).toBe(true);
    expect(after.errors.map((error) => error.message).join(" ")).toContain("must end no later than 21:00");

    const boundaries = validateScheduleState({
      settings,
      events: [
        event({ id: "c", startTime: "07:00", endTime: "07:30" }),
        event({ id: "d", startTime: "15:45", endTime: "16:30", dayOfWeek: 1 }),
        event({ id: "e", startTime: "20:30", endTime: "21:00", dayOfWeek: 2 }),
      ],
      trainers,
      classTypes,
      rooms,
    });
    expect(boundaries.valid).toBe(true);
  });

  it("localises the event-end error with the requested wording", () => {
    const ukErrors = validateScheduleState(
      {
        settings,
        events: [event({ id: "b", startTime: "20:30", endTime: "21:30" })],
        trainers,
        classTypes,
        rooms,
      },
      createTranslator("uk"),
    ).errors;
    expect(ukErrors.map((error) => error.message)).toContain("Заняття має завершуватися не пізніше 21:00.");
  });

  it("rejects times that break the 5-minute precision rule", () => {
    const result = validateScheduleState({
      settings,
      events: [event({ id: "a", startTime: "16:03", endTime: "17:00" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.id === "precision-a")).toBe(true);
  });

  it("rejects broken room references structurally instead of warning", () => {
    const result = validateScheduleState({
      settings,
      events: [event({ id: "a", roomId: "room-gone" })],
      trainers,
      classTypes,
      rooms,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.id === "room-a")).toBe(true);
  });

  // TEST J (unit view) — product warnings must stay warnings.
  it("keeps eligibility, clash and duplicate findings as warnings only", () => {
    const result = validateScheduleState({
      settings,
      events: [
        event({ id: "a", classTypeId: "cls-trx", roomId: "room-main" }),
        event({ id: "b", classTypeId: "cls-trx" }),
        event({ id: "c", roomId: "room-main" }),
      ],
      trainers,
      classTypes,
      rooms,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    const ids = result.warnings.map((warning) => warning.id);
    expect(ids.some((id) => id.startsWith("eligibility-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("trainer-clash-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("room-clash-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("duplicate-"))).toBe(true);
  });
});
