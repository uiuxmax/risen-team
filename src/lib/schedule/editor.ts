import { type ScheduleEvent, type ScheduleSettings } from "@/lib/domain/types";
import { addMarkerToList, addMinutes, minutesToTime, removeMarkerFromList, timeToMinutes } from "@/lib/schedule/time";
import { englishTranslator, type Translator } from "@/lib/i18n";

/**
 * Editor state machine (pure).
 *
 * Every mutation returns the next state plus a human readable description.
 * That description powers autosave change logs and version history entries,
 * and keeps undo/redo independent from the network layer.
 */

export interface EditorState {
  events: ScheduleEvent[];
  settings: ScheduleSettings;
}

export type EditorAction =
  | { type: "replace"; state: EditorState; description: string; history?: boolean }
  | { type: "addEvent"; event: ScheduleEvent; description?: string }
  | { type: "updateEvent"; id: string; patch: Partial<ScheduleEvent>; description?: string }
  | { type: "deleteEvent"; id: string; label?: string }
  | { type: "duplicateEvent"; id: string; newId: string; description?: string }
  | { type: "moveEvent"; id: string; dayOfWeek: number; startTime: string; label?: string }
  | { type: "resizeEvent"; id: string; endTime: string; label?: string }
  | { type: "copyDay"; fromDay: number; toDay: number; mode: "replace" | "merge"; newIds: string[]; label?: string }
  | { type: "updateSettings"; patch: Partial<ScheduleSettings>; description?: string }
  | { type: "addMarker"; time: string }
  | { type: "removeMarker"; time: string };

export interface EditorResult {
  state: EditorState;
  description: string;
}

interface DescribeVars extends Record<string, string> {
  class: string;
  day: string;
  start: string;
  end: string;
}

/** Builds the localised label used by change-log descriptions. */
function labelVars(event: ScheduleEvent, translate: Translator, className: string): DescribeVars {
  return {
    class: className,
    day: translate(`day.${event.dayOfWeek}` as "day.0"),
    start: event.startTime,
    end: event.endTime,
  };
}

const CLASS_PLACEHOLDER: Record<string, string> = { en: "Class", uk: "Заняття" };
function classLabelFor(translate: Translator): string {
  return translate("dialog.classType") === "Тип заняття" ? CLASS_PLACEHOLDER.uk : CLASS_PLACEHOLDER.en;
}

