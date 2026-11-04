import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  appMeta,
  classTypes,
  rooms,
  scheduleEvents,
  scheduleSettings,
  scheduleVersions,
  schedules,
  trainerClassTypes,
  trainers,
} from "@/db/schema";
import type { ClassType, Room, ScheduleEvent, ScheduleSettings, SnapshotContent, Trainer } from "@/lib/domain/types";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { minutesToTime } from "@/lib/schedule/time";

/**
 * Demo seed for a brand-new local database.
 *
 * Seeding happens exactly once per database file: a marker row is stored in
 * `app_meta`, so intentionally emptied workspaces are never re-seeded.
 */

export const SEED_MARKER = "demo_seed";

const TRAINER_SEED: Omit<Trainer, "sortOrder">[] = [
  { id: "trn-anastasia", name: "Анастасія", color: "#8b5cf6", initials: "АН", active: true, notes: "Стретчинг і кор" },
  { id: "trn-valeria", name: "Валерія", color: "#0ea5e9", initials: "ВА", active: true, notes: "HIIT та функціональні" },
  { id: "trn-liubov", name: "Любов", color: "#f59e0b", initials: "ЛЮ", active: true, notes: "Бокс, FITBOXING" },
  { id: "trn-kostiantyn", name: "Костянтин", color: "#22c55e", initials: "КО", active: true, notes: "Бокс, TRX" },
  { id: "trn-iryna", name: "Ірина", color: "#ec4899", initials: "ІР", active: true, notes: "Jumping, HIIT" },
  { id: "trn-nazar", name: "Назар", color: "#f43f5e", initials: "НА", active: true, notes: "Дитячі та підліткові групи" },
];

const CLASS_SEED: Array<{
  id: string;
  name: string;
  shortName: string;
  defaultDuration: number;
  trainerIds: string[];
}> = [
  { id: "cls-boxing", name: "Бокс", shortName: "БОКС", defaultDuration: 60, trainerIds: ["trn-liubov", "trn-kostiantyn"] },
  { id: "cls-fitboxing", name: "FITBOXING", shortName: "FITBOX", defaultDuration: 60, trainerIds: ["trn-liubov", "trn-nazar"] },
  { id: "cls-trx", name: "TRX", shortName: "TRX", defaultDuration: 45, trainerIds: ["trn-kostiantyn", "trn-anastasia"] },
  { id: "cls-hiit", name: "HIIT", shortName: "HIIT", defaultDuration: 45, trainerIds: ["trn-valeria", "trn-iryna"] },
  { id: "cls-stretching", name: "Стретчинг", shortName: "СТРЕТЧ", defaultDuration: 45, trainerIds: ["trn-anastasia", "trn-iryna"] },
  { id: "cls-assabs", name: "ASS+ABS", shortName: "ASS+ABS", defaultDuration: 30, trainerIds: ["trn-anastasia", "trn-valeria"] },
  {
    id: "cls-functional",
    name: "Функціональне тренування",
    shortName: "FUNC",
    defaultDuration: 60,
    trainerIds: ["trn-valeria", "trn-kostiantyn"],
  },
  { id: "cls-jumping", name: "Jumping", shortName: "JUMP", defaultDuration: 45, trainerIds: ["trn-iryna", "trn-valeria"] },
  { id: "cls-kids", name: "Бокс дитячий 6–9", shortName: "ДІТИ", defaultDuration: 45, trainerIds: ["trn-nazar"] },
  { id: "cls-teens", name: "Бокс підлітковий 9–12", shortName: "ПІДЛ 9-12", defaultDuration: 60, trainerIds: ["trn-nazar"] },
  { id: "cls-teens12", name: "Бокс підлітковий 12+", shortName: "ПІДЛ 12+", defaultDuration: 60, trainerIds: ["trn-nazar", "trn-liubov"] },
];

const ROOM_SEED: Room[] = [
  { id: "room-main", name: "Головна зала", active: true, sortOrder: 0 },
  { id: "room-boxing", name: "Боксерська зала", active: true, sortOrder: 1 },
  { id: "room-studio", name: "Студія 1", active: true, sortOrder: 2 },
];

