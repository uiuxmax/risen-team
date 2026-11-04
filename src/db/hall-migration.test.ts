import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDatabaseSchema, LEGACY_V0_SCHEMA_SQL } from "@/db/migrations";
import { applyHallMigration, hallMigrationTestHooks, initializeHallDatabase, previewHallMigration, verifyHallSchema } from "@/db/hall-migration";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";

const roots:string[] = [];
const opened:Database.Database[] = [];
function fixture(populated = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "risen-hall-migration-"));
  roots.push(root);
  const filename = path.join(root,"test.db");
  const db = new Database(filename); opened.push(db);
  initializeDatabaseSchema(db,filename);
  if (populated) {
    db.exec(`INSERT INTO schedules (id,name,is_active,created_at,updated_at) VALUES ('a','Зал А',1,1,1),('b','Зал Б',0,1,1);
      INSERT INTO trainers (id,name,color,created_at,updated_at) VALUES ('t','Тренер','#112233',1,1);
      INSERT INTO class_types (id,name,short_name,created_at,updated_at) VALUES ('c','Бокс','Бокс',1,1);
      INSERT INTO rooms (id,name) VALUES ('r','Старий зал');
      INSERT INTO schedule_events (id,schedule_id,day_of_week,start_time,end_time,trainer_id,class_type_id,room_id,created_at,updated_at) VALUES ('e','a',0,'10:00','11:00','t','c','r',1,1);
      INSERT INTO schedule_settings (schedule_id,updated_at) VALUES ('a',1),('b',1);`);
  }
  return {db,filename};
}
afterEach(() => {
  hallMigrationTestHooks.beforeCommit = null;
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});
});