export function applyAction(
  state: EditorState,
  action: EditorAction,
  translate: Translator = englishTranslator,
): EditorResult {
  switch (action.type) {
    case "replace":
      return { state: action.state, description: action.description };

    case "addEvent": {
      const event = action.event;
      return {
        state: { ...state, events: [...state.events.filter((item) => item.id !== event.id), event] },
        description: action.description ?? translate("history.added", labelVars(event, translate, classLabelFor(translate))),
      };
    }

    case "updateEvent": {
      let description = action.description ?? "";
      const events = state.events.map((event) => {
        if (event.id !== action.id) return event;
        const next = { ...event, ...action.patch };
        if (!description) {
          description = translate("history.updated", labelVars(next, translate, classLabelFor(translate)));
        }
        return next;
      });
      return { state: { ...state, events }, description: description || translate("history.updated", labelVars({ ...action.patch } as ScheduleEvent, translate, classLabelFor(translate))) };
    }

    case "deleteEvent": {
      const event = state.events.find((item) => item.id === action.id);
      if (!event) return { state, description: "" };
      return {
        state: { ...state, events: state.events.filter((item) => item.id !== action.id) },
        description: action.label ?? translate("history.deleted", labelVars(event, translate, classLabelFor(translate))),
      };
    }

    case "duplicateEvent": {
      const event = state.events.find((item) => item.id === action.id);
      if (!event) return { state, description: "" };
      const copy: ScheduleEvent = { ...event, id: action.newId };
      return {
        state: { ...state, events: [...state.events, copy] },
        description: action.description ?? translate("history.duplicated", labelVars(event, translate, classLabelFor(translate))),
      };
    }

    case "moveEvent": {
      const event = state.events.find((item) => item.id === action.id);
      if (!event) return { state, description: "" };
      const duration = timeToMinutes(event.endTime) - timeToMinutes(event.startTime);
      const endTime = action.startTime ? minutesToTime(timeToMinutes(action.startTime) + duration) : event.endTime;
      const events = state.events.map((item) =>
        item.id === action.id ? { ...item, dayOfWeek: action.dayOfWeek, startTime: action.startTime, endTime } : item,
      );
      return {
        state: { ...state, events },
        description:
          action.label ??
          translate("history.moved", {
            ...labelVars(event, translate, classLabelFor(translate)),
            day: translate(`day.${action.dayOfWeek}` as "day.0"),
            start: action.startTime,
          }),
      };
    }

    case "resizeEvent": {
      const event = state.events.find((item) => item.id === action.id);
      if (!event) return { state, description: "" };
      const start = timeToMinutes(event.startTime);
      const end = timeToMinutes(action.endTime);
      if (end <= start) return { state, description: "" };
      const events = state.events.map((item) => (item.id === action.id ? { ...item, endTime: action.endTime } : item));
      return {
        state: { ...state, events },
        description:
          action.label ??
          translate("history.resized", {
            ...labelVars(event, translate, classLabelFor(translate)),
            end: action.endTime,
          }),
      };
    }

    case "copyDay": {
      const source = state.events.filter((event) => event.dayOfWeek === action.fromDay);
      if (source.length === 0) {
        return {
          state,
          description: translate("history.noClasses", { day: translate(`day.${action.fromDay}` as "day.0") }),
        };
      }
      const kept =
        action.mode === "replace"
          ? state.events.filter((event) => event.dayOfWeek !== action.toDay)
          : [...state.events];
      const copies = source.map((event, index) => ({
        ...event,
        id: action.newIds[index] ?? `${event.id}-copy-${index}`,
        dayOfWeek: action.toDay,
      }));
      return {
        state: { ...state, events: [...kept, ...copies] },
        description:
          action.label ??
          translate(action.mode === "replace" ? "history.dayReplaced" : "history.dayMerged", {
            from: translate(`day.${action.fromDay}` as "day.0"),
            to: translate(`day.${action.toDay}` as "day.0"),
          }),
      };
    }

    case "updateSettings": {
      const settings = { ...state.settings, ...action.patch };
      let description = action.description ?? "";
      if (!description) {
        if (action.patch.startTime !== undefined || action.patch.endTime !== undefined) {
          description = translate("history.settingsWindow", { start: settings.startTime, end: settings.endTime });
        } else if (action.patch.visibleDays) {
          description = translate("history.settingsDays");
        } else if (action.patch.defaultInterval) {
          description = translate("history.settingsInterval");
        } else if (action.patch.snapMinutes) {
          description = translate("history.settingsSnap");
        } else {
          description = translate("history.settings");
        }
      }
      return { state: { ...state, settings }, description };
    }

    case "addMarker": {
      if (timeToMinutes(action.time) <= timeToMinutes(state.settings.startTime)) {
        return { state, description: translate("history.markerOutside") };
      }
      if (timeToMinutes(action.time) >= timeToMinutes(state.settings.endTime)) {
        return { state, description: translate("history.markerOutside") };
      }
      return {
        state: {
          ...state,
          settings: { ...state.settings, customMarkers: addMarkerToList(state.settings.customMarkers, action.time) },
        },
        description: translate("history.markerAdded", { time: action.time }),
      };
    }

    case "removeMarker":
      return {
        state: {
          ...state,
          settings: { ...state.settings, customMarkers: removeMarkerFromList(state.settings.customMarkers, action.time) },
        },
        description: translate("history.markerRemoved", { time: action.time }),
      };

    default:
      return { state, description: "" };
  }
}

export function shiftEvent(state: EditorState, event: ScheduleEvent, deltaMinutes: number): ScheduleEvent {
  return {
    ...event,
    startTime: addMinutes(event.startTime, deltaMinutes),
    endTime: addMinutes(event.endTime, deltaMinutes),
  };
}

export interface HistoryState {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
  lastDescription: string;
}

export const HISTORY_LIMIT = 60;

export function createHistory(present: EditorState): HistoryState {
  return { past: [], present, future: [], lastDescription: "" };
}

export interface HistoryAction {
  action?: EditorAction;
  /** When false the change is applied without creating a separate undo step (used by drag previews). */
  record?: boolean;
  /** Explicit base state, used when committing a drag that was previewed transiently. */
  base?: EditorState;
  /** Translator used for the localised change-log description. */
  translate?: Translator;
  undo?: boolean;
  redo?: boolean;
}

export function historyReducer(history: HistoryState, payload: HistoryAction): HistoryState {
  if (payload.undo) return undo(history);
  if (payload.redo) return redo(history);
  const { action, record = true } = payload;
  if (!action) return history;
  if (action.type === "replace" && action.history === false) return createHistory(action.state);
  const base = payload.base ?? history.present;
  const { state, description } = applyAction(base, action, payload.translate ?? englishTranslator);
  if (state === base && payload.base === undefined) return { ...history, lastDescription: description };
  // A commit that ends up identical to the drag origin (e.g. the pointer barely moved)
  // must not create an empty undo step.
  if (
    payload.base !== undefined &&
    JSON.stringify(state.events) === JSON.stringify(base.events) &&
    JSON.stringify(state.settings) === JSON.stringify(base.settings)
  ) {
    return history;
  }
  if (!record) return { ...history, present: state, lastDescription: description };
  const past = [...history.past, base].slice(-HISTORY_LIMIT);
  return { past, present: state, future: [], lastDescription: description };
}

export function undo(history: HistoryState): HistoryState {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, HISTORY_LIMIT),
    lastDescription: "",
  };
}

export function redo(history: HistoryState): HistoryState {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: history.future.slice(1),
    lastDescription: "",
  };
}
