import { TIME_PATTERN } from "@/lib/domain/types";

/** ------------------------------------------------------------------
 * Time system
 *
 * Times are stored as "HH:MM" strings (5-minute precision minimum) and are
 * converted to minute offsets for all scheduling maths. Nothing in the app
 * depends on a fixed set of 30/60-minute rows.
 * ------------------------------------------------------------------ */

export const MINUTES_IN_DAY = 24 * 60;
export const MIN_PRECISION = 5;

export function isValidTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function timeToMinutes(value: string): number {
  const match = TIME_PATTERN.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToTime(total: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_IN_DAY - 1, Math.round(total)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function addMinutes(value: string, delta: number): string {
  return minutesToTime(timeToMinutes(value) + delta);
}

export function durationMinutes(start: string, end: string): number {
  return timeToMinutes(end) - timeToMinutes(start);
}

export function snapMinutes(value: number, step: number): number {
  const safeStep = step > 0 ? step : MIN_PRECISION;
  return Math.round(value / safeStep) * safeStep;
}

export interface Interval {
  start: number;
  end: number;
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Visibly rendered time markers.
 *
 * `startTime` / `endTime` define the schedule window, `defaultInterval`
 * generates regular markers and `customMarkers` adds arbitrary user markers
 * (e.g. 15:30, 15:45). Adding a marker never touches existing events.
 */
export interface Marker {
  minutes: number;
  label: string;
  kind: "boundary" | "generated" | "custom";
}

export function buildMarkers(input: {
  startTime: string;
  endTime: string;
  defaultInterval: number;
  customMarkers: string[];
}): Marker[] {
  const start = timeToMinutes(input.startTime);
  const end = timeToMinutes(input.endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return [];

  const map = new Map<number, Marker>();
  map.set(start, { minutes: start, label: minutesToTime(start), kind: "boundary" });
  map.set(end, { minutes: end, label: minutesToTime(end), kind: "boundary" });

  const step = input.defaultInterval >= MIN_PRECISION ? input.defaultInterval : 60;
  for (let minute = start + step; minute < end; minute += step) {
    map.set(minute, { minutes: minute, label: minutesToTime(minute), kind: "generated" });
  }

  for (const raw of input.customMarkers) {
    if (!isValidTime(raw)) continue;
    const minutes = timeToMinutes(raw);
    if (minutes <= start || minutes >= end) continue;
    const existing = map.get(minutes);
    if (existing && existing.kind !== "generated") continue;
    map.set(minutes, { minutes, label: minutesToTime(minutes), kind: "custom" });
  }

  return [...map.values()].sort((a, b) => a.minutes - b.minutes);
}

/** Adds a custom marker, keeping generated markers intact. Returns sorted unique list. */
export function addMarkerToList(customMarkers: string[], time: string): string[] {
  if (!isValidTime(time)) return customMarkers;
  const set = new Set(customMarkers.filter(isValidTime));
  set.add(time);
  return [...set].sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
}

export function removeMarkerFromList(customMarkers: string[], time: string): string[] {
  return customMarkers.filter((marker) => marker !== time);
}

/** Next free quarter/hour marker below (or above) a reference time. */
export function nextMarkerSuggestion(
  reference: string,
  direction: "above" | "below",
  markers: Marker[],
  step = 15,
): string {
  const referenceMinutes = timeToMinutes(reference);
  const taken = new Set(markers.map((marker) => marker.minutes));
  const delta = direction === "below" ? step : -step;
  let candidate = referenceMinutes;
  for (let i = 0; i < 400; i += 1) {
    candidate += delta;
    if (candidate <= 0 || candidate >= MINUTES_IN_DAY) break;
    if (!taken.has(candidate)) return minutesToTime(candidate);
  }
  return reference;
}

export function formatRange(start: string, end: string): string {
  return `${start}–${end}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
