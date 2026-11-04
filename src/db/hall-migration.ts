import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backupsDirectoryForDatabase } from "@/db/paths";
import { initializeDatabaseSchema, readSchemaVersion, ensureForeignKeysEnabled, verifyLatestSchema } from "@/db/migrations";

/** Independent technical versions; these never follow the marketing version. */
export const HALL_SCHEMA_VERSION = 2;
export const HALL_EXCHANGE_VERSION = 2;
export const HALL_SNAPSHOT_VERSION = 1;

type Row = Record<string, string | number | null>;
const TABLES = ["app_meta", "schedules", "trainers", "class_types", "rooms", "trainer_class_types", "schedule_events", "schedule_settings", "schedule_versions"] as const;

export class HallMigrationRequiredError extends Error {
  readonly code = "hall-migration-required";
  constructor() { super("Потрібне підтвердження перенесення старих розкладів у незалежні зали."); }
}

/** Read-only preview: callers can open an existing file with readonly:true. */
export function previewHallMigration(sqlite: Database.Database) {
  const schemaVersion = readSchemaVersion(sqlite);
  if (schemaVersion > HALL_SCHEMA_VERSION) throw new Error("This project requires a newer Risen Team version.");
  const schedules = (sqlite.prepare("SELECT id,name FROM schedules ORDER BY created_at,id").all() as {id:string;name:string}[]).map((schedule) => {
    const events = sqlite.prepare("SELECT room_id FROM schedule_events WHERE schedule_id=?").all(schedule.id) as {room_id:string|null}[];
    const eligibilityMismatches = (sqlite.prepare("SELECT count(*) n FROM schedule_events e WHERE e.schedule_id=? AND EXISTS(SELECT 1 FROM trainer_class_types x WHERE x.class_type_id=e.class_type_id) AND NOT EXISTS(SELECT 1 FROM trainer_class_types x WHERE x.class_type_id=e.class_type_id AND x.trainer_id=e.trainer_id)").get(schedule.id) as {n:number}).n;
    return { ...schedule, eventCount: events.length, roomIds: [...new Set(events.flatMap((event) => event.room_id ? [event.room_id] : []))], unassignedEvents: events.filter((event) => !event.room_id).length, eligibilityMismatches };
  });
  return {
    schemaVersion, schedules,
    trainerCount: (sqlite.prepare("SELECT count(*) AS n FROM trainers").get() as {n:number}).n,
    classTypeCount: (sqlite.prepare("SELECT count(*) AS n FROM class_types").get() as {n:number}).n,
    requiresConfirmation: schemaVersion < HALL_SCHEMA_VERSION && TABLES.some((table) => table !== "app_meta" && (sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() != null)),
    policy: "one-hall-per-schedule" as const,
    notice: "Кожен старий розклад стане окремим залом. Довідники будуть незалежно скопійовані. Фактичні старі призначення та неявні дозволи стануть явними дозволами; кількість невідповідностей наведена вище. Старі roomId та оригінальна історія зберігаються в архіві міграції.",
  };
}