interface SeedEvent {
  dayOfWeek: number;
  start: string;
  duration: number;
  classId: string;
  trainerId: string;
  roomId?: string;
  notes?: string;
}

const WEEK: SeedEvent[] = [
  // Понеділок
  { dayOfWeek: 0, start: "08:00", duration: 60, classId: "cls-fitboxing", trainerId: "trn-liubov", roomId: "room-boxing" },
  { dayOfWeek: 0, start: "09:15", duration: 45, classId: "cls-hiit", trainerId: "trn-valeria", roomId: "room-main" },
  { dayOfWeek: 0, start: "10:30", duration: 45, classId: "cls-stretching", trainerId: "trn-anastasia", roomId: "room-studio" },
  { dayOfWeek: 0, start: "17:00", duration: 60, classId: "cls-boxing", trainerId: "trn-liubov", roomId: "room-boxing" },
  { dayOfWeek: 0, start: "18:00", duration: 45, classId: "cls-trx", trainerId: "trn-kostiantyn", roomId: "room-main" },
  { dayOfWeek: 0, start: "18:00", duration: 60, classId: "cls-functional", trainerId: "trn-valeria", roomId: "room-studio" },
  { dayOfWeek: 0, start: "19:15", duration: 30, classId: "cls-assabs", trainerId: "trn-anastasia", roomId: "room-studio" },
  { dayOfWeek: 0, start: "20:00", duration: 60, classId: "cls-teens12", trainerId: "trn-nazar", roomId: "room-boxing" },
  // Вівторок
  { dayOfWeek: 1, start: "07:30", duration: 45, classId: "cls-trx", trainerId: "trn-kostiantyn", roomId: "room-main" },
  { dayOfWeek: 1, start: "09:00", duration: 60, classId: "cls-boxing", trainerId: "trn-kostiantyn", roomId: "room-boxing" },
  { dayOfWeek: 1, start: "11:00", duration: 45, classId: "cls-jumping", trainerId: "trn-iryna", roomId: "room-studio" },
  { dayOfWeek: 1, start: "16:30", duration: 45, classId: "cls-kids", trainerId: "trn-nazar", roomId: "room-boxing" },
  { dayOfWeek: 1, start: "18:00", duration: 45, classId: "cls-hiit", trainerId: "trn-iryna", roomId: "room-main" },
  { dayOfWeek: 1, start: "19:00", duration: 60, classId: "cls-fitboxing", trainerId: "trn-liubov", roomId: "room-boxing" },
  { dayOfWeek: 1, start: "20:15", duration: 45, classId: "cls-stretching", trainerId: "trn-anastasia", roomId: "room-studio" },
  // Середа
  { dayOfWeek: 2, start: "08:00", duration: 60, classId: "cls-boxing", trainerId: "trn-liubov", roomId: "room-boxing" },
  { dayOfWeek: 2, start: "09:30", duration: 45, classId: "cls-stretching", trainerId: "trn-anastasia", roomId: "room-studio" },
  { dayOfWeek: 2, start: "12:00", duration: 30, classId: "cls-assabs", trainerId: "trn-valeria", roomId: "room-main" },
  { dayOfWeek: 2, start: "15:45", duration: 60, classId: "cls-boxing", trainerId: "trn-kostiantyn", roomId: "room-boxing", notes: "Індивідуальна техніка" },
  { dayOfWeek: 2, start: "17:00", duration: 45, classId: "cls-jumping", trainerId: "trn-iryna", roomId: "room-studio" },
  { dayOfWeek: 2, start: "18:30", duration: 60, classId: "cls-functional", trainerId: "trn-valeria", roomId: "room-main" },
  { dayOfWeek: 2, start: "19:45", duration: 45, classId: "cls-trx", trainerId: "trn-anastasia", roomId: "room-studio" },
  // Четвер
  { dayOfWeek: 3, start: "07:15", duration: 45, classId: "cls-hiit", trainerId: "trn-iryna", roomId: "room-main" },
  { dayOfWeek: 3, start: "08:30", duration: 60, classId: "cls-fitboxing", trainerId: "trn-liubov", roomId: "room-boxing" },
  { dayOfWeek: 3, start: "10:30", duration: 45, classId: "cls-stretching", trainerId: "trn-anastasia", roomId: "room-studio" },
  { dayOfWeek: 3, start: "16:00", duration: 45, classId: "cls-teens", trainerId: "trn-nazar", roomId: "room-boxing" },
  { dayOfWeek: 3, start: "19:00", duration: 60, classId: "cls-boxing", trainerId: "trn-kostiantyn", roomId: "room-boxing" },
  { dayOfWeek: 3, start: "19:00", duration: 45, classId: "cls-hiit", trainerId: "trn-valeria", roomId: "room-main" },
  { dayOfWeek: 3, start: "19:00", duration: 30, classId: "cls-assabs", trainerId: "trn-iryna", roomId: "room-studio" },
  { dayOfWeek: 3, start: "20:15", duration: 45, classId: "cls-stretching", trainerId: "trn-anastasia", roomId: "room-studio" },
  // П'ятниця
  { dayOfWeek: 4, start: "08:00", duration: 60, classId: "cls-fitboxing", trainerId: "trn-liubov", roomId: "room-boxing" },
  { dayOfWeek: 4, start: "09:00", duration: 45, classId: "cls-trx", trainerId: "trn-kostiantyn", roomId: "room-main" },
  { dayOfWeek: 4, start: "11:30", duration: 45, classId: "cls-jumping", trainerId: "trn-iryna", roomId: "room-studio" },
  { dayOfWeek: 4, start: "17:30", duration: 60, classId: "cls-boxing", trainerId: "trn-kostiantyn", roomId: "room-boxing" },
  { dayOfWeek: 4, start: "18:45", duration: 30, classId: "cls-assabs", trainerId: "trn-valeria", roomId: "room-studio" },
  { dayOfWeek: 4, start: "19:30", duration: 60, classId: "cls-teens12", trainerId: "trn-nazar", roomId: "room-boxing" },
  // Субота
  { dayOfWeek: 5, start: "09:00", duration: 60, classId: "cls-functional", trainerId: "trn-valeria", roomId: "room-main" },
  { dayOfWeek: 5, start: "10:15", duration: 45, classId: "cls-kids", trainerId: "trn-nazar", roomId: "room-boxing" },
  { dayOfWeek: 5, start: "11:15", duration: 60, classId: "cls-boxing", trainerId: "trn-liubov", roomId: "room-boxing" },
  { dayOfWeek: 5, start: "12:30", duration: 45, classId: "cls-stretching", trainerId: "trn-anastasia", roomId: "room-studio" },
];

