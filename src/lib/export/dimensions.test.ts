import { describe, expect, it } from "vitest";
import { computeExportDimensions, normalizeScale } from "@/lib/export/dimensions";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { DEFAULT_SETTINGS, type ClassType, type ScheduleEvent, type Trainer } from "@/lib/domain/types";
import { getTheme } from "@/lib/theme/risen-team-dark";

describe("export dimensions", () => {
  it("produces true multiples of the base canvas", () => {
    const one = computeExportDimensions({ paper: "original", orientation: "landscape", scale: 1, customWidth: 0, customHeight: 0 });
    expect(one).toMatchObject({ width: 1680, height: 880, pixelWidth: 1680, pixelHeight: 880 });
    const four = computeExportDimensions({ paper: "original", orientation: "landscape", scale: 4, customWidth: 0, customHeight: 0 });
    expect(four.pixelWidth).toBe(6720);
    expect(four.pixelHeight).toBe(3520);
  });

  it("keeps A4/A3 page ratios", () => {
    const a4 = computeExportDimensions({ paper: "a4", orientation: "landscape", scale: 2, customWidth: 0, customHeight: 0 });
    expect(a4.pageMm).toEqual({ width: 297, height: 210 });
    expect(a4.width / a4.height).toBeCloseTo(297 / 210, 2);
    expect(a4.pixelWidth).toBe(a4.width * 2);

    const a3Portrait = computeExportDimensions({
      paper: "a3",
      orientation: "portrait",
      scale: 1,
      customWidth: 0,
      customHeight: 0,
    });
    expect(a3Portrait.pageMm).toEqual({ width: 297, height: 420 });
    expect(a3Portrait.width / a3Portrait.height).toBeCloseTo(297 / 420, 2);
  });

  it("clamps custom sizes and normalises scales", () => {
    const custom = computeExportDimensions({ paper: "custom", orientation: "landscape", scale: 3, customWidth: 100, customHeight: 40 });
    expect(custom.width).toBe(600);
    expect(custom.height).toBe(400);
    expect(normalizeScale(0)).toBe(1);
    expect(normalizeScale(9)).toBe(4);
  });
});

const trainers: Trainer[] = [{ id: "t1", name: "Oleh", color: "#f59e0b", active: true, sortOrder: 0 }];
const classTypes: ClassType[] = [
  { id: "c1", name: "Boxing", shortName: "BOX", defaultDuration: 60, active: true, sortOrder: 0, trainerIds: ["t1"] },
];
const events: ScheduleEvent[] = [
  { id: "e1", scheduleId: "s", dayOfWeek: 0, startTime: "15:00", endTime: "16:00", trainerId: "t1", classTypeId: "c1", roomId: null, notes: null },
  { id: "e2", scheduleId: "s", dayOfWeek: 0, startTime: "15:30", endTime: "16:30", trainerId: "t1", classTypeId: "c1", roomId: null, notes: null },
];

describe("layout engine", () => {
  it("places cards inside their day column and time window", () => {
    const layout = buildScheduleLayout({
      settings: { ...DEFAULT_SETTINGS },
      events,
      trainers,
      classTypes,
      rooms: [],
      theme: getTheme("risen-team-dark"),
      width: 1680,
      height: 880,
    });
    expect(layout.days).toHaveLength(6);
    expect(layout.cards).toHaveLength(2);
    const monday = layout.days[0];
    for (const card of layout.cards) {
      expect(card.x).toBeGreaterThanOrEqual(monday.x - 1);
      expect(card.x + card.width).toBeLessThanOrEqual(monday.x + monday.width + 1);
      expect(card.y).toBeGreaterThan(layout.body.y);
      expect(card.y + card.height).toBeLessThanOrEqual(layout.body.y + layout.body.height + 2);
    }
    expect(layout.cards[0].lanes).toBe(2);
  });

  it("maps minutes to y positions consistently", () => {
    const layout = buildScheduleLayout({
      settings: { ...DEFAULT_SETTINGS },
      events,
      trainers,
      classTypes,
      rooms: [],
      theme: getTheme("risen-team-dark"),
      width: 1680,
      height: 880,
    });
    const first = layout.markers[0];
    const last = layout.markers[layout.markers.length - 1];
    expect(first.y).toBeCloseTo(layout.body.y, 5);
    expect(last.y).toBeCloseTo(layout.body.y + layout.body.height, 5);
    expect(layout.yToMinutes(layout.timeToY(945))).toBeCloseTo(945, 5);
  });

  it("survives an empty schedule and custom markers", () => {
    const layout = buildScheduleLayout({
      settings: { ...DEFAULT_SETTINGS, customMarkers: ["15:30", "15:45"] },
      events: [],
      trainers,
      classTypes,
      rooms: [],
      theme: getTheme("risen-team-dark"),
      width: 1200,
      height: 700,
    });
    expect(layout.cards).toHaveLength(0);
    expect(layout.markers.some((marker) => marker.label === "15:45")).toBe(true);
    expect(layout.brand.items).toHaveLength(1);
  });
});