const GUARDS = `
CREATE TRIGGER hall_event_insert BEFORE INSERT ON schedule_events BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM schedules s JOIN trainers t ON t.hall_id=s.hall_id JOIN class_types c ON c.hall_id=s.hall_id WHERE s.id=NEW.schedule_id AND t.id=NEW.trainer_id AND c.id=NEW.class_type_id) THEN RAISE(ABORT,'cross-hall event reference') END;
END;
CREATE TRIGGER hall_event_update BEFORE UPDATE ON schedule_events BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM schedules s JOIN trainers t ON t.hall_id=s.hall_id JOIN class_types c ON c.hall_id=s.hall_id WHERE s.id=NEW.schedule_id AND t.id=NEW.trainer_id AND c.id=NEW.class_type_id) THEN RAISE(ABORT,'cross-hall event reference') END;
END;
CREATE TRIGGER hall_link_insert BEFORE INSERT ON trainer_class_types BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM trainers t JOIN class_types c ON c.hall_id=t.hall_id WHERE t.id=NEW.trainer_id AND c.id=NEW.class_type_id) THEN RAISE(ABORT,'cross-hall eligibility reference') END;
END;
CREATE TRIGGER hall_link_update BEFORE UPDATE ON trainer_class_types BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM trainers t JOIN class_types c ON c.hall_id=t.hall_id WHERE t.id=NEW.trainer_id AND c.id=NEW.class_type_id) THEN RAISE(ABORT,'cross-hall eligibility reference') END;
END;
CREATE TRIGGER hall_version_insert BEFORE INSERT ON schedule_versions WHEN NEW.restored_from_version_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM schedule_versions v WHERE v.id=NEW.restored_from_version_id AND v.schedule_id=NEW.schedule_id) THEN RAISE(ABORT,'cross-hall version reference') END;
END;
CREATE TRIGGER hall_version_update BEFORE UPDATE ON schedule_versions WHEN NEW.restored_from_version_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM schedule_versions v WHERE v.id=NEW.restored_from_version_id AND v.schedule_id=NEW.schedule_id) THEN RAISE(ABORT,'cross-hall version reference') END;
END;
${["schedules", "trainers", "class_types"].map((table) => `CREATE TRIGGER hall_${table}_owner BEFORE UPDATE OF hall_id ON ${table} WHEN NEW.hall_id <> OLD.hall_id BEGIN SELECT RAISE(ABORT,'hall ownership is immutable'); END;`).join("\n")}
`;

export function verifyHallSchema(sqlite: Database.Database): void {
  ensureForeignKeysEnabled(sqlite);
  for (const table of ["schedules", "trainers", "class_types"]) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as {name:string;notnull:number}[];
    if (!columns.some((column) => column.name === "hall_id" && column.notnull === 1)) throw new Error(`Missing required hall ownership: ${table}`);
    const references = sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as {from:string;table:string;to:string}[];
    if (!references.some(reference => reference.from === "hall_id" && reference.table === "halls" && reference.to === "id")) throw new Error(`Missing hall ownership foreign key: ${table}`);
    if (sqlite.prepare(`SELECT 1 FROM ${table} x LEFT JOIN halls h ON h.id=x.hall_id WHERE h.id IS NULL LIMIT 1`).get()) throw new Error(`Orphan hall owner: ${table}`);
  }
  if (sqlite.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Hall project foreign key check failed.");
  if (sqlite.prepare("SELECT 1 FROM schedule_events e JOIN schedules s ON s.id=e.schedule_id JOIN trainers t ON t.id=e.trainer_id JOIN class_types c ON c.id=e.class_type_id WHERE s.hall_id<>t.hall_id OR s.hall_id<>c.hall_id LIMIT 1").get()) throw new Error("Cross-hall event data found.");
  if (sqlite.prepare("SELECT 1 FROM trainer_class_types x JOIN trainers t ON t.id=x.trainer_id JOIN class_types c ON c.id=x.class_type_id WHERE t.hall_id<>c.hall_id LIMIT 1").get()) throw new Error("Cross-hall eligibility data found.");
  if (sqlite.prepare("SELECT 1 FROM schedule_versions v JOIN schedule_versions source ON source.id=v.restored_from_version_id WHERE source.schedule_id<>v.schedule_id LIMIT 1").get()) throw new Error("Cross-hall version data found.");
  if (sqlite.prepare("SELECT 1 FROM halls h LEFT JOIN schedules s ON s.hall_id=h.id GROUP BY h.id HAVING count(s.id)<>1 LIMIT 1").get()) throw new Error("Every hall must own exactly one schedule.");
  const hallIndexes = sqlite.prepare("PRAGMA index_list(schedules)").all() as {name:string;unique:number}[];
  if (!hallIndexes.some(index => index.name === "schedules_hall_idx" && index.unique === 1)) throw new Error("Missing one-schedule-per-hall constraint.");
  const triggers = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {name:string}[]).map((row) => row.name));
  for (const name of ["hall_event_insert", "hall_event_update", "hall_link_insert", "hall_link_update", "hall_version_insert", "hall_version_update", "hall_schedules_owner", "hall_trainers_owner", "hall_class_types_owner"]) {
    if (!triggers.has(name)) throw new Error(`Missing hall integrity guard: ${name}`);
  }
}

