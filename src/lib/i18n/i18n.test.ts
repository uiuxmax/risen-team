import { describe, expect, it } from "vitest";
import { en, uk, type DictionaryKey } from "@/lib/i18n/dictionaries";
import { createTranslator, localeOf, translate, DEFAULT_LANGUAGE, isLanguage } from "@/lib/i18n";
import { validateSchedule, validateScheduleState } from "@/lib/schedule/validation";
import { applyAction } from "@/lib/schedule/editor";
import { DEFAULT_SETTINGS, type ClassType, type ScheduleEvent, type Trainer } from "@/lib/domain/types";

const enKeys = Object.keys(en) as DictionaryKey[];
const ukKeys = Object.keys(uk) as DictionaryKey[];

describe("interface language", () => {
  it("ships a complete Ukrainian dictionary", () => {
    const missing = enKeys.filter((key) => !(key in uk));
    expect(missing).toEqual([]);
    expect(ukKeys.length).toBe(enKeys.length);
  });

  it("has no empty strings and keeps placeholders aligned", () => {
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const key of enKeys) {
      expect(uk[key].trim().length, `uk:${key}`).toBeGreaterThan(0);
      expect(en[key].trim().length, `en:${key}`).toBeGreaterThan(0);
      expect(placeholders(uk[key]), `placeholders of ${key}`).toBe(placeholders(en[key]));
    }
  });

  it("interpolates variables in both languages", () => {
    expect(translate("en", "save.saved", { time: "18:37" })).toBe("✓ Saved 18:37");
    expect(translate("uk", "save.saved", { time: "18:37" })).toBe("✓ Збережено 18:37");
    expect(translate("uk", "markers.visible", { count: 4 })).toBe("видно: 4");
    expect(translate("en", "markers.visible", { count: 4 })).toBe("4 visible");
    // Missing values are left untouched instead of printing "undefined".
    expect(translate("uk", "save.saved", {})).toContain("{time}");
  });

  it("keeps weekday labels localised", () => {
    const t = createTranslator("uk");
    expect(t("day.0")).toBe("Понеділок");
    expect(t("day.5")).toBe("Субота");
    expect(t("dayShort.6")).toBe("НД");
    expect(createTranslator("en")("day.1")).toBe("Tuesday");
  });

  it("opens in Ukrainian by default and keeps English as an option", () => {
    expect(DEFAULT_LANGUAGE).toBe("uk");
    expect(translate(DEFAULT_LANGUAGE, "nav.schedule")).toBe("Розклад");
    expect(translate("en", "nav.schedule")).toBe("Schedule");
    expect(isLanguage("uk")).toBe(true);
    expect(isLanguage("de")).toBe(false);
    expect(localeOf("uk")).toBe("uk-UA");
    expect(localeOf("en")).toBe("en-GB");
    // Unknown language values fall back to English rather than throwing.
    expect(translate("de" as "uk", "save.saved", { time: "18:37" })).toBe("✓ Saved 18:37");
  });
});

const trainers: Trainer[] = [{ id: "t1", name: "Олег", color: "#f59e0b", active: true, sortOrder: 0 }];
const classTypes: ClassType[] = [
  { id: "c1", name: "Бокс", shortName: "БОКС", defaultDuration: 60, active: true, sortOrder: 0, trainerIds: ["t1"] },
];
const event = (overrides: Partial<ScheduleEvent> = {}): ScheduleEvent => ({
  id: "e1",
  scheduleId: "s",
  dayOfWeek: 0,
  startTime: "16:00",
  endTime: "17:00",
  trainerId: "t1",
  classTypeId: "c1",
  roomId: null,
  notes: null,
  ...overrides,
});

describe("localised conflict messages and change log", () => {
  it("reports conflicts in the requested language", () => {
    const ukTranslate = createTranslator("uk");
    const conflicts = validateSchedule(
      { settings: DEFAULT_SETTINGS, events: [event({ endTime: "15:00" })], trainers, classTypes, rooms: [] },
      ukTranslate,
    );
    expect(conflicts[0].message).toContain("Час завершення");
    expect(conflicts[0].message).toContain("Понеділок");

    const english = validateSchedule({
      settings: DEFAULT_SETTINGS,
      events: [event({ endTime: "15:00" })],
      trainers,
      classTypes,
      rooms: [],
    });
    expect(english[0].message).toContain("End time must be later");
  });

  it("writes change-log descriptions in the requested language", () => {
    const state = {
      events: [event()],
      settings: { ...DEFAULT_SETTINGS },
    };
    const ukResult = applyAction(
      state,
      { type: "moveEvent", id: "e1", dayOfWeek: 2, startTime: "18:30" },
      createTranslator("uk"),
    );
    expect(ukResult.description).toContain("Середа");
    expect(ukResult.description).toContain("18:30");

    const enResult = applyAction(state, { type: "moveEvent", id: "e1", dayOfWeek: 2, startTime: "18:30" });
    expect(enResult.description).toContain("Wednesday");

    const marker = applyAction(state, { type: "addMarker", time: "15:30" }, createTranslator("uk"));
    expect(marker.description).toBe("Додано позначку часу 15:30");
  });
});
