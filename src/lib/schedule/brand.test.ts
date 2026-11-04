import { describe, expect, it } from "vitest";
import { buildScheduleLayout, buildLegendItems } from "@/lib/schedule/layout";
import { getTheme } from "@/lib/theme/risen-team-dark";
import { DEFAULT_SETTINGS, type ClassType, type ScheduleEvent, type Trainer } from "@/lib/domain/types";

// Autosave policy/scheduler coverage lives in autosave.test.ts.

const trainers: Trainer[] = [
  { id: "t1", name: "Анастасія", color: "#8b5cf6", active: true, sortOrder: 0 },
  { id: "t2", name: "Валерія", color: "#0ea5e9", active: true, sortOrder: 1 },
  { id: "t3", name: "Любов", color: "#f59e0b", active: true, sortOrder: 2 },
  { id: "t4", name: "Костянтин", color: "#22c55e", active: false, sortOrder: 3 },
];

const classTypes: ClassType[] = [
  { id: "c1", name: "Бокс", shortName: "БОКС", defaultDuration: 60, active: true, sortOrder: 0, trainerIds: ["t3", "t4"] },
];

const event = (id: string, trainerId: string, dayOfWeek = 0): ScheduleEvent => ({
  id,
  scheduleId: "s",
  dayOfWeek,
  startTime: "18:00",
  endTime: "19:00",
  trainerId,
  classTypeId: "c1",
  roomId: null,
  notes: null,
});

const layoutFor = (events: ScheduleEvent[]) =>
  buildScheduleLayout({
    settings: { ...DEFAULT_SETTINGS },
    events,
    trainers,
    classTypes,
    rooms: [],
    theme: getTheme("risen-team-dark"),
    width: 1680,
    height: 880,
  });

describe("Risen Team brand panel composition", () => {
  it("places the logo area above the trainer list, both on the right", () => {
    const layout = layoutFor([event("e1", "t3")]);
    expect(layout.brand.logoArea.y + layout.brand.logoArea.height).toBeLessThanOrEqual(layout.brand.legendArea.y);
    expect(layout.brand.logoArea.y).toBe(layout.brand.rect.y);
    // The schedule grid must stay to the left of the brand panel.
    expect(layout.body.x + layout.body.width).toBeLessThanOrEqual(layout.brand.rect.x);
    // No left branding rail any more.
    expect(layout.timeAxis.x).toBe(layout.theme.canvas.padding);
    expect(layout.header.height).toBeLessThanOrEqual(60);
  });

  it("keeps the legend content-height and bottom-aligned inside the panel", () => {
    const layout = layoutFor([event("e1", "t3")]);
    expect(layout.brand.legendArea.y + layout.brand.legendArea.height).toBe(layout.brand.rect.y + layout.brand.rect.height);
    expect(layout.brand.legendArea.height).toBeLessThan(layout.brand.rect.height * 0.5);
    for (const item of layout.brand.items) {
      expect(item.y).toBeGreaterThanOrEqual(layout.brand.legendArea.y);
      expect(item.y).toBeLessThanOrEqual(layout.brand.legendArea.y + layout.brand.legendArea.height);
    }
  });

  it("uses the shared 8px schedule card radius", () => {
    const layout = layoutFor([event("e1", "t3")]);
    expect(layout.theme.cards.radius).toBe(8);
  });
});

describe("trainer legend ordering and deactivation", () => {
  it("puts trainers who actually teach this week first, busiest first", () => {
    const items = buildLegendItems(trainers, [
      { event: event("a", "t3"), lane: 0, lanes: 1, startMinutes: 0, endMinutes: 0, durationMinutes: 60 },
      { event: event("b", "t3"), lane: 0, lanes: 1, startMinutes: 0, endMinutes: 0, durationMinutes: 60 },
      { event: event("c", "t2"), lane: 0, lanes: 1, startMinutes: 0, endMinutes: 0, durationMinutes: 60 },
    ]);
    expect(items[0]).toMatchObject({ trainerId: "t3", count: 2 });
    expect(items[1]).toMatchObject({ trainerId: "t2", count: 1 });
  });

  it("still renders a deactivated trainer that is referenced by the schedule", () => {
    const layout = layoutFor([event("e1", "t4")]);
    const card = layout.cards[0];
    expect(card.trainerName).toBe("Костянтин");
    expect(card.trainerColor).toBe("#22c55e");
    expect(layout.brand.items.some((item) => item.trainerId === "t4")).toBe(true);
  });

  it("hides deactivated trainers that teach nothing", () => {
    const items = buildLegendItems(trainers, []);
    expect(items.some((item) => item.trainerId === "t4")).toBe(false);
    expect(items.map((item) => item.trainerId)).toEqual(["t1", "t2", "t3"]);
  });
});
