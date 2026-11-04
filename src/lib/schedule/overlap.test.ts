import { describe, expect, it } from "vitest";
import { compileEvents, computeLaneAssignments, hasOverlap, type LaneInput } from "@/lib/schedule/overlap";
import type { ScheduleEvent } from "@/lib/domain/types";

const event = (id: string, dayOfWeek: number, startTime: string, endTime: string): ScheduleEvent => ({
  id,
  scheduleId: "sched",
  dayOfWeek,
  startTime,
  endTime,
  trainerId: "trn-1",
  classTypeId: "cls-1",
  roomId: null,
  notes: null,
});

describe("overlap engine", () => {
  it("gives a single class the full width", () => {
    const lanes = computeLaneAssignments<LaneInput>([{ id: "a", dayOfWeek: 0, startTime: "15:00", endTime: "16:00" }]);
    expect(lanes.get("a")).toEqual({ lane: 0, lanes: 1 });
  });

  it("splits two simultaneous classes into two lanes", () => {
    const lanes = computeLaneAssignments([
      { id: "a", dayOfWeek: 0, startTime: "15:00", endTime: "16:00" },
      { id: "b", dayOfWeek: 0, startTime: "15:30", endTime: "16:30" },
    ]);
    expect(lanes.get("a")?.lanes).toBe(2);
    expect(lanes.get("b")?.lanes).toBe(2);
    expect(lanes.get("a")?.lane).not.toBe(lanes.get("b")?.lane);
  });

  it("reflows when a simultaneous class is removed", () => {
    const three = [
      { id: "a", dayOfWeek: 0, startTime: "19:00", endTime: "20:00" },
      { id: "b", dayOfWeek: 0, startTime: "19:00", endTime: "19:45" },
      { id: "c", dayOfWeek: 0, startTime: "19:00", endTime: "19:30" },
    ];
    expect(computeLaneAssignments(three).get("a")?.lanes).toBe(3);
    const afterDelete = computeLaneAssignments(three.filter((item) => item.id !== "c"));
    expect(afterDelete.get("a")?.lanes).toBe(2);
    const single = computeLaneAssignments(three.filter((item) => item.id === "a"));
    expect(single.get("a")).toEqual({ lane: 0, lanes: 1 });
  });

  it("reuses a lane for non-overlapping stretches", () => {
    const lanes = computeLaneAssignments([
      { id: "a", dayOfWeek: 1, startTime: "09:00", endTime: "10:00" },
      { id: "b", dayOfWeek: 1, startTime: "10:00", endTime: "11:00" },
      { id: "c", dayOfWeek: 1, startTime: "09:30", endTime: "10:30" },
    ]);
    expect(lanes.get("b")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("c")?.lane).toBe(1);
  });

  it("is deterministic regardless of input order", () => {
    const input: LaneInput[] = [
      { id: "c", dayOfWeek: 2, startTime: "18:00", endTime: "19:00" },
      { id: "a", dayOfWeek: 2, startTime: "18:00", endTime: "18:30" },
      { id: "b", dayOfWeek: 2, startTime: "18:15", endTime: "19:15" },
    ];
    const first = computeLaneAssignments(input);
    const second = computeLaneAssignments([...input].reverse());
    expect([...first.keys()].sort()).toEqual([...second.keys()].sort());
    for (const key of first.keys()) {
      expect(first.get(key)).toEqual(second.get(key));
    }
  });

  it("keeps days independent", () => {
    const lanes = computeLaneAssignments([
      { id: "a", dayOfWeek: 0, startTime: "15:00", endTime: "16:00" },
      { id: "b", dayOfWeek: 1, startTime: "15:00", endTime: "16:00" },
    ]);
    expect(lanes.get("a")).toEqual({ lane: 0, lanes: 1 });
    expect(lanes.get("b")).toEqual({ lane: 0, lanes: 1 });
  });

  it("compiles events only for visible days, sorted per day", () => {
    const compiled = compileEvents(
      [event("a", 0, "17:00", "18:00"), event("b", 0, "09:00", "10:00"), event("c", 1, "09:00", "10:00")],
      [0],
    );
    expect(compiled.map((item) => item.event.id)).toEqual(["b", "a"]);
    expect(compiled[0].durationMinutes).toBe(60);
  });

  it("detects overlap generally", () => {
    expect(
      hasOverlap([
        { id: "a", dayOfWeek: 0, startTime: "10:00", endTime: "11:00" },
        { id: "b", dayOfWeek: 0, startTime: "10:30", endTime: "11:30" },
      ]),
    ).toBe(true);
    expect(
      hasOverlap([
        { id: "a", dayOfWeek: 0, startTime: "10:00", endTime: "11:00" },
        { id: "b", dayOfWeek: 1, startTime: "10:30", endTime: "11:30" },
      ]),
    ).toBe(false);
  });
});
