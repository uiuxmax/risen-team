import { z } from "zod";
import {
  classTypeSchema,
  eventSchema,
  roomSchema,
  settingsSchema,
  trainerSchema,
} from "@/lib/domain/types";

export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  schedule: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["draft", "published"]),
  }),
  settings: settingsSchema,
  events: z.array(eventSchema),
  trainers: z.array(trainerSchema),
  classTypes: z.array(classTypeSchema),
  rooms: z.array(roomSchema),
});

export const saveStateSchema = z.object({
  scheduleId: z.string().min(1),
  events: z.array(eventSchema).max(2000),
  settings: settingsSchema,
  status: z.enum(["draft", "published"]).optional(),
  changeDescription: z.string().max(240).optional(),
  snapshot: z.boolean().optional(),
});

export const versionCreateSchema = z.object({
  scheduleId: z.string().min(1),
  source: z.enum(["manual", "publish", "automatic"]).default("manual"),
  description: z.string().max(240).default("Manual snapshot"),
});

export const restoreSchema = z.object({
  versionId: z.string().min(1),
});

/**
 * Portable backup identity.
 *
 * `BACKUP_APP_ID` is the ONLY application identifier a Risen Team backup may
 * carry. There are no known legacy identifiers: if an older exporter ever used
 * a different id, it must be added to `KNOWN_BACKUP_APPS` explicitly (with a
 * comment explaining which exporter produced it) instead of loosening this
 * check back to an arbitrary string.
 */
export const BACKUP_APP_ID = "risen-team-schedule-builder";
export const BACKUP_SCHEMA_VERSION = 1;
export const KNOWN_BACKUP_APPS: readonly string[] = [BACKUP_APP_ID];

/** ISO-8601 date-time values (as produced by `Date.toISOString()`). */
const isoDateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected a valid ISO date-time string",
});

export const scheduleActionSchema = z.object({
  action: z.enum(["create", "duplicate", "rename", "archive", "unarchive", "activate", "delete"]),
  id: z.string().min(1).optional(),
  name: z.string().max(80).optional(),
  sourceId: z.string().min(1).optional(),
});

export const backupSchema = z.object({
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  exportedAt: isoDateTimeSchema,
  // Exact application identity — arbitrary products must never masquerade as
  // Risen Team backups. (importBackup reports a specific error for this case
  // before the generic shape check below ever runs.)
  app: z.string().refine((value) => (KNOWN_BACKUP_APPS as readonly string[]).includes(value), {
    message: "Unknown backup application identifier",
  }),
  schedules: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      status: z.enum(["draft", "published"]),
      isActive: z.boolean(),
      isArchived: z.boolean(),
      publishedAt: isoDateTimeSchema.nullable(),
    }),
  ),
  trainers: z.array(trainerSchema),
  classTypes: z.array(classTypeSchema),
  rooms: z.array(roomSchema),
  events: z.array(eventSchema),
  settings: z.array(settingsSchema.extend({ scheduleId: z.string().min(1) })),
  versions: z.array(
    z.object({
      id: z.string().min(1),
      scheduleId: z.string().min(1),
      createdAt: isoDateTimeSchema,
      source: z.enum(["automatic", "manual", "publish", "restore", "import", "seed"]),
      description: z.string(),
      restoredFromVersionId: z.string().min(1).nullable(),
      snapshot: snapshotSchema,
    }),
  ),
});

export const trainerPayloadSchema = trainerSchema;
export const classTypePayloadSchema = classTypeSchema;
export const roomPayloadSchema = roomSchema;