describe("explicit hall migration", () => {
  it("previews existing room ambiguity without changing data and refuses automatic adoption", () => {
    const {db,filename} = fixture();
    const before = db.serialize();
    expect(previewHallMigration(db).schedules[0]).toMatchObject({id:"a",roomIds:["r"],eventCount:1});
    expect(() => initializeHallDatabase(db,filename)).toThrow(/підтвердження/);
    expect(db.serialize()).toEqual(before);
  });
  it("clones shared and unused catalogs, archives source and makes a readable consistent safety database", () => {
    const {db,filename} = fixture();
    const result = applyHallMigration(db,filename,{confirmed:true,policy:"one-hall-per-schedule"});
    expect(result.mappings.map((mapping) => mapping.hallId)).toEqual(["a","b"]);
    expect(result.mappings[0].trainerIds.t).not.toBe(result.mappings[1].trainerIds.t);
    expect(db.prepare("SELECT count(*) n FROM trainers").get()).toEqual({n:2});
    expect(db.prepare("SELECT count(*) n FROM trainer_class_types").get()).toEqual({n:2});
    const archive = JSON.parse((db.prepare("SELECT original_graph FROM hall_migration_archive").get() as {original_graph:string}).original_graph);
    expect(archive.trainers[0].id).toBe("t");
    const backup = new Database(result.backupFile!,{readonly:true}); opened.push(backup);
    expect(backup.pragma("user_version",{simple:true})).toBe(1);
    expect(backup.prepare("SELECT trainer_id FROM schedule_events").get()).toEqual({trainer_id:"t"});
    verifyHallSchema(db);
  });
  it("SQLite refuses cross-hall events, eligibility links, owner changes and ownerless catalog writes", () => {
    const {db,filename} = fixture();
    const {mappings:[a,b]} = applyHallMigration(db,filename,{confirmed:true,policy:"one-hall-per-schedule"});
    expect(() => db.prepare("UPDATE schedule_events SET trainer_id=? WHERE id='e'").run(b.trainerIds.t)).toThrow(/cross-hall/);
    expect(() => db.prepare("INSERT INTO trainer_class_types VALUES (?,?)").run(a.trainerIds.t,b.classTypeIds.c)).toThrow(/cross-hall/);
    expect(() => db.prepare("UPDATE trainers SET hall_id='b' WHERE id=?").run(a.trainerIds.t)).toThrow(/immutable/);
    expect(() => db.exec("INSERT INTO trainers (id,name,color,created_at,updated_at) VALUES ('bad','bad','#ffffff',1,1)")).toThrow(/NOT NULL/);
    expect(db.pragma("foreign_keys",{simple:true})).toBe(1);
  });
  it("rolls back schema, catalog IDs and version marker after injected failure while retaining the safety image", () => {
    const {db,filename} = fixture();
    const before = db.serialize();
    hallMigrationTestHooks.beforeCommit = () => {throw new Error("injected");};
    expect(() => applyHallMigration(db,filename,{confirmed:true,policy:"one-hall-per-schedule"})).toThrow("injected");
    expect(db.serialize()).toEqual(before);
    expect(fs.readdirSync(path.join(path.dirname(filename),"backups"))).toHaveLength(1);
    expect(db.pragma("foreign_keys",{simple:true})).toBe(1);
  });
  it("bootstraps an intentionally empty desktop project and keeps it empty on reopen", () => {
    const {db,filename} = fixture(false);
    initializeHallDatabase(db,filename);
    initializeHallDatabase(db,filename);
    expect(db.pragma("user_version",{simple:true})).toBe(2);
    expect(db.prepare("SELECT * FROM halls").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM trainers").all()).toEqual([]);
  });
  it("refuses populated v0 before applying even the older migration",() => {
    const {filename}=fixture(false);
    const legacy=new Database(filename+"-legacy"); opened.push(legacy);
    legacy.exec(LEGACY_V0_SCHEMA_SQL);
    legacy.exec("INSERT INTO schedules(id,name,is_active,created_at,updated_at) VALUES('old','Старий',1,1,1)");
    const before=legacy.serialize();
    expect(() => initializeHallDatabase(legacy,filename+"-legacy")).toThrow(/підтвердження/);
    expect(legacy.serialize()).toEqual(before);
  });
  it("makes confirmed old warning-only eligibility explicit and retains every event",() => {
    const {db,filename}=fixture();
    db.exec("INSERT INTO trainers(id,name,color,created_at,updated_at) VALUES('other','Інший','#ffffff',1,1); INSERT INTO trainer_class_types VALUES('other','c')");
    expect(previewHallMigration(db).schedules[0].eligibilityMismatches).toBe(1);
    const {mappings:[mapping]}=applyHallMigration(db,filename,{confirmed:true,policy:"one-hall-per-schedule"});
    expect(db.prepare("SELECT 1 n FROM trainer_class_types WHERE trainer_id=? AND class_type_id=?").get(mapping.trainerIds.t,mapping.classTypeIds.c)).toEqual({n:1});
    expect(db.prepare("SELECT count(*) n FROM schedule_events").get()).toEqual({n:1});
  });
  it("detects cross-hall graph corruption even when expected guards have been recreated",() => {
    const {db,filename}=fixture();
    const {mappings:[,b]}=applyHallMigration(db,filename,{confirmed:true,policy:"one-hall-per-schedule"});
    const trigger=(db.prepare("SELECT sql FROM sqlite_master WHERE name='hall_event_update'").get() as {sql:string}).sql;
    db.exec("DROP TRIGGER hall_event_update");
    db.prepare("UPDATE schedule_events SET trainer_id=? WHERE id='e'").run(b.trainerIds.t);
    db.exec(trigger);
    expect(() => verifyHallSchema(db)).toThrow(/Cross-hall event/);
  });
  it("maps prepared current and historical logo references while retaining original SVG in the archive",() => {
    const {db,filename}=fixture();
    const svg="data:image/svg+xml;base64,PHN2Zz4=";
    const reference=`assets/logos/${"a".repeat(64)}.png`;
    db.prepare("UPDATE schedule_settings SET logo_data_url=? WHERE schedule_id='a'").run(svg);
    const snapshot={schemaVersion:1,schedule:{id:"a",name:"Зал А",status:"draft"},settings:{...DEFAULT_SETTINGS,logoDataUrl:svg},events:[],trainers:[],classTypes:[],rooms:[]};
    db.prepare("INSERT INTO schedule_versions(id,schedule_id,created_at,source,description,snapshot) VALUES('v','a',1,'manual','old',?)").run(JSON.stringify(snapshot));
    applyHallMigration(db,filename,{confirmed:true,policy:"one-hall-per-schedule",logoReferences:{[svg]:reference}});
    expect(db.prepare("SELECT logo_data_url FROM schedule_settings WHERE schedule_id='a'").get()).toEqual({logo_data_url:reference});
    const converted=JSON.parse((db.prepare("SELECT snapshot FROM schedule_versions WHERE id='v'").get() as {snapshot:string}).snapshot);
    expect(converted.settings.logoDataUrl).toBe(reference);
    const original=JSON.parse((db.prepare("SELECT original_graph FROM hall_migration_archive").get() as {original_graph:string}).original_graph);
    expect(original.schedule_settings.find((row:{schedule_id:string})=>row.schedule_id==="a").logo_data_url).toBe(svg);
    expect(JSON.parse(original.schedule_versions[0].snapshot).settings.logoDataUrl).toBe(svg);
  });
  it("refuses a logo preparation map that no longer covers the source",() => {
    const {db,filename}=fixture();
    db.prepare("UPDATE schedule_settings SET logo_data_url='new-logo' WHERE schedule_id='a'").run();
    const before=db.serialize();
    expect(() => applyHallMigration(db,filename,{confirmed:true,policy:"one-hall-per-schedule",logoReferences:{}})).toThrow(/logos changed/);
    expect(db.serialize()).toEqual(before);
  });
});