export function isSeeded(): boolean {
  const rows = getDb().select().from(appMeta).where(eq(appMeta.key, SEED_MARKER)).limit(1).all();
  return rows.length > 0;
}

/** Seeds realistic Risen Team demo data once per database file. */
export function ensureSeeded(): void {
  if (getDb().$client.pragma("user_version", { simple: true }) === 2) return;
  const db = getDb();
  if (isSeeded()) return;

  const now = new Date();
  const scheduleId = "sched-main";
  const altScheduleId = "sched-summer";

  db.transaction((tx) => {
    tx.insert(appMeta).values({ key: SEED_MARKER, value: now.toISOString() }).onConflictDoNothing().run();

    tx.insert(trainers)
      .values(
        TRAINER_SEED.map((trainer, index) => ({
          ...trainer,
          sortOrder: index,
          notes: trainer.notes ?? null,
          initials: trainer.initials ?? null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();

    tx.insert(classTypes)
      .values(
        CLASS_SEED.map((classType, index) => ({
          id: classType.id,
          name: classType.name,
          shortName: classType.shortName,
          defaultDuration: classType.defaultDuration,
          active: true,
          sortOrder: index,
          color: null,
          description: null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();

    tx.insert(trainerClassTypes)
      .values(CLASS_SEED.flatMap((classType) => classType.trainerIds.map((trainerId) => ({ trainerId, classTypeId: classType.id }))))
      .run();

    tx.insert(rooms).values(ROOM_SEED).run();

    tx.insert(schedules)
      .values([
        {
          id: scheduleId,
          name: "Основний розклад",
          status: "published",
          isActive: true,
          isArchived: false,
          publishedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: altScheduleId,
          name: "Літній розклад",
          status: "draft",
          isActive: false,
          isArchived: false,
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    tx.insert(scheduleSettings)
      .values([
        {
          scheduleId,
          ...DEFAULT_SETTINGS,
          scheduleTitle: "RISEN TEAM",
          scheduleSubtitle: "РОЗКЛАД ТРЕНУВАНЬ",
          customMarkers: ["18:15", "19:45"],
          updatedAt: now,
        },
        {
          scheduleId: altScheduleId,
          ...DEFAULT_SETTINGS,
          scheduleTitle: "RISEN TEAM",
          scheduleSubtitle: "ЛІТНІЙ РОЗКЛАД",
          startTime: "09:00",
          visibleDays: [0, 1, 2, 3, 4],
          updatedAt: now,
        },
      ])
      .run();

    const eventRows = WEEK.map((event, index) => ({
      id: `evt-${event.dayOfWeek}-${index}-${event.start.replace(":", "")}`,
      scheduleId,
      dayOfWeek: event.dayOfWeek,
      startTime: event.start,
      endTime: addMinutesToTime(event.start, event.duration),
      trainerId: event.trainerId,
      classTypeId: event.classId,
      roomId: event.roomId ?? null,
      notes: event.notes ?? null,
      createdAt: now,
      updatedAt: now,
    }));
    tx.insert(scheduleEvents).values(eventRows).run();

    const summerEvents = eventRows
      .filter((event) => event.dayOfWeek < 5 && event.startTime >= "09:00")
      .slice(0, 12)
      .map((event, index) => ({ ...event, id: `summer-${index}-${event.id}`, scheduleId: altScheduleId }));
    if (summerEvents.length > 0) tx.insert(scheduleEvents).values(summerEvents).run();

    const snapshot: SnapshotContent = {
      schemaVersion: 1,
      schedule: { id: scheduleId, name: "Основний розклад", status: "published" },
      settings: {
        ...DEFAULT_SETTINGS,
        scheduleTitle: "RISEN TEAM",
        scheduleSubtitle: "РОЗКЛАД ТРЕНУВАНЬ",
        customMarkers: ["18:15", "19:45"],
      },
      events: eventRows.map((row) => ({
        id: row.id,
        scheduleId,
        dayOfWeek: row.dayOfWeek,
        startTime: row.startTime,
        endTime: row.endTime,
        trainerId: row.trainerId,
        classTypeId: row.classTypeId,
        roomId: row.roomId,
        notes: row.notes,
      })),
      trainers: TRAINER_SEED.map((trainer, index) => ({ ...trainer, sortOrder: index })),
      classTypes: CLASS_SEED.map((classType, index) => ({
        id: classType.id,
        name: classType.name,
        shortName: classType.shortName,
        defaultDuration: classType.defaultDuration,
        color: null,
        description: null,
        active: true,
        sortOrder: index,
        trainerIds: classType.trainerIds,
      })),
      rooms: ROOM_SEED,
    };

    tx.insert(scheduleVersions)
      .values([
        {
          id: "ver-seed",
          scheduleId,
          createdAt: now,
          source: "seed",
          description: "Початковий демонстраційний розклад Risen Team",
          snapshot,
          restoredFromVersionId: null,
        },
        {
          id: "ver-publish",
          scheduleId,
          createdAt: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3),
          source: "publish",
          description: "Опублікована версія — база вересня",
          snapshot,
          restoredFromVersionId: null,
        },
      ])
      .run();
  });
}

export function latestVersionDate(): Date | null {
  const rows = getDb()
    .select({ createdAt: scheduleVersions.createdAt })
    .from(scheduleVersions)
    .orderBy(desc(scheduleVersions.createdAt))
    .limit(1)
    .all();
  return rows[0]?.createdAt ?? null;
}

export function countRows(): number {
  const rows = getDb().select({ value: sql<number>`count(*)` }).from(schedules).all();
  return rows[0]?.value ?? 0;
}

function addMinutesToTime(time: string, minutes: number): string {
  const [hours, mins] = time.split(":").map(Number);
  return minutesToTime(hours * 60 + mins + minutes);
}
