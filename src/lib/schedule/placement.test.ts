import { describe, expect, it } from "vitest";
import { computePlacement, computeResizeEnd, boundsFromSettings, isOutOfRange } from "@/lib/schedule/placement";

const bounds = boundsFromSettings({ startTime: "08:00", endTime: "21:00", snapMinutes: 15 });

describe("drag / resize boundaries", () => {
  it("keeps a 60 minute class inside the schedule window", () => {
    // Dropping near 21:00 must pull the class back so it ends exactly at 21:00.
    const placement = computePlacement(20 * 60 + 30, 60, bounds);
    expect(placement.startTime).toBe("20:00");
    expect(placement.endTime).toBe("21:00");
    expect(placement.endMinutes).toBeLessThanOrEqual(bounds.endMinutes);
  });

  it("never starts before the schedule start", () => {
    const placement = computePlacement(7 * 60 + 5, 45, bounds);
    expect(placement.startTime).toBe("08:00");
    expect(placement.endTime).toBe("08:45");
  });

  it("preview position and committed value are identical (single shared function)", () => {
    const preview = computePlacement(20 * 60 + 50, 45, bounds);
    const commit = computePlacement(20 * 60 + 50, 45, bounds);
    expect(preview).toEqual(commit);
    expect(preview.endTime).toBe("21:00");
  });

  it("supports 5 minute precision and custom markers times", () => {
    expect(computePlacement(15 * 60 + 30, 30, { ...bounds, snapMinutes: 5 }).startTime).toBe("15:30");
    expect(computePlacement(15 * 60 + 45, 30, { ...bounds, snapMinutes: 5 }).startTime).toBe("15:45");
    expect(computePlacement(15 * 60 + 10, 30, { ...bounds, snapMinutes: 5 }).startTime).toBe("15:10");
  });

  it("clamps resizing to the schedule end and to a positive duration", () => {
    expect(computeResizeEnd(23 * 60, 20 * 60 + 30, bounds)).toBe("21:00");
    expect(computeResizeEnd(20 * 60 + 40, 20 * 60 + 55, bounds)).toBe("21:00");
    // Below one snap step the resize keeps the 5-minute minimum instead of going backwards.
    expect(computeResizeEnd(20 * 60 + 35, 20 * 60 + 30, bounds)).toBe("20:35");
  });

  it("shrinks an event that is longer than the whole window instead of overflowing", () => {
    const placement = computePlacement(9 * 60, 24 * 60, bounds);
    expect(placement.startTime).toBe("08:00");
    expect(placement.endTime).toBe("21:00");
  });

  it("can explicitly allow out-of-range events", () => {
    const permissive = { ...bounds, allowOutOfRange: true };
    expect(computePlacement(20 * 60 + 30, 60, permissive).endTime).toBe("21:30");
    expect(isOutOfRange("20:30", "21:30", bounds)).toBe(true);
    expect(isOutOfRange("20:30", "21:30", permissive)).toBe(false);
  });

  it("reports range violations for validation and import checks", () => {
    expect(isOutOfRange("07:30", "08:30", bounds)).toBe(true);
    expect(isOutOfRange("08:00", "21:00", bounds)).toBe(false);
  });
});
