import { z } from "zod";

/** Domain types + validation schemas shared by client and server. */

export const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

export const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export const timeSchema = z.string().regex(TIME_PATTERN, "Use 24h time as HH:MM");

export const trainerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, "Name is required").max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour from the palette"),
  initials: z.string().max(4).nullable().optional(),
  notes: z.string().max(400).nullable().optional(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(999),
});

export const classTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, "Name is required").max(60),
  shortName: z.string().min(1, "Short name is required").max(12),
  defaultDuration: z.number().int().min(5).max(600),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  description: z.string().max(400).nullable().optional(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(999),
  trainerIds: z.array(z.string().min(1)),
});

export const roomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, "Name is required").max(60),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(999),
});

export const eventSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeSchema,
  endTime: timeSchema,
  trainerId: z.string().min(1),
  classTypeId: z.string().min(1),
  roomId: z.string().min(1).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const settingsSchema = z.object({
  visibleDays: z.array(z.number().int().min(0).max(6)).min(1, "Keep at least one day visible"),
  startTime: timeSchema,
  endTime: timeSchema,
  defaultInterval: z.number().int().min(5).max(240),
  customMarkers: z.array(timeSchema).max(60),
  snapMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]),
  themeId: z.string().min(1),
  showTrainerLegend: z.boolean(),
  legendPosition: z.enum(["right", "bottom"]),
  showLogo: z.boolean(),
  logoDataUrl: z.string().nullable().optional(),
  scheduleTitle: z.string().max(60),
  scheduleSubtitle: z.string().max(80),
  effectiveDate: z.string().max(40).nullable().optional(),
  exportPaper: z.enum(["original", "a4", "a3", "custom"]),
  exportOrientation: z.enum(["landscape", "portrait"]),
  exportScale: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  customExportWidth: z.number().int().min(600).max(6000),
  customExportHeight: z.number().int().min(400).max(6000),
  autosave: z.boolean(),
});

export const scheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  status: z.enum(["draft", "published"]),
  isActive: z.boolean(),
  isArchived: z.boolean(),
  publishedAt: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});

export type Trainer = z.infer<typeof trainerSchema>;
export type ClassType = z.infer<typeof classTypeSchema>;
export type Room = z.infer<typeof roomSchema>;
export type ScheduleEvent = z.infer<typeof eventSchema>;
export type ScheduleSettings = z.infer<typeof settingsSchema>;
export type Schedule = {
  id: string;
  name: string;
  status: "draft" | "published";
  isActive: boolean;
  isArchived: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface VersionSummary {
  id: string;
  scheduleId: string;
  createdAt: string;
  source: "automatic" | "manual" | "publish" | "restore" | "import" | "seed";
  description: string;
  restoredFromVersionId: string | null;
}

export interface SnapshotContent {
  schemaVersion: 1;
  schedule: { id: string; name: string; status: "draft" | "published" };
  settings: ScheduleSettings;
  events: ScheduleEvent[];
  trainers: Trainer[];
  classTypes: ClassType[];
  rooms: Room[];
}

export interface ScheduleVersion extends VersionSummary {
  snapshot: SnapshotContent;
}

export interface WorkspaceState {
  schedule: Schedule;
  settings: ScheduleSettings;
  events: ScheduleEvent[];
}

export interface Workspace {
  workspaceId?: string;
  hallId?: string;
  revision?: number;
  empty?: boolean;
  schedules: Schedule[];
  activeScheduleId: string;
  trainers: Trainer[];
  classTypes: ClassType[];
  rooms: Room[];
  state: WorkspaceState;
  versions: VersionSummary[];
}

export interface Hall {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  eventCount: number;
  trainerCount: number;
  classTypeCount: number;
}

export interface Conflict {
  id: string;
  severity: "error" | "warning";
  message: string;
  eventIds: string[];
}

export const DEFAULT_SETTINGS: ScheduleSettings = {
  visibleDays: [0, 1, 2, 3, 4, 5],
  startTime: "07:00",
  endTime: "21:00",
  defaultInterval: 60,
  customMarkers: [],
  snapMinutes: 15,
  themeId: "risen-team-dark",
  showTrainerLegend: true,
  legendPosition: "right",
  showLogo: true,
  logoDataUrl: null,
  scheduleTitle: "Risen Team",
  scheduleSubtitle: "Weekly Training Schedule",
  effectiveDate: null,
  exportPaper: "original",
  exportOrientation: "landscape",
  exportScale: 2,
  customExportWidth: 1680,
  customExportHeight: 880,
  autosave: true,
};

export const TRAINER_PALETTE: { name: string; value: string }[] = [
  { name: "Violet", value: "#8b5cf6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Emerald", value: "#22c55e" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Orange", value: "#f97316" },
  { name: "Rose", value: "#f43f5e" },
  { name: "Pink", value: "#ec4899" },
  { name: "Crimson", value: "#dc2626" },
  { name: "Lime", value: "#84cc16" },
  { name: "Cyan", value: "#06b6d4" },
  { name: "Slate", value: "#94a3b8" },
  { name: "Gold", value: "#eab308" },
];
