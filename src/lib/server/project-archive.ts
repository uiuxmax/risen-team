import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import { getDb, type AppDatabase } from "@/db";
import { configuredWorkspaceRoot, readProjectManifest } from "@/db/paths";
import { verifyHallSchema, HALL_SCHEMA_VERSION } from "@/db/hall-migration";
import { serializeBackup } from "@/lib/server/backup-serialization";
import { importHalls } from "@/lib/server/halls";
import { AppError } from "@/lib/server/workspace";
import { decodeLogoDataUrl, isLogoReference, readLogoDataUrl, storeLogoDataUrl } from "@/lib/server/assets";
import type { SnapshotContent, ScheduleSettings } from "@/lib/domain/types";

export const MAX_ARCHIVE_COMPRESSED = 32 * 1024 * 1024;
export const MAX_ARCHIVE_UNPACKED = 64 * 1024 * 1024;
const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const base64 = z.string().max(Math.ceil(MAX_DATABASE_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const envelopeSchema = z.object({
  format: z.literal("risen-team-project-archive"), formatVersion: z.literal(1), exportedAt: z.string().datetime(),
  manifest: z.object({ format: z.literal("risen-team-project"), formatVersion: z.literal(1), workspaceId: z.string().uuid(), createdAt: z.string().datetime({ offset: true }) }).strict(),
  database: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), data: base64 }).strict(),
  assets: z.array(z.object({ reference: z.string().max(100), dataUrl: z.string().max(6 * 1024 * 1024) }).strict()).max(1000),
}).strict();

function currentProject() {
  const root = configuredWorkspaceRoot();
  if (!root) throw new AppError("Архів проєкту доступний після відкриття папки проєкту.", 422);
  return { root, manifest: readProjectManifest(root) };
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function archiveError(message: string): never { throw new AppError(message, 422); }

/** Read only tables from a closed consistent backup; never execute SQL from an archive. */
function inspectSnapshot(file: string) {
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma("trusted_schema = OFF"); sqlite.pragma("foreign_keys = ON");
    if (sqlite.pragma("user_version", { simple: true }) !== HALL_SCHEMA_VERSION || sqlite.pragma("quick_check", { simple: true }) !== "ok") archiveError("Пошкоджена або непідтримувана база в архіві.");
    // Views/virtual tables can run code during reads. Only ordinary stored tables
    // are supported; triggers remain inert because the snapshot is read-only.
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='view' OR (type='table' AND upper(sql) LIKE '%VIRTUAL TABLE%') LIMIT 1").get()) archiveError("Архів містить непідтримувану структуру бази.");
    verifyHallSchema(sqlite);
    const backup = serializeBackup(drizzle(sqlite) as AppDatabase);
    const halls = sqlite.prepare("SELECT h.id,h.name,s.id AS scheduleId FROM halls h JOIN schedules s ON s.hall_id=h.id ORDER BY h.id").all() as { id: string; name: string; scheduleId: string }[];
    const packages = halls.map(hall => {
      if (hall.id !== hall.scheduleId) archiveError("Некоректний зв’язок залу й розкладу в архіві.");
      const trainerIds = new Set((sqlite.prepare("SELECT id FROM trainers WHERE hall_id=?").all(hall.id) as {id:string}[]).map(row => row.id));
      const typeIds = new Set((sqlite.prepare("SELECT id FROM class_types WHERE hall_id=?").all(hall.id) as {id:string}[]).map(row => row.id));
      const schedule = backup.schedules.find(row => row.id === hall.scheduleId)!;
      const settings = backup.settings.find(row => row.scheduleId === schedule.id)!;
      const snapshot: SnapshotContent = { schemaVersion: 1, schedule: { id: schedule.id, name: schedule.name, status: schedule.status },
        settings, trainers: backup.trainers.filter(row => trainerIds.has(row.id)), classTypes: backup.classTypes.filter(row => typeIds.has(row.id)),
        events: backup.events.filter(row => row.scheduleId === schedule.id),
        rooms: backup.rooms.filter(room => backup.events.some(event => event.scheduleId === schedule.id && event.roomId === room.id)) };
      return { id: hall.id, name: hall.name, snapshot, versions: backup.versions.filter(row => row.scheduleId === schedule.id).map(({ id, createdAt, source, description, restoredFromVersionId, snapshot }) => ({ id, createdAt, source, description, restoredFromVersionId, snapshot })) };
    });
    const allHallCount = (sqlite.prepare("SELECT count(*) AS n FROM halls").get() as {n:number}).n;
    if (halls.length !== allHallCount) archiveError("Зал без розкладу в архіві.");
    return { app: "risen-team-schedule-builder" as const, formatVersion: 2 as const, exportedAt: new Date().toISOString(), halls: packages };
  } finally { sqlite.close(); }
}

