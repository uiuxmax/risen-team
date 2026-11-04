import type { ClassType, Room, ScheduleEvent, ScheduleSettings, SnapshotContent, Trainer } from "@/lib/domain/types";

/** Portable workspace backup (schemaVersion 1) — also the local safety-backup shape. */
export interface BackupPayload {
  schemaVersion: 1;
  exportedAt: string;
  app: string;
  schedules: {
    id: string;
    name: string;
    status: "draft" | "published";
    isActive: boolean;
    isArchived: boolean;
    publishedAt: string | null;
  }[];
  trainers: Trainer[];
  classTypes: ClassType[];
  rooms: Room[];
  events: (ScheduleEvent & { scheduleId: string })[];
  settings: (ScheduleSettings & { scheduleId: string })[];
  versions: {
    id: string;
    scheduleId: string;
    createdAt: string;
    source: "automatic" | "manual" | "publish" | "restore" | "import" | "seed";
    description: string;
    restoredFromVersionId: string | null;
    snapshot: SnapshotContent;
  }[];
}
