import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getDb, backupsDirectory } from "@/db";
import { DEFAULT_SETTINGS, trainerSchema, classTypeSchema, type Workspace, type SnapshotContent } from "@/lib/domain/types";
import { snapshotSchema, saveStateSchema } from "@/lib/server/contracts";
import { AppError, buildSnapshot, createVersion, loadWorkspace, saveScheduleState, serverTranslate } from "@/lib/server/workspace";
import { validateScheduleState } from "@/lib/schedule/validation";
import { configuredWorkspaceRoot } from "@/db/paths";
import { isLogoReference, normalizeLegacyLogoDataUrl, readLogoDataUrl, storeLogoDataUrl } from "@/lib/server/assets";
import { parseBackupPayload, validateBackupPreflight, emptyPreflightContext } from "@/lib/server/backup-validation";
import { createDemoHallSnapshot, DEMO_HALL_NAME } from "@/lib/schedule/demo-hall";

export function hallsEnabled(): boolean {
  return getDb().$client.pragma("user_version", { simple: true }) === 2;
}
const sqlite = () => getDb().$client;
function hall(id: string) {
  const row = sqlite().prepare("SELECT s.id,s.hall_id,s.revision FROM schedules s WHERE s.hall_id=?").get(id) as { id: string; hall_id: string; revision: number } | undefined;
  if (!row) throw new AppError("Зал більше недоступний.", 404);
  return row;
}
export function assertHallVersionContext(hallId:string,scheduleId?:string,versionId?:string) {
  const owner=hall(hallId);
  if (scheduleId && scheduleId!==owner.id) throw new AppError("Розклад не належить відкритому залу.",422);
  if (versionId && !sqlite().prepare("SELECT 1 FROM schedule_versions WHERE id=? AND schedule_id=?").get(versionId,owner.id)) throw new AppError("Версія не належить відкритому залу.",404);
}
function owned(table: "trainers" | "class_types", id: string, hallId: string, optional = false) {
  const row = sqlite().prepare(`SELECT hall_id FROM ${table} WHERE id=?`).get(id) as { hall_id: string } | undefined;
  if (row && row.hall_id !== hallId || !optional && !row) throw new AppError("Запис не належить цьому залу.", 422);
}
export function loadHallWorkspace(preferred?: string): Workspace {
  const rows = sqlite().prepare("SELECT id FROM halls ORDER BY updated_at DESC,id").all() as { id: string }[];
  const selected = preferred ?? (sqlite().prepare("SELECT value FROM app_meta WHERE key='last_hall'").get() as { value: string } | undefined)?.value;
  if (preferred && !rows.some(r => r.id === preferred)) throw new AppError("Зал більше недоступний.", 404);
  const id = rows.find(r => r.id === selected)?.id ?? rows[0]?.id;
  if (preferred && id) sqlite().prepare("INSERT INTO app_meta(key,value) VALUES('last_hall',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
  if (!id) return { schedules: [], activeScheduleId: "", trainers: [], classTypes: [], rooms: [], versions: [], empty: true, state: { schedule: { id: "", name: "", status: "draft", isActive: false, isArchived: false, publishedAt: null, updatedAt: new Date(0).toISOString() }, settings: { ...DEFAULT_SETTINGS }, events: [] } };
  const result = loadWorkspace(hall(id).id);
  const trainerIds = new Set((sqlite().prepare("SELECT id FROM trainers WHERE hall_id=?").all(id) as { id: string }[]).map(r => r.id));
  const typeIds = new Set((sqlite().prepare("SELECT id FROM class_types WHERE hall_id=?").all(id) as { id: string }[]).map(r => r.id));
  result.trainers = result.trainers.filter(t => trainerIds.has(t.id));
  result.classTypes = result.classTypes.filter(t => typeIds.has(t.id));
  result.rooms = [];
  result.hallId = id;
  result.revision = hall(id).revision;
  return result;
}

export function validateHallSnapshot(snapshot: SnapshotContent) {
  const ids = (rows: { id: string }[]) => { const set = new Set(rows.map(r => r.id)); if (set.size !== rows.length) throw new AppError("Повторювані ID у файлі залу.", 422); return set; };
  const trainers = ids(snapshot.trainers), types = ids(snapshot.classTypes); ids(snapshot.events); ids(snapshot.rooms);
  for (const c of snapshot.classTypes) if (new Set(c.trainerIds).size !== c.trainerIds.length || c.trainerIds.some(id => !trainers.has(id))) throw new AppError("Пошкоджені зв’язки тренерів.", 422);
  for (const e of snapshot.events) if (e.scheduleId !== snapshot.schedule.id || !trainers.has(e.trainerId) || !types.has(e.classTypeId)) throw new AppError("Заняття посилається на інший зал.", 422);
  for (const event of snapshot.events) {
    if (!snapshot.classTypes.find(type => type.id === event.classTypeId)?.trainerIds.includes(event.trainerId)) throw new AppError("Тип заняття не дозволений цьому тренеру.",422);
  }
  const validation = validateScheduleState(snapshot, serverTranslate);
  if (!validation.valid) throw new AppError(validation.errors.map(e => e.message).join(" "), 422);
}
export function saveHallState(raw: unknown) {
  const input = saveStateSchema.extend({ hallId: z.string().min(1), revision: z.number().int().nonnegative() }).parse(raw);
  if (input.events.some(event => event.roomId)) throw new AppError("Окреме поле залу в занятті більше не підтримується.",422);
  const s = hall(input.hallId);
  if (s.id !== input.scheduleId) throw new AppError("Розклад іншого залу.", 422);
  return sqlite().transaction(() => {
    if (hall(input.hallId).revision !== input.revision) throw new AppError("Зал змінено в іншій вкладці. Збережіть локальну копію та оновіть дані.", 409);
    const current = loadHallWorkspace(input.hallId);
    const previous = new Map(current.state.events.map(e => [e.id, e]));
    for (const event of input.events) {
      const trainer = current.trainers.find(t => t.id === event.trainerId);
      const type = current.classTypes.find(t => t.id === event.classTypeId);
      const old = previous.get(event.id);
      const unchangedAssignment = old?.trainerId === event.trainerId && old?.classTypeId === event.classTypeId;
      if (!trainer || !type || event.scheduleId !== s.id || (!unchangedAssignment && (!trainer.active || !type.active || !type.trainerIds.includes(trainer.id)))) throw new AppError("Оберіть активного тренера та дозволений тип заняття цього залу.", 422);
    }
    const result = saveScheduleState(input);
    sqlite().prepare("UPDATE schedules SET revision=revision+1 WHERE id=?").run(s.id);
    sqlite().prepare("UPDATE halls SET updated_at=? WHERE id=?").run(Date.now(), input.hallId);
    return { ...result, revision: input.revision + 1 };
  })();
}

const portableVersionSchema = z.object({ id: z.string().min(1), createdAt: z.string().datetime(), description: z.string().max(240), source:z.enum(["automatic","manual","publish","restore","import","seed"]).default("import"), restoredFromVersionId:z.string().nullable().default(null), snapshot: snapshotSchema });
type PortableVersion = z.infer<typeof portableVersionSchema>;
const portableHallSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(80), snapshot: snapshotSchema, versions: z.array(portableVersionSchema).max(10000) });
const packageSchema = z.object({ app: z.literal("risen-team-schedule-builder"), formatVersion: z.literal(2), exportedAt: z.string().datetime(), halls: z.array(portableHallSchema).max(1000) });
function portableSnapshot(snapshot:SnapshotContent):SnapshotContent {
  const logo=snapshot.settings.logoDataUrl;
  if (!logo || !isLogoReference(logo)) return snapshot;
  const root=configuredWorkspaceRoot();
  if (!root) throw new AppError("Папка проєкту потрібна для читання логотипа.",422);
  return {...snapshot,settings:{...snapshot.settings,logoDataUrl:readLogoDataUrl(root,logo)}};
}
/** Normalize incoming legacy SVG before the synchronous transactional importer.
 * Portable packages cannot borrow references from the destination project. */