/** New desktop projects initialize empty; existing v1 data needs an explicit preview decision. */
export function initializeHallDatabase(sqlite: Database.Database, dbPath: string) {
  if (readSchemaVersion(sqlite) === HALL_SCHEMA_VERSION) { verifyHallSchema(sqlite); return; }
  if (readSchemaVersion(sqlite) === 0) {
    // Inspect a recognized legacy layout before even its v0->v1 DDL is applied.
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedules'").get() && previewHallMigration(sqlite).requiresConfirmation) throw new HallMigrationRequiredError();
    initializeDatabaseSchema(sqlite, dbPath);
  }
  const preview = previewHallMigration(sqlite);
  if (preview.requiresConfirmation) throw new HallMigrationRequiredError();
  applyHallMigration(sqlite, dbPath, { confirmed: true, policy: "one-hall-per-schedule" });
}

/** Inert production seam: verifies rollback without corrupting a real project. */
export const hallMigrationTestHooks: { beforeCommit: (() => void) | null } = { beforeCommit: null };

export function applyHallMigration(sqlite: Database.Database, dbPath: string, decision: {confirmed:boolean;policy:"one-hall-per-schedule";logoReferences?:Record<string,string>}) {
  if (!decision.confirmed || decision.policy !== "one-hall-per-schedule") throw new HallMigrationRequiredError();
  if (readSchemaVersion(sqlite) === 0) initializeDatabaseSchema(sqlite,dbPath);
  if (readSchemaVersion(sqlite) !== 1) throw new Error("Hall migration requires schema v1.");
  verifyLatestSchema(sqlite);
  const sourceDataVersion = sqlite.pragma("data_version", { simple: true });
  const preview = previewHallMigration(sqlite);
  let backupFile: string | null = null;
  if (preview.requiresConfirmation) {
    const directory = backupsDirectoryForDatabase(dbPath);
    fs.mkdirSync(directory, { recursive: true });
    backupFile = path.join(directory, `risen-team-pre-migration-v1-to-v2-${Date.now()}-${randomUUID()}.db`);
    const temporary = `${backupFile}.tmp`;
    // VACUUM INTO produces a consistent complete SQLite image, including committed WAL data.
    try {
      sqlite.prepare("VACUUM INTO ?").run(temporary);
      const descriptor = fs.openSync(temporary, "r+");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary,backupFile);
    } finally { fs.rmSync(temporary,{force:true}); }
  }
  const graph = Object.fromEntries(TABLES.map((table) => [table, sqlite.prepare(`SELECT * FROM ${table}`).all() as Row[]])) as Record<typeof TABLES[number], Row[]>;
  if (decision.logoReferences) {
    const logos=graph.schedule_settings.flatMap(settings => settings.logo_data_url ? [String(settings.logo_data_url)] : []);
    for (const version of graph.schedule_versions) {
      if (!version.snapshot) continue;
      const snapshot=JSON.parse(String(version.snapshot));
      if (snapshot.settings?.logoDataUrl) logos.push(snapshot.settings.logoDataUrl);
    }
    if (logos.some(logo => !Object.hasOwn(decision.logoReferences!,logo))) throw new Error("Project logos changed during migration preparation. Please retry.");
  }
  const definitions = TABLES.map((table) => (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string}).sql);
  const indexes = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as {sql:string}[]).map((row) => row.sql);
  const now = Date.now();
  const mappings: {hallId:string;scheduleId:string;trainerIds:Record<string,string>;classTypeIds:Record<string,string>}[] = [];
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.transaction(() => {
      // A second connection must not commit between the safety image and our
      // write reservation. Refuse and retry instead of migrating an unbacked state.
      if (sqlite.pragma("data_version", { simple: true }) !== sourceDataVersion) throw new Error("Project changed during migration preparation. Please retry.");
      for (const table of [...TABLES].reverse()) sqlite.exec(`DROP TABLE ${table}`);
      sqlite.exec("CREATE TABLE halls (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
      sqlite.exec("CREATE TABLE hall_migration_archive (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, source_schema_version INTEGER NOT NULL, original_graph TEXT NOT NULL)");
      for (let index = 0; index < TABLES.length; index++) {
        const table = TABLES[index];
        let definition = definitions[index];
        if (["schedules", "trainers", "class_types"].includes(table)) {
          const additions = `hall_id TEXT NOT NULL REFERENCES halls(id) ON DELETE RESTRICT ON UPDATE NO ACTION, ${table === "schedules" ? "revision INTEGER NOT NULL DEFAULT 0, " : ""}`;
          definition = definition.replace(/\(/, `(${additions}`);
        }
        sqlite.exec(definition);
      }
      const insert = (table:string,row:Row) => {
        const columns = Object.keys(row);
        sqlite.prepare(`INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((column) => row[column]));
      };
      for (const row of graph.app_meta) insert("app_meta", row);
      for (const row of graph.rooms) insert("rooms", row);
      if (preview.requiresConfirmation) insert("hall_migration_archive", {id:randomUUID(),created_at:now,source_schema_version:1,original_graph:JSON.stringify(graph)});
      for (const schedule of graph.schedules) {
        const hallId = String(schedule.id);
        const trainerIds = Object.fromEntries(graph.trainers.map((trainer) => [String(trainer.id), randomUUID()]));
        const classTypeIds = Object.fromEntries(graph.class_types.map((type) => [String(type.id), randomUUID()]));
        const versions = graph.schedule_versions.filter((version) => version.schedule_id === schedule.id);
        const frozenSnapshots = versions.flatMap((version) => version.snapshot ? [JSON.parse(String(version.snapshot))] : []);
        for (const frozen of frozenSnapshots) {
          for (const trainer of frozen.trainers as {id:string}[]) trainerIds[trainer.id] ??= randomUUID();
          for (const type of frozen.classTypes as {id:string}[]) classTypeIds[type.id] ??= randomUUID();
        }
        mappings.push({hallId,scheduleId:hallId,trainerIds,classTypeIds});
        insert("halls", {id:hallId,name:schedule.name,created_at:now,updated_at:now});
        insert("schedules", {...schedule,hall_id:hallId,revision:0});
        for (const trainer of graph.trainers) insert("trainers", {...trainer,id:trainerIds[String(trainer.id)],hall_id:hallId});
        for (const type of graph.class_types) insert("class_types", {...type,id:classTypeIds[String(type.id)],hall_id:hallId});
        const existingTrainers = new Set(graph.trainers.map(trainer => String(trainer.id)));
        const existingTypes = new Set(graph.class_types.map(type => String(type.id)));
        for (const frozen of frozenSnapshots) {
          for (const trainer of frozen.trainers as {id:string;name:string;color:string;initials?:string;notes?:string;sortOrder:number}[]) if (!existingTrainers.has(trainer.id)) {
            existingTrainers.add(trainer.id);
            insert("trainers",{id:trainerIds[trainer.id],hall_id:hallId,name:trainer.name,color:trainer.color,initials:trainer.initials??null,notes:trainer.notes??null,active:0,sort_order:trainer.sortOrder,created_at:now,updated_at:now});
          }
          for (const type of frozen.classTypes as {id:string;name:string;shortName:string;defaultDuration:number;color?:string;description?:string;sortOrder:number}[]) if (!existingTypes.has(type.id)) {
            existingTypes.add(type.id);
            insert("class_types",{id:classTypeIds[type.id],hall_id:hallId,name:type.name,short_name:type.shortName,default_duration:type.defaultDuration,color:type.color??null,description:type.description??null,active:0,sort_order:type.sortOrder,created_at:now,updated_at:now});
          }
        }
        for (const link of graph.trainer_class_types) insert("trainer_class_types", {trainer_id:trainerIds[String(link.trainer_id)],class_type_id:classTypeIds[String(link.class_type_id)]});
        // A class with no eligible-trainer links was unrestricted in v1.
        for (const type of graph.class_types) {
          if (!graph.trainer_class_types.some((link) => link.class_type_id === type.id)) {
            for (const trainer of graph.trainers) insert("trainer_class_types", {trainer_id:trainerIds[String(trainer.id)],class_type_id:classTypeIds[String(type.id)]});
          }
        }
        // Explicit confirmation also preserves actual legacy assignments that
        // v1 accepted with an eligibility warning, without dropping any event.
        for (const event of graph.schedule_events.filter(event => event.schedule_id===schedule.id)) sqlite.prepare("INSERT OR IGNORE INTO trainer_class_types(trainer_id,class_type_id) VALUES(?,?)").run(trainerIds[String(event.trainer_id)],classTypeIds[String(event.class_type_id)]);
        for (const event of graph.schedule_events.filter((event) => event.schedule_id === schedule.id)) insert("schedule_events", {...event,trainer_id:trainerIds[String(event.trainer_id)],class_type_id:classTypeIds[String(event.class_type_id)],room_id:null});
        for (const settings of graph.schedule_settings.filter((settings) => settings.schedule_id === schedule.id)) insert("schedule_settings",{...settings,logo_data_url:settings.logo_data_url ? decision.logoReferences?.[String(settings.logo_data_url)] ?? settings.logo_data_url : null});
        for (const version of versions) {
          const snapshot = version.snapshot ? JSON.parse(String(version.snapshot)) : null;
          if (snapshot) {
            if (snapshot.settings.logoDataUrl) snapshot.settings.logoDataUrl = decision.logoReferences?.[snapshot.settings.logoDataUrl] ?? snapshot.settings.logoDataUrl;
            snapshot.trainers = snapshot.trainers.map((trainer: {id:string}) => ({...trainer,id:trainerIds[trainer.id] ?? `history-${hallId}-${trainer.id}`}));
            snapshot.classTypes = snapshot.classTypes.map((type: {id:string;trainerIds:string[]}) => ({...type,id:classTypeIds[type.id] ?? `history-${hallId}-${type.id}`,trainerIds:type.trainerIds.length ? type.trainerIds.map((id) => trainerIds[id] ?? `history-${hallId}-${id}`) : snapshot.trainers.map((trainer:{id:string}) => trainer.id)}));
            snapshot.events = snapshot.events.map((event: {trainerId:string;classTypeId:string}) => ({...event,trainerId:trainerIds[event.trainerId] ?? `history-${hallId}-${event.trainerId}`,classTypeId:classTypeIds[event.classTypeId] ?? `history-${hallId}-${event.classTypeId}`,roomId:null}));
            for (const event of snapshot.events as {trainerId:string;classTypeId:string}[]) {
              const type = snapshot.classTypes.find((type:{id:string}) => type.id===event.classTypeId);
              if (type && !type.trainerIds.includes(event.trainerId)) type.trainerIds.push(event.trainerId);
            }
            snapshot.rooms = [];
          }
          insert("schedule_versions", {...version,snapshot:snapshot ? JSON.stringify(snapshot) : null,restored_from_version_id:null});
        }
        // Preserve only same-hall restore pointers; original pointers remain in the migration archive.
        for (const version of versions) if (versions.some((target) => target.id === version.restored_from_version_id)) sqlite.prepare("UPDATE schedule_versions SET restored_from_version_id=? WHERE id=?").run(version.restored_from_version_id,version.id);
      }
      for (const index of indexes) sqlite.exec(index);
      sqlite.exec("CREATE UNIQUE INDEX schedules_hall_idx ON schedules(hall_id); CREATE INDEX trainers_hall_idx ON trainers(hall_id); CREATE INDEX class_types_hall_idx ON class_types(hall_id)");
      sqlite.exec(GUARDS);
      if (sqlite.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Hall migration produced invalid references.");
      hallMigrationTestHooks.beforeCommit?.();
      sqlite.pragma(`user_version = ${HALL_SCHEMA_VERSION}`);
    }).immediate();
  } finally { ensureForeignKeysEnabled(sqlite); }
  verifyHallSchema(sqlite);
  return { backupFile, mappings };
}
