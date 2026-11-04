import { describe, expect, it } from "vitest";
import {
  applyAction,
  createHistory,
  historyReducer,
  type EditorState,
} from "@/lib/schedule/editor";
import { DEFAULT_SETTINGS, type ScheduleEvent } from "@/lib/domain/types";

const baseEvent: ScheduleEvent = {
  id: "e1",
  scheduleId: "sched",
  dayOfWeek: 0,
  startTime: "15:00",
  endTime: "16:00",
  trainerId: "trn-oleh",
  classTypeId: "cls-boxing",
  roomId: null,
  notes: null,
};

const state = (events: ScheduleEvent[] = [baseEvent]): EditorState => ({
  events,
  settings: { ...DEFAULT_SETTINGS },
});

describe("editor state machine", () => {
  it("adds, updates and deletes events with descriptions", () => {
    const added = applyAction(state([]), { type: "addEvent", event: baseEvent });
    expect(added.state.events).toHaveLength(1);
    expect(added.description).toContain("Added class");

    const moved = applyAction(state(), { type: "updateEvent", id: "e1", patch: { startTime: "18:30" } });
    expect(moved.state.events[0].startTime).toBe("18:30");
    expect(moved.description).toContain("18:30");

    const removed = applyAction(state(), { type: "deleteEvent", id: "e1" });
    expect(removed.state.events).toHaveLength(0);
    expect(removed.description).toContain("Deleted");
  });

  it("moves an event to another day keeping its duration", () => {
    const result = applyAction(state(), { type: "moveEvent", id: "e1", dayOfWeek: 1, startTime: "16:30" });
    const event = result.state.events[0];
    expect(event.dayOfWeek).toBe(1);
    expect(event.startTime).toBe("16:30");
    expect(event.endTime).toBe("17:30");
  });

  it("refuses to resize to a non-positive duration", () => {
    const result = applyAction(state(), { type: "resizeEvent", id: "e1", endTime: "14:00" });
    expect(result.state.events[0].endTime).toBe("16:00");
  });

  it("copies a day with replace or merge semantics", () => {
    const monday = baseEvent;
    const wednesday: ScheduleEvent = { ...baseEvent, id: "e2", dayOfWeek: 2, classTypeId: "cls-trx" };
    const replaced = applyAction(state([monday, wednesday]), {
      type: "copyDay",
      fromDay: 0,
      toDay: 2,
      mode: "replace",
      newIds: ["new-1"],
    });
    expect(replaced.state.events.filter((event) => event.dayOfWeek === 2).map((event) => event.id)).toEqual(["new-1"]);

    const merged = applyAction(state([monday, wednesday]), {
      type: "copyDay",
      fromDay: 0,
      toDay: 2,
      mode: "merge",
      newIds: ["new-2"],
    });
    const wednesdayEvents = merged.state.events.filter((event) => event.dayOfWeek === 2);
    expect(wednesdayEvents.map((event) => event.id).sort()).toEqual(["e2", "new-2"]);
  });

  it("does nothing when the source day is empty", () => {
    const result = applyAction(state([]), { type: "copyDay", fromDay: 0, toDay: 1, mode: "replace", newIds: [] });
    expect(result.state.events).toHaveLength(0);
  });

  it("supports undo and redo across multiple steps", () => {
    let history = createHistory(state([]));
    history = historyReducer(history, { action: { type: "addEvent", event: baseEvent } });
    history = historyReducer(history, { action: { type: "deleteEvent", id: "e1" } });
    expect(history.present.events).toHaveLength(0);

    history = historyReducer(history, { undo: true });
    expect(history.present.events).toHaveLength(1);
    history = historyReducer(history, { undo: true });
    expect(history.present.events).toHaveLength(0);
    history = historyReducer(history, { redo: true });
    expect(history.present.events).toHaveLength(1);
    history = historyReducer(history, { redo: true });
    expect(history.present.events).toHaveLength(0);
  });

  it("keeps transient previews out of the undo stack and commits from the drag origin", () => {
    let history = createHistory(state());
    history = historyReducer(history, {
      action: { type: "moveEvent", id: "e1", dayOfWeek: 3, startTime: "09:00" },
      record: false,
    });
    expect(history.past).toHaveLength(0);
    expect(history.present.events[0].startTime).toBe("09:00");

    const origin = state();
    history = historyReducer(history, {
      action: { type: "moveEvent", id: "e1", dayOfWeek: 3, startTime: "09:00" },
      base: origin,
    });
    expect(history.past).toHaveLength(1);
    history = historyReducer(history, { undo: true });
    expect(history.present.events[0]).toMatchObject({ dayOfWeek: 0, startTime: "15:00", endTime: "16:00" });
  });

  it("adds and removes custom markers through settings", () => {
    let history = createHistory(state());
    history = historyReducer(history, { action: { type: "addMarker", time: "15:30" } });
    history = historyReducer(history, { action: { type: "addMarker", time: "15:45" } });
    expect(history.present.settings.customMarkers).toEqual(["15:30", "15:45"]);
    history = historyReducer(history, { action: { type: "removeMarker", time: "15:30" } });
    expect(history.present.settings.customMarkers).toEqual(["15:45"]);
  });

  it("refuses markers outside the schedule window", () => {
    const result = applyAction(state(), { type: "addMarker", time: "05:00" });
    expect(result.state.settings.customMarkers).toEqual([]);
  });
});