function settingsIn(pkg: ReturnType<typeof inspectSnapshot>): ScheduleSettings[] {
  return pkg.halls.flatMap(hall => [hall.snapshot.settings, ...hall.versions.map(version => version.snapshot.settings)]);
}

/** SQLite backup API includes committed WAL data. Immutable assets are read for
 * exactly the references found in that same backup, never from a newer live state. */
export async function exportProjectArchive(): Promise<Buffer> {
  const { root, manifest } = currentProject();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "risen-project-export-"));
  try {
    const file = path.join(temporary, "project.db");
    await getDb().$client.backup(file);
    const stat = fs.statSync(file);
    if (stat.size > MAX_DATABASE_BYTES) archiveError("База перевищує ліміт архіву 32 MiB.");
    const pkg = inspectSnapshot(file);
    const references = [...new Set(settingsIn(pkg).flatMap(settings => settings.logoDataUrl && isLogoReference(settings.logoDataUrl) ? [settings.logoDataUrl] : []))];
    const assets = references.map(reference => ({ reference, dataUrl: readLogoDataUrl(root, reference) }));
    const bytes = fs.readFileSync(file);
    const json = Buffer.from(JSON.stringify({ format: "risen-team-project-archive", formatVersion: 1, exportedAt: new Date().toISOString(), manifest,
      database: { sha256: sha(bytes), data: bytes.toString("base64") }, assets }));
    if (json.length > MAX_ARCHIVE_UNPACKED) archiveError("Проєкт перевищує ліміт архіву 64 MiB.");
    const compressed = gzipSync(json);
    if (compressed.length > MAX_ARCHIVE_COMPRESSED) archiveError("Стиснений архів перевищує ліміт 32 MiB.");
    return compressed;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** No archive path is extracted. Restore uses the existing transactional hall
 * importer and mandatory safety backup, preserving the target project identity. */
export function restoreProjectArchive(compressed: Buffer) {
  const { root } = currentProject();
  if (!compressed.length || compressed.length > MAX_ARCHIVE_COMPRESSED) archiveError("Некоректний розмір архіву.");
  let raw: unknown;
  try { raw = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_UNPACKED }).toString("utf8")); }
  catch { archiveError("Пошкоджений архів або перевищено ліміт розпакування."); }
  const archive = envelopeSchema.parse(raw);
  const bytes = Buffer.from(archive.database.data, "base64");
  if (!bytes.length || bytes.length > MAX_DATABASE_BYTES || bytes.toString("base64") !== archive.database.data || sha(bytes) !== archive.database.sha256) archiveError("Контрольна сума бази не збігається.");
  const assets = new Map<string, string>();
  for (const asset of archive.assets) {
    if (!isLogoReference(asset.reference) || assets.has(asset.reference)) archiveError("Некоректний або повторюваний ресурс архіву.");
    const decoded = decodeLogoDataUrl(asset.dataUrl);
    if (`assets/logos/${sha(decoded.bytes)}.${decoded.extension}` !== asset.reference) archiveError("Контрольна сума логотипа не збігається.");
    assets.set(asset.reference, asset.dataUrl);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "risen-project-restore-"));
  try {
    const file = path.join(temporary, "project.db"); fs.writeFileSync(file, bytes, { flag: "wx" });
    const pkg = inspectSnapshot(file);
    for (const settings of settingsIn(pkg)) {
      const logo = settings.logoDataUrl;
      if (!logo) continue;
      if (isLogoReference(logo)) {
        const dataUrl = assets.get(logo);
        if (!dataUrl) archiveError("В архіві відсутній логотип, потрібний розкладу або історії.");
        settings.logoDataUrl = dataUrl;
      } else decodeLogoDataUrl(logo);
    }
    // Validate/import creates its mandatory current-project safety backup before
    // changing SQLite. Immutable new asset files can safely outlive a rollback.
    for (const asset of assets.values()) storeLogoDataUrl(root, asset);
    return importHalls(pkg, "replace");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
