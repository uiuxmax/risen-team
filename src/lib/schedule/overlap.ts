import type { ScheduleEvent } from "@/lib/domain/types";
import { intervalsOverlap, timeToMinutes } from "@/lib/schedule/time";

/**
 * Overlap / simultaneity engine.
 *
 * Events on the same day that overlap in time are grouped into clusters.
 * Inside a cluster each event gets a deterministic lane; the width of a card is
 * `1 / lanes`. Deleting a card re-clusters the day, so the remaining cards
 * automatically expand. Pure + deterministic (no random, no DOM access).
 */

export interface LaneAssignment {
  lane: number;
  lanes: number;
}

export interface LaneInput {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export function computeLaneAssignments<T extends LaneInput>(events: T[]): Map<string, LaneAssignment> {
  const result = new Map<string, LaneAssignment>();
  const byDay = new Map<number, T[]>();

  for (const event of events) {
    const list = byDay.get(event.dayOfWeek);
    if (list) list.push(event);
    else byDay.set(event.dayOfWeek, [event]);
  }

  for (const dayEvents of byDay.values()) {
    const sorted = [...dayEvents].sort((a, b) => {
      const startDiff = timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
      if (startDiff !== 0) return startDiff;
      const endDiff = timeToMinutes(a.endTime) - timeToMinutes(b.endTime);
      if (endDiff !== 0) return endDiff;
      return a.id.localeCompare(b.id);
    });

    let cluster: T[] = [];
    let clusterEnd = -1;

    const flush = () => {
      if (cluster.length === 0) return;
      assignCluster(cluster, result);
      cluster = [];
      clusterEnd = -1;
    };

    for (const event of sorted) {
      const start = timeToMinutes(event.startTime);
      const end = timeToMinutes(event.endTime);
      if (cluster.length > 0 && start >= clusterEnd) flush();
      cluster.push(event);
      clusterEnd = Math.max(clusterEnd, end);
    }
    flush();
  }

  return result;
}

function assignCluster<T extends LaneInput>(cluster: T[], result: Map<string, LaneAssignment>) {
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();

  for (const event of cluster) {
    const start = timeToMinutes(event.startTime);
    const end = timeToMinutes(event.endTime);
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      laneEnds.push(end);
      lane = laneEnds.length - 1;
    } else {
      laneEnds[lane] = end;
    }
    laneOf.set(event.id, lane);
  }

  const lanes = Math.max(1, laneEnds.length);
  for (const event of cluster) {
    result.set(event.id, { lane: laneOf.get(event.id) ?? 0, lanes });
  }
}

export interface CompiledEvent {
  event: ScheduleEvent;
  lane: number;
  lanes: number;
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
}

/** Convenience wrapper: events enriched with lane info, sorted per day. */
export function compileEvents(events: ScheduleEvent[], visibleDays: number[]): CompiledEvent[] {
  const visible = new Set(visibleDays);
  const filtered = events.filter((event) => visible.has(event.dayOfWeek));
  const lanes = computeLaneAssignments(filtered);

  return filtered
    .map((event) => {
      const startMinutes = timeToMinutes(event.startTime);
      const endMinutes = timeToMinutes(event.endTime);
      const assignment = lanes.get(event.id) ?? { lane: 0, lanes: 1 };
      return {
        event,
        lane: assignment.lane,
        lanes: assignment.lanes,
        startMinutes,
        endMinutes,
        durationMinutes: Math.max(1, endMinutes - startMinutes),
      };
    })
    .sort((a, b) => a.event.dayOfWeek - b.event.dayOfWeek || a.startMinutes - b.startMinutes || a.lane - b.lane);
}

/** True if any pair of the given events overlaps on the same day. */
export function hasOverlap(events: LaneInput[]): boolean {
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[i].dayOfWeek !== events[j].dayOfWeek) continue;
      if (
        intervalsOverlap(
          { start: timeToMinutes(events[i].startTime), end: timeToMinutes(events[i].endTime) },
          { start: timeToMinutes(events[j].startTime), end: timeToMinutes(events[j].endTime) },
        )
      ) {
        return true;
      }
    }
  }
  return false;
}
