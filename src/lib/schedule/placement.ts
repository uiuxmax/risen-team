import { MIN_PRECISION, minutesToTime, timeToMinutes } from "@/lib/schedule/time";

/**
 * Shared placement maths.
 *
 * Drag preview, drag commit and resize all funnel through these functions, so the
 * position the user sees is always exactly the position that gets saved, and an
 * event can never be pushed outside the configured schedule window
 * (e.g. a 60-minute class cannot end at 21:30 when the schedule ends at 21:00).
 *
 * Set `allowOutOfRange` in the schedule settings contract if the club ever wants
 * events to extend beyond the visible window — the default is strictly clamped.
 */

export interface PlacementBounds {
  startMinutes: number;
  endMinutes: number;
  snapMinutes: number;
  allowOutOfRange?: boolean;
}

export function snappedMinutes(rawMinutes: number, bounds: PlacementBounds): number {
  const step = bounds.snapMinutes >= MIN_PRECISION ? bounds.snapMinutes : MIN_PRECISION;
  const snapped = Math.round(rawMinutes / step) * step;
  if (bounds.allowOutOfRange) return Math.max(0, Math.min(24 * 60 - step, snapped));
  return Math.max(bounds.startMinutes, Math.min(bounds.endMinutes, snapped));
}

export interface Placement {
  startTime: string;
  endTime: string;
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
}

/**
 * Placement for a drag operation: the event keeps its duration and is kept fully
 * inside the schedule window.
 */
export function computePlacement(rawStartMinutes: number, durationMinutes: number, bounds: PlacementBounds): Placement {
  const windowLength = bounds.endMinutes - bounds.startMinutes;
  const duration = Math.max(
    MIN_PRECISION,
    Math.min(durationMinutes > 0 ? durationMinutes : MIN_PRECISION, bounds.allowOutOfRange ? durationMinutes : windowLength),
  );
  let start = snappedMinutes(rawStartMinutes, bounds);
  if (!bounds.allowOutOfRange) {
    start = Math.max(bounds.startMinutes, Math.min(bounds.endMinutes - duration, start));
  }
  const end = bounds.allowOutOfRange ? start + duration : Math.min(bounds.endMinutes, start + duration);
  return {
    startTime: minutesToTime(start),
    endTime: minutesToTime(end),
    startMinutes: start,
    endMinutes: end,
    durationMinutes: end - start,
  };
}

/** Resizing only moves the end; the end is clamped to the schedule end. */
export function computeResizeEnd(rawEndMinutes: number, startMinutes: number, bounds: PlacementBounds): string {
  const minEnd = startMinutes + MIN_PRECISION;
  const maxEnd = bounds.allowOutOfRange ? 24 * 60 - MIN_PRECISION : bounds.endMinutes;
  const snapped = snappedMinutes(rawEndMinutes, bounds);
  return minutesToTime(Math.max(minEnd, Math.min(maxEnd, snapped)));
}

export function boundsFromSettings(settings: {
  startTime: string;
  endTime: string;
  snapMinutes: number;
}): PlacementBounds {
  return {
    startMinutes: timeToMinutes(settings.startTime),
    endMinutes: timeToMinutes(settings.endTime),
    snapMinutes: settings.snapMinutes,
    allowOutOfRange: false,
  };
}

/** True when an event would violate the visible schedule window. */
export function isOutOfRange(startTime: string, endTime: string, bounds: PlacementBounds): boolean {
  if (bounds.allowOutOfRange) return false;
  return timeToMinutes(startTime) < bounds.startMinutes || timeToMinutes(endTime) > bounds.endMinutes;
}
