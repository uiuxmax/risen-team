import type { AppDatabase } from "@/db";
import {
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
import type { BackupPayload } from "@/lib/server/backup-types";
import { BACKUP_APP_ID, BACKUP_SCHEMA_VERSION } from "@/lib/server/contracts";
import { isLogoReference, readLogoDataUrl } from "@/lib/server/assets";

/**
 * Serializes an already-open Risen Team database into the portable backup
 * format. This is deliberately independent of `getDb()` so schema migrations
 * can create their mandatory safety copy from the legacy connection without
 * opening a second connection or bypassing the established backup format.
 * Supply the source project root for a standalone JSON backup so every logo
 * (including historical logos) is embedded. Omit it for legacy databases or
 * archive inspection, where references are carried in a separate asset envelope.
 */
export function serializeBackup(db: AppDatabase, projectRoot: string | null = null): BackupPayload {
  const scheduleRows = db.select().from(schedules).all();
  const trainerRows = db.select().from(trainers).all();
  const classTypeRows = db.select().from(classTypes).all();
  const linkRows = db.select().from(trainerClassTypes).all();
  const roomRows = db.select().from(rooms).all();
  const eventRows = db.select().from(scheduleEvents).all();
  const settingsRows = db.select().from(scheduleSettings).all();
  const versionRows = db.select().from(scheduleVersions).all();

  const logos = new Map<string, string>();
  const portableLogo = (value: ScheduleSettings["logoDataUrl"]) => {
    if (!projectRoot || !value || !isLogoReference(value)) return value;
    if (!logos.has(value)) logos.set(value, readLogoDataUrl(projectRoot, value));
    return logos.get(value)!;
  };

  const linksByClassType = new Map<string, string[]>();
  for (const link of linkRows) {
    const list = linksByClassType.get(link.classTypeId);
    if (list) list.push(link.trainerId);
    else linksByClassType.set(link.classTypeId, [link.trainerId]);
  }

  // Import requires one settings row per schedule, so an export must never
  // omit one: a schedule whose settings row is missing (degenerate database)
  // is exported with defaults, exactly as the workspace loader presents it.
  const settingsScheduleIds = new Set(settingsRows.map((row) => row.scheduleId));
  const missingSettingsSchedules = scheduleRows.filter((row) => !settingsScheduleIds.has(row.id));

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: BACKUP_APP_ID,
    schedules: scheduleRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status === "published" ? ("published" as const) : ("draft" as const),
      isActive: row.isActive,
      isArchived: row.isArchived,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    })),
    trainers: trainerRows.map<Trainer>((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      initials: row.initials,
      notes: row.notes,
      active: row.active,
      sortOrder: row.sortOrder,
    })),
    classTypes: classTypeRows.map<ClassType>((row) => ({
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      defaultDuration: row.defaultDuration,
      color: row.color,
      description: row.description,
      active: row.active,
      sortOrder: row.sortOrder,
      trainerIds: linksByClassType.get(row.id) ?? [],
    })),
    rooms: roomRows.map<Room>((row) => ({ id: row.id, name: row.name, active: row.active, sortOrder: row.sortOrder })),
    events: eventRows.map<ScheduleEvent & { scheduleId: string }>((row) => ({
      id: row.id,
      scheduleId: row.scheduleId,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      trainerId: row.trainerId,
      classTypeId: row.classTypeId,
      roomId: row.roomId,
      notes: row.notes,
    })),
    settings: [
      ...settingsRows.map<ScheduleSettings & { scheduleId: string }>((row) => ({
        scheduleId: row.scheduleId,
        visibleDays: (row.visibleDays ?? DEFAULT_SETTINGS.visibleDays).filter((day) => day >= 0 && day <= 6),
        startTime: row.startTime,
        endTime: row.endTime,
        defaultInterval: row.defaultInterval,
        customMarkers: row.customMarkers ?? [],
        snapMinutes: (row.snapMinutes as ScheduleSettings["snapMinutes"]) ?? 15,
        themeId: row.themeId,
        showTrainerLegend: row.showTrainerLegend,
        legendPosition: row.legendPosition === "bottom" ? "bottom" : "right",
        showLogo: row.showLogo,
        logoDataUrl: portableLogo(row.logoDataUrl),
        scheduleTitle: row.scheduleTitle,
        scheduleSubtitle: row.scheduleSubtitle,
        effectiveDate: row.effectiveDate,
        exportPaper: (row.exportPaper as ScheduleSettings["exportPaper"]) ?? "original",
        exportOrientation: row.exportOrientation === "portrait" ? "portrait" : "landscape",
        exportScale: Math.min(4, Math.max(1, row.exportScale)) as 1 | 2 | 3 | 4,
        customExportWidth: row.customExportWidth,
        customExportHeight: row.customExportHeight,
        autosave: row.autosave,
      })),
      ...missingSettingsSchedules.map((row) => ({ scheduleId: row.id, ...DEFAULT_SETTINGS })),
    ],
    versions: versionRows.map((row) => {
      const snapshot = row.snapshot as SnapshotContent;
      return {
        id: row.id,
        scheduleId: row.scheduleId,
        createdAt: row.createdAt.toISOString(),
        source: row.source as BackupPayload["versions"][number]["source"],
        description: row.description,
        restoredFromVersionId: row.restoredFromVersionId,
        snapshot: {
          ...snapshot,
          settings: { ...snapshot.settings, logoDataUrl: portableLogo(snapshot.settings.logoDataUrl) },
        },
      };
    }),
  };
}
