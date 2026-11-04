import { DEFAULT_SETTINGS, type ClassType, type ScheduleEvent, type SnapshotContent, type Trainer } from "@/lib/domain/types";

export const DEMO_HALL_NAME = "Демонстраційний зал";

/** A reusable example, never an automatic database seed. Hall creation remaps
 * every identifier, so repeated examples and their edits stay independent. */
export function createDemoHallSnapshot(): SnapshotContent {
  const scheduleId = "demo-hall-template";
  const trainers: Trainer[] = [
    { id: "demo-anastasiia", name: "Анастасія Коваль", initials: "АК", color: "#e11d48", active: true, sortOrder: 0, notes: "Йога та стретчинг. Демонстраційний тренер." },
    { id: "demo-maksym", name: "Максим Бондар", initials: "МБ", color: "#f97316", active: true, sortOrder: 1, notes: "Бокс і функціональні тренування. Демонстраційний тренер." },
    { id: "demo-olena", name: "Олена Мельник", initials: "ОМ", color: "#06b6d4", active: true, sortOrder: 2, notes: "Пілатес та стретчинг. Демонстраційний тренер." },
    { id: "demo-andrii", name: "Андрій Шевченко", initials: "АШ", color: "#22c55e", active: true, sortOrder: 3, notes: "TRX і функціональні тренування. Демонстраційний тренер." },
  ];
  const classTypes: ClassType[] = [
    { id: "demo-yoga", name: "Йога", shortName: "ЙОГА", defaultDuration: 60, active: true, sortOrder: 0, trainerIds: ["demo-anastasiia"] },
    { id: "demo-boxing", name: "Бокс", shortName: "БОКС", defaultDuration: 60, active: true, sortOrder: 1, trainerIds: ["demo-maksym"] },
    { id: "demo-pilates", name: "Пілатес", shortName: "ПІЛАТЕС", defaultDuration: 60, active: true, sortOrder: 2, trainerIds: ["demo-olena"] },
    { id: "demo-trx", name: "TRX", shortName: "TRX", defaultDuration: 45, active: true, sortOrder: 3, trainerIds: ["demo-andrii"] },
    { id: "demo-stretch", name: "Стретчинг", shortName: "СТРЕТЧ", defaultDuration: 45, active: true, sortOrder: 4, trainerIds: ["demo-anastasiia", "demo-olena"] },
    { id: "demo-functional", name: "Функціональне тренування", shortName: "ФУНКЦІОНАЛ", defaultDuration: 60, active: true, sortOrder: 5, trainerIds: ["demo-maksym", "demo-andrii"] },
  ];
  const events: ScheduleEvent[] = [];
  const add = (dayOfWeek: number, startTime: string, endTime: string, trainerId: string, classTypeId: string) => {
    events.push({ id: `demo-event-${events.length + 1}`, scheduleId, dayOfWeek, startTime, endTime, trainerId, classTypeId, roomId: null, notes: null });
  };
  for (const day of [0, 2, 4]) {
    add(day, "08:00", "09:00", "demo-anastasiia", "demo-yoga");
    add(day, "09:15", "10:15", "demo-olena", "demo-pilates");
    add(day, "18:00", "19:00", "demo-maksym", "demo-boxing");
    add(day, "18:00", "18:45", "demo-andrii", "demo-trx");
  }
  for (const day of [1, 3]) {
    add(day, "08:30", "09:30", "demo-olena", "demo-pilates");
    add(day, "10:00", "10:45", "demo-anastasiia", "demo-stretch");
    add(day, "18:30", "19:30", "demo-maksym", "demo-functional");
    add(day, "19:30", "20:15", "demo-andrii", "demo-trx");
  }
  add(5, "09:00", "10:00", "demo-anastasiia", "demo-yoga");
  add(5, "10:15", "11:15", "demo-maksym", "demo-boxing");
  add(5, "11:30", "12:30", "demo-andrii", "demo-functional");
  add(5, "12:45", "13:30", "demo-olena", "demo-stretch");
  return {
    schemaVersion: 1,
    schedule: { id: scheduleId, name: DEMO_HALL_NAME, status: "draft" },
    settings: {
      ...DEFAULT_SETTINGS,
      visibleDays: [0, 1, 2, 3, 4, 5],
      customMarkers: [],
      startTime: "08:00",
      endTime: "21:00",
      scheduleTitle: "RISEN TEAM",
      scheduleSubtitle: "ДЕМОНСТРАЦІЙНИЙ ТИЖНЕВИЙ РОЗКЛАД",
    },
    trainers, classTypes, events, rooms: [],
  };
}