export async function normalizeHallPackageLogos(raw:unknown):Promise<unknown> {
  const pkg=packageSchema.parse(convertLegacyHallPackage(raw));
  const normalized=new Map<string,string>();
  for (const hall of pkg.halls) for (const snapshot of [hall.snapshot,...hall.versions.map(version => version.snapshot)]) {
    const logo=snapshot.settings.logoDataUrl;
    if (!logo) continue;
    if (isLogoReference(logo)) throw new AppError("Обмінний файл повинен містити сам логотип, а не локальне посилання.",422);
    if (!normalized.has(logo)) normalized.set(logo,await normalizeLegacyLogoDataUrl(logo));
    snapshot.settings.logoDataUrl=normalized.get(logo)!;
  }
  return pkg;
}
export function exportHalls(selected?: string[]) {
  const rows = sqlite().prepare("SELECT id,name FROM halls ORDER BY id").all() as { id: string; name: string }[];
  if (selected?.some(id => !rows.some(r => r.id === id))) throw new AppError("Невідомий зал.", 404);
  return { app: "risen-team-schedule-builder" as const, formatVersion: 2 as const, exportedAt: new Date().toISOString(), halls: rows.filter(r => !selected || selected.includes(r.id)).map(r => ({ ...r, snapshot: portableSnapshot(buildSnapshot(r.id)), versions: (sqlite().prepare("SELECT id,created_at,description,source,restored_from_version_id,snapshot FROM schedule_versions WHERE schedule_id=? ORDER BY created_at").all(r.id) as { id: string; created_at: number; description: string;source:PortableVersion["source"];restored_from_version_id:string|null; snapshot: string }[]).map(v => ({ id: v.id, createdAt: new Date(v.created_at).toISOString(), description: v.description,source:v.source,restoredFromVersionId:v.restored_from_version_id, snapshot: portableSnapshot(JSON.parse(v.snapshot) as SnapshotContent) })) })) };
}
export function requireHallBackup(reason: string): string {
  const dir = backupsDirectory();
  const file = path.join(dir, `risen-team-halls-${Date.now()}-${crypto.randomUUID()}.json`);
  const temp = file + ".tmp";
  try { fs.mkdirSync(dir, { recursive: true }); const fd = fs.openSync(temp, "wx"); try { fs.writeFileSync(fd, JSON.stringify({ ...exportHalls(), reason })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file);
    // Rotate only this writer's completed automatic files. Migration images,
    // manual exports and incomplete files remain untouched.
    const completed=fs.readdirSync(dir).filter(name => name !== path.basename(file) && /^risen-team-halls-\d+-[a-f0-9-]+\.json$/.test(name)).sort();
    for (const name of completed.slice(0,Math.max(0,completed.length-9))) { try { fs.unlinkSync(path.join(dir,name)); } catch { /* A completed safety copy still protects this operation. */ } }
    return file; }
  catch { try { fs.unlinkSync(temp); } catch {} throw new AppError("Не вдалося створити резервну копію. Дані не змінено.", 503); }
}
function removeHall(id: string) {
  hall(id);
  const db = sqlite();
  db.prepare("DELETE FROM schedule_versions WHERE schedule_id=?").run(id);
  db.prepare("DELETE FROM schedule_events WHERE schedule_id=?").run(id);
  db.prepare("DELETE FROM schedule_settings WHERE schedule_id=?").run(id);
  db.prepare("DELETE FROM schedules WHERE hall_id=?").run(id);
  db.prepare("DELETE FROM trainer_class_types WHERE trainer_id IN (SELECT id FROM trainers WHERE hall_id=?)").run(id);
  db.prepare("DELETE FROM trainers WHERE hall_id=?").run(id);
  db.prepare("DELETE FROM class_types WHERE hall_id=?").run(id);
  db.prepare("DELETE FROM halls WHERE id=?").run(id);
}
function insertHall(name: string, source?: SnapshotContent, targetId?: string, versions:PortableVersion[] = []) {
  const db = sqlite(), id = targetId ?? crypto.randomUUID(), now = Date.now();
  db.prepare("INSERT INTO halls(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(id, name, now, now);
  db.prepare("INSERT INTO schedules(id,hall_id,name,status,is_active,is_archived,created_at,updated_at,revision) VALUES(?,?,?,'draft',0,0,?,?,0)").run(id,id,name,now,now);
  const snapshots = [source,...versions.map(version => version.snapshot)].filter((snapshot):snapshot is SnapshotContent => !!snapshot);
  const trainerIds = new Map(snapshots.flatMap(snapshot => snapshot.trainers.map(t => [t.id, crypto.randomUUID()] as const)));
  const classIds = new Map(snapshots.flatMap(snapshot => snapshot.classTypes.map(t => [t.id, crypto.randomUUID()] as const)));
  const eventIds = new Map(snapshots.flatMap(snapshot => snapshot.events.map(event => [event.id,crypto.randomUUID()] as const)));
  const remap = (snapshot:SnapshotContent):SnapshotContent => ({...snapshot,schedule:{...snapshot.schedule,id},trainers:snapshot.trainers.map(t => ({...t,id:trainerIds.get(t.id)!})),classTypes:snapshot.classTypes.map(t => ({...t,id:classIds.get(t.id)!,trainerIds:t.trainerIds.map(trainer => trainerIds.get(trainer)!)})),events:snapshot.events.map(event => ({...event,id:eventIds.get(event.id)!,scheduleId:id,trainerId:trainerIds.get(event.trainerId)!,classTypeId:classIds.get(event.classTypeId)!,roomId:null})),rooms:[]});
  for (const t of source?.trainers ?? []) db.prepare("INSERT INTO trainers(id,hall_id,name,color,initials,notes,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(trainerIds.get(t.id),id,t.name,t.color,t.initials??null,t.notes??null,+t.active,t.sortOrder,now,now);
  for (const t of source?.classTypes ?? []) { db.prepare("INSERT INTO class_types(id,hall_id,name,short_name,default_duration,color,description,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(classIds.get(t.id),id,t.name,t.shortName,t.defaultDuration,t.color??null,t.description??null,+t.active,t.sortOrder,now,now); for (const trainerId of t.trainerIds) db.prepare("INSERT INTO trainer_class_types(trainer_id,class_type_id) VALUES(?,?)").run(trainerIds.get(trainerId),classIds.get(t.id)); }
  // Historical metadata stays inside snapshots. Only an explicit restore may
  // recreate deleted catalog rows; importing must not resurrect them in lists.
  const settings = source?.settings ?? { ...DEFAULT_SETTINGS, scheduleSubtitle: "РОЗКЛАД ТРЕНУВАНЬ" };
  // Existing settings serializer owns the SQL column mapping; empty save makes the first checkpoint.
  saveScheduleState({ scheduleId: id, settings, events: (source?.events ?? []).map(e => ({ ...e, id: eventIds.get(e.id)!, scheduleId: id, trainerId: trainerIds.get(e.trainerId), classTypeId: classIds.get(e.classTypeId), roomId: null })), snapshot: true, changeDescription: source ? "Зал скопійовано" : "Зал створено" });
  const versionIds = new Map(versions.map(version => [version.id,crypto.randomUUID()]));
  for (const version of versions) db.prepare("INSERT INTO schedule_versions(id,schedule_id,created_at,source,description,snapshot,restored_from_version_id) VALUES(?,?,?,?,?,?,NULL)").run(versionIds.get(version.id),id,Date.parse(version.createdAt),version.source,version.description,JSON.stringify(remap(version.snapshot)));
  for (const version of versions) if (version.restoredFromVersionId) db.prepare("UPDATE schedule_versions SET restored_from_version_id=? WHERE id=?").run(versionIds.get(version.restoredFromVersionId),versionIds.get(version.id));
  return id;
}
export function hallAction(raw: unknown) {
  const body = z.object({ action: z.enum(["create","template","duplicate","rename","delete","activate"]), id: z.string().optional(), sourceId: z.string().optional(), name: z.string().trim().min(1).max(80).optional(), withoutEvents: z.boolean().optional() }).parse(raw);
  if (body.action === "delete") requireHallBackup("delete-hall");
  return sqlite().transaction(() => {
    let id = body.id;
    if (body.action === "create") id = insertHall(body.name ?? "Новий зал");
    else if (body.action === "template") {
      const source = createDemoHallSnapshot();
      validateHallSnapshot(source);
      const names = new Set((sqlite().prepare("SELECT name FROM halls").all() as {name:string}[]).map(row => row.name));
      const base = body.name ?? DEMO_HALL_NAME;
      let name = base, index = 2;
      while (names.has(name)) {
        const suffix = ` (${index++})`;
        name = `${base.slice(0,80-suffix.length)}${suffix}`;
      }
      id = insertHall(name, source);
      sqlite().prepare("UPDATE schedule_versions SET description=? WHERE schedule_id=?").run("Створено демонстраційний зал із готовим розкладом",id);
    }
    else if (body.action === "duplicate") { const source = buildSnapshot(hall(body.sourceId ?? body.id ?? "").id); if (body.withoutEvents) source.events = []; id = insertHall(body.name ?? `${source.schedule.name} — копія`, source); }
    else if (body.action === "delete") { removeHall(id ?? ""); id = undefined; }
    else { hall(id ?? ""); if (body.action === "rename") { if (!body.name) throw new AppError("Вкажіть назву залу.",422); sqlite().prepare("UPDATE halls SET name=?,updated_at=? WHERE id=?").run(body.name,Date.now(),id); sqlite().prepare("UPDATE schedules SET name=?,revision=revision+1,updated_at=? WHERE id=?").run(body.name,Date.now(),id); } }
    if (id) sqlite().prepare("INSERT INTO app_meta(key,value) VALUES('last_hall',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
    return { activeScheduleId: id ?? null };
  })();
}
export function importHalls(raw: unknown, mode: "merge" | "replace" = "merge", targetId?: string) {
  const pkg = packageSchema.parse(convertLegacyHallPackage(raw));
  if (new Set(pkg.halls.map(h => h.id)).size !== pkg.halls.length) throw new AppError("Повторювані зали.",422);
  for (const h of pkg.halls) { if (h.id !== h.snapshot.schedule.id) throw new AppError("Некоректний ID залу.",422); validateHallSnapshot(h.snapshot); const versionIds = new Set(h.versions.map(version => version.id)); if (versionIds.size !== h.versions.length) throw new AppError("Повторювані версії.",422); for (const v of h.versions) { if (v.snapshot.schedule.id !== h.id || v.restoredFromVersionId && (!versionIds.has(v.restoredFromVersionId) || v.restoredFromVersionId === v.id)) throw new AppError("Історія іншого залу або пошкоджене посилання версії.",422); validateHallSnapshot(v.snapshot); } }
  if (targetId && mode !== "replace") throw new AppError("Зіставлення залу доступне лише для заміни.",422);
  if (targetId) { hall(targetId); if (pkg.halls.length !== 1) throw new AppError("Для заміни виберіть один зал.",422); }
  const root=configuredWorkspaceRoot();
  for (const hall of pkg.halls) for (const snapshot of [hall.snapshot,...hall.versions.map(version => version.snapshot)]) {
    const logo=snapshot.settings.logoDataUrl;
    if (!logo) continue;
    if (isLogoReference(logo)) throw new AppError("Обмінний файл повинен містити сам логотип, а не локальне посилання.",422);
    if (root) storeLogoDataUrl(root,logo);
  }
  const safetyBackup = requireHallBackup("import-halls");
  sqlite().transaction(() => {
    const previousRevision=targetId ? hall(targetId).revision : undefined;
    if (mode === "replace") { const ids = targetId ? [targetId] : (sqlite().prepare("SELECT id FROM halls").all() as {id:string}[]).map(h => h.id); for (const id of ids) removeHall(id); }
    for (const h of pkg.halls) {
      const versions=h.versions.map(version => {
        const logo=version.snapshot.settings.logoDataUrl;
        return root && logo ? {...version,snapshot:{...version.snapshot,settings:{...version.snapshot.settings,logoDataUrl:storeLogoDataUrl(root,logo)}}} : version;
      });
      insertHall(h.name, h.snapshot, targetId,versions);
    }
    if (targetId) sqlite().prepare("UPDATE schedules SET revision=? WHERE hall_id=?").run(previousRevision!+1,targetId);
  })();
  return { schedules: pkg.halls.length, events: pkg.halls.reduce((n,h) => n+h.snapshot.events.length,0), mode, safetyBackup };
}

/** Old JSON is a complete shared-catalog graph, converted before any writes. */
function convertLegacyHallPackage(raw:unknown):unknown {
  if (!raw || typeof raw !== "object" || !("schemaVersion" in raw)) return raw;
  const backup = parseBackupPayload(raw);
  validateBackupPreflight(backup,"replace",emptyPreflightContext());
  const explicitEligibility = (snapshot:SnapshotContent):SnapshotContent => ({...snapshot,classTypes:snapshot.classTypes.map(type => ({...type,trainerIds:[...new Set([...(type.trainerIds.length ? type.trainerIds : snapshot.trainers.map(trainer => trainer.id)),...snapshot.events.filter(event => event.classTypeId===type.id).map(event => event.trainerId)])]}))});
  return {app:backup.app,formatVersion:2,exportedAt:backup.exportedAt,halls:backup.schedules.map(schedule => {
    const settings = backup.settings.find(settings => settings.scheduleId === schedule.id)!;
    return {id:schedule.id,name:schedule.name,snapshot:explicitEligibility({schemaVersion:1,schedule:{id:schedule.id,name:schedule.name,status:schedule.status},settings,events:backup.events.filter(event => event.scheduleId === schedule.id),trainers:backup.trainers,classTypes:backup.classTypes,rooms:backup.rooms}),versions:backup.versions.filter(version => version.scheduleId === schedule.id).map(version => ({...version,restoredFromVersionId:backup.versions.some(target => target.id === version.restoredFromVersionId && target.scheduleId === schedule.id) ? version.restoredFromVersionId : null,snapshot:explicitEligibility(version.snapshot)}))};
  })};
}

export function mutateHallCatalog(hallId: string, entity: "trainers" | "class_types", raw: unknown) {
  hall(hallId);
  return sqlite().transaction(() => {
    const now = Date.now(), db = sqlite();
    if (entity === "trainers") {
      const p = z.object({ trainer: trainerSchema, classTypeIds: z.array(z.string().min(1)).max(500) }).parse(raw), t = p.trainer;
      owned(entity,t.id,hallId,true); for (const id of p.classTypeIds) owned("class_types",id,hallId);
      const assigned = db.prepare("SELECT DISTINCT class_type_id id FROM schedule_events WHERE trainer_id=?").all(t.id) as {id:string}[];
      if (assigned.some(type => !p.classTypeIds.includes(type.id))) throw new AppError("Спочатку видаліть або перепризначте заняття цього тренера, щоб прибрати дозвіл на їхній тип.",422);
      db.prepare("INSERT INTO trainers(id,hall_id,name,color,initials,notes,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,initials=excluded.initials,notes=excluded.notes,active=excluded.active,sort_order=excluded.sort_order,updated_at=excluded.updated_at").run(t.id,hallId,t.name,t.color,t.initials??null,t.notes??null,+t.active,t.sortOrder,now,now);
      db.prepare("DELETE FROM trainer_class_types WHERE trainer_id=?").run(t.id);
      for (const id of new Set(p.classTypeIds)) db.prepare("INSERT INTO trainer_class_types(trainer_id,class_type_id) VALUES(?,?)").run(t.id,id);
      return t;
    }
    const t = classTypeSchema.parse(raw); owned(entity,t.id,hallId,true); for (const id of t.trainerIds) owned("trainers",id,hallId);
    const assigned = db.prepare("SELECT DISTINCT trainer_id id FROM schedule_events WHERE class_type_id=?").all(t.id) as {id:string}[];
    if (assigned.some(trainer => !t.trainerIds.includes(trainer.id))) throw new AppError("Спочатку видаліть або перепризначте заняття цього типу, щоб прибрати дозвіл тренера.",422);
    db.prepare("INSERT INTO class_types(id,hall_id,name,short_name,default_duration,color,description,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,short_name=excluded.short_name,default_duration=excluded.default_duration,color=excluded.color,description=excluded.description,active=excluded.active,sort_order=excluded.sort_order,updated_at=excluded.updated_at").run(t.id,hallId,t.name,t.shortName,t.defaultDuration,t.color??null,t.description??null,+t.active,t.sortOrder,now,now);
    db.prepare("DELETE FROM trainer_class_types WHERE class_type_id=?").run(t.id);
    for (const id of new Set(t.trainerIds)) db.prepare("INSERT INTO trainer_class_types(trainer_id,class_type_id) VALUES(?,?)").run(id,t.id);
    return t;
  })();
}
export function deleteHallCatalog(hallId: string, entity: "trainers" | "class_types", id: string, expectedRevision?: number) {
  const owner = hall(hallId); owned(entity,id,hallId);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== owner.revision)) throw new AppError("Зал змінено або сторінка застаріла. Оновіть дані та перевірте видалення ще раз.",409);
  requireHallBackup(`delete-${entity}`);
  return sqlite().transaction(() => {
    const db = sqlite(), now = Date.now(), column = entity === "trainers" ? "trainer_id" : "class_type_id";
    createVersion({scheduleId:owner.id,source:"manual",description:entity === "trainers" ? "Перед видаленням тренера та його занять" : "Перед видаленням типу заняття та пов’язаних занять"});
    const deletedEvents = db.prepare(`DELETE FROM schedule_events WHERE schedule_id=? AND ${column}=?`).run(owner.id,id).changes;
    db.prepare(`DELETE FROM trainer_class_types WHERE ${column}=?`).run(id);
    db.prepare(`DELETE FROM ${entity} WHERE id=? AND hall_id=?`).run(id,hallId);
    db.prepare("UPDATE schedules SET revision=revision+1,updated_at=? WHERE id=?").run(now,owner.id);
    db.prepare("UPDATE halls SET updated_at=? WHERE id=?").run(now,hallId);
    return { deactivated: false, deletedEvents, revision: hall(hallId).revision };
  })();
}
export function reorderHallCatalog(hallId: string, raw: unknown) {
  hall(hallId); const p = z.object({ entity: z.enum(["trainers","classTypes"]), order: z.array(z.string().min(1)).max(1000) }).parse(raw);
  const table = p.entity === "trainers" ? "trainers" : "class_types";
  if (new Set(p.order).size !== p.order.length) throw new AppError("Повторювані ID.",422);
  for (const id of p.order) owned(table,id,hallId);
  sqlite().transaction(() => { p.order.forEach((id,i) => sqlite().prepare(`UPDATE ${table} SET sort_order=? WHERE id=? AND hall_id=?`).run(i,id,hallId)); })();
  return { ok: true };
}

export function restoreHallVersion(hallId: string, versionId: string) {
  const s = hall(hallId);
  const row = sqlite().prepare("SELECT snapshot FROM schedule_versions WHERE id=? AND schedule_id=?").get(versionId,s.id) as {snapshot:string}|undefined;
  if (!row) throw new AppError("Версія не належить відкритому залу.",404);
  const snapshot = portableSnapshot(snapshotSchema.parse(JSON.parse(row.snapshot)));
  if (snapshot.schedule.id!==s.id) throw new AppError("Пошкоджений контекст знімка залу.",422);
  validateHallSnapshot(snapshot);
  // References must still belong to this hall, even for imported historical snapshots.
  for (const t of snapshot.trainers) owned("trainers",t.id,hallId,true);
  for (const c of snapshot.classTypes) owned("class_types",c.id,hallId,true);
  requireHallBackup("restore-hall-version");
  return sqlite().transaction(() => {
    const db = sqlite(), now = Date.now();
    // Catalog deletes are real deletes. Frozen historical metadata lets an
    // explicit restore recreate missing dependencies without changing another
    // hall or overwriting the current names/colors of surviving entries.
    for (const t of snapshot.trainers) db.prepare("INSERT OR IGNORE INTO trainers(id,hall_id,name,color,initials,notes,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(t.id,hallId,t.name,t.color,t.initials??null,t.notes??null,+t.active,t.sortOrder,now,now);
    for (const c of snapshot.classTypes) {
      db.prepare("INSERT OR IGNORE INTO class_types(id,hall_id,name,short_name,default_duration,color,description,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(c.id,hallId,c.name,c.shortName,c.defaultDuration,c.color??null,c.description??null,+c.active,c.sortOrder,now,now);
      for (const trainerId of c.trainerIds) db.prepare("INSERT OR IGNORE INTO trainer_class_types(trainer_id,class_type_id) VALUES(?,?)").run(trainerId,c.id);
    }
    saveScheduleState({scheduleId:s.id,events:snapshot.events,settings:snapshot.settings});
    sqlite().prepare("UPDATE schedules SET revision=revision+1 WHERE id=?").run(s.id);
    sqlite().prepare("UPDATE halls SET updated_at=? WHERE id=?").run(Date.now(),hallId);
    const version = createVersion({scheduleId:s.id,source:"restore",description:"Відновлено попередню версію залу",restoredFromVersionId:versionId});
    return {scheduleId:s.id,version};
  })();
}
