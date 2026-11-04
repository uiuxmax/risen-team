import { describe, expect, it } from "vitest";
import {
  addMarkerToList,
  addMinutes,
  buildMarkers,
  durationMinutes,
  formatDuration,
  isValidTime,
  minutesToTime,
  nextMarkerSuggestion,
  removeMarkerFromList,
  snapMinutes,
  timeToMinutes,
} from "@/lib/schedule/time";

describe("time system", () => {
  it("converts between HH:MM and minutes", () => {
    expect(timeToMinutes("15:45")).toBe(945);
    expect(minutesToTime(945)).toBe("15:45");
    expect(minutesToTime(timeToMinutes("07:05"))).toBe("07:05");
    expect(addMinutes("15:50", 25)).toBe("16:15");
    expect(durationMinutes("15:30", "16:15")).toBe(45);
  });

  it("rejects malformed times", () => {
    expect(isValidTime("25:00")).toBe(false);
    expect(isValidTime("15:60")).toBe(false);
    expect(isValidTime("15:45")).toBe(true);
  });

  it("supports 5 minute precision", () => {
    expect(minutesToTime(0)).toBe("00:00");
    expect(snapMinutes(948, 15)).toBe(945);
    expect(snapMinutes(950, 5)).toBe(950);
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(90)).toBe("1 h 30 min");
  });

  it("keeps numbering stable at day boundaries", () => {
    expect(addMinutes("23:50", 20)).toBe("23:59");
    expect(minutesToTime(-10)).toBe("00:00");
  });
});

describe("time markers", () => {
  const base = { startTime: "07:00", endTime: "21:00", defaultInterval: 60, customMarkers: [] as string[] };

  it("generates boundary + interval markers", () => {
    const markers = buildMarkers(base);
    expect(markers[0]).toMatchObject({ label: "07:00", kind: "boundary" });
    expect(markers.some((marker) => marker.label === "15:00" && marker.kind === "generated")).toBe(true);
    expect(markers[markers.length - 1]).toMatchObject({ label: "21:00", kind: "boundary" });
  });

  it("inserts 15:30 then 15:45 without touching others", () => {
    const withOne = buildMarkers({ ...base, customMarkers: ["15:30"] });
    expect(withOne.find((marker) => marker.label === "15:30")).toMatchObject({ kind: "custom" });
    const withTwo = buildMarkers({ ...base, customMarkers: ["15:30", "15:45"] });
    const labels = withTwo.map((marker) => marker.label);
    expect(labels).toContain("15:30");
    expect(labels).toContain("15:45");
    expect(labels.indexOf("15:00")).toBeLessThan(labels.indexOf("15:30"));
    expect(labels.indexOf("15:45")).toBeLessThan(labels.indexOf("16:00"));
  });

  it("ignores markers outside the schedule window", () => {
    const markers = buildMarkers({ ...base, customMarkers: ["06:00", "22:00", "12:00"] });
    expect(markers.some((marker) => marker.label === "06:00")).toBe(false);
    expect(markers.some((marker) => marker.label === "22:00")).toBe(false);
    expect(markers.some((marker) => marker.label === "12:00")).toBe(true);
  });

  it("keeps marker lists sorted and unique", () => {
    const list = addMarkerToList(["16:00", "15:30"], "15:45");
    expect(list).toEqual(["15:30", "15:45", "16:00"]);
    expect(addMarkerToList(list, "15:45")).toEqual(["15:30", "15:45", "16:00"]);
    expect(removeMarkerFromList(list, "15:45")).toEqual(["15:30", "16:00"]);
  });

  it("suggests free neighbouring markers", () => {
    const markers = buildMarkers(base);
    expect(nextMarkerSuggestion("15:00", "below", markers, 15)).toBe("15:15");
    expect(nextMarkerSuggestion("15:00", "above", markers, 15)).toBe("14:45");
    const dense = buildMarkers({ ...base, customMarkers: ["15:15", "15:30", "15:45"] });
    // 15:15/15:30/15:45 are taken and 16:00 is a generated marker, so the next free slot is 16:15
    expect(nextMarkerSuggestion("15:00", "below", dense, 15)).toBe("16:15");
  });
});
