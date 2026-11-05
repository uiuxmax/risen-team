import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProject } from "@/db/paths";
import { closeDatabaseForTests, getDb } from "@/db";
import { assertHallVersionContext, deleteHallCatalog, exportHalls, hallAction, importHalls, loadHallWorkspace, mutateHallCatalog, reorderHallCatalog, requireHallBackup, restoreHallVersion, saveHallState } from "@/lib/server/halls";
import { storeLogoDataUrl } from "@/lib/server/assets";

let root:string;
const previous = {workspace:process.env.RISEN_WORKSPACE_PATH,db:process.env.RISEN_DB_PATH};
beforeEach(() => {
  closeDatabaseForTests();
  root=fs.mkdtempSync(path.join(os.tmpdir(),"risen-halls-integration-"));
  createProject(root);
  process.env.RISEN_WORKSPACE_PATH=root;
  delete process.env.RISEN_DB_PATH;
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabaseForTests();
  if (previous.workspace === undefined) delete process.env.RISEN_WORKSPACE_PATH; else process.env.RISEN_WORKSPACE_PATH=previous.workspace;
  if (previous.db === undefined) delete process.env.RISEN_DB_PATH; else process.env.RISEN_DB_PATH=previous.db;
  fs.rmSync(root,{recursive:true,force:true});
});
function populated() {
  const id=hallAction({action:"create",name:"Зал А"}).activeScheduleId!;
  mutateHallCatalog(id,"trainers",{trainer:{id:"trainer",name:"Тренер",color:"#112233",active:true,sortOrder:0},classTypeIds:[]});
  mutateHallCatalog(id,"class_types",{id:"class",name:"Бокс",shortName:"Бокс",defaultDuration:60,active:true,sortOrder:0,trainerIds:["trainer"]});
  const state=loadHallWorkspace(id);
  saveHallState({hallId:id,scheduleId:id,revision:state.revision,settings:state.state.settings,events:[{id:"event",scheduleId:id,trainerId:"trainer",classTypeId:"class",dayOfWeek:0,startTime:"10:00",endTime:"11:00"}],snapshot:true});
  return id;
}
describe("hall isolation, revisions and exchange",() => {
  it.each(["trainer", "classType", "trainerOrder", "classTypeOrder"] as const)("updates only the changed hall's date for %s", action => {
    const id=populated();
    mutateHallCatalog(id,"trainers",{trainer:{id:"trainer2",name:"Другий",color:"#334455",active:true,sortOrder:1},classTypeIds:[]});
    mutateHallCatalog(id,"class_types",{id:"class2",name:"Другий тип",shortName:"Другий",defaultDuration:60,active:true,sortOrder:1,trainerIds:["trainer2"]});
    const other=hallAction({action:"create",name:"Інший"}).activeScheduleId!;
    const untouched=loadHallWorkspace(other).state.schedule;
    const now=Date.UTC(2030,0,2,12);
    vi.spyOn(Date,"now").mockReturnValue(now);
    const before=loadHallWorkspace(id);
    if(action==="trainer") mutateHallCatalog(id,"trainers",{trainer:{...before.trainers[0],name:"Нове ім’я"},classTypeIds:["class"]});
    else if(action==="classType") mutateHallCatalog(id,"class_types",{...before.classTypes[0],name:"Новий тип"});
    else {
      const trainers=action==="trainerOrder";
      const order=trainers?["trainer2","trainer"]:["class2","class"];
      reorderHallCatalog(id,{entity:trainers?"trainers":"classTypes",order});
      const after=loadHallWorkspace(id);
      expect((trainers?after.trainers:after.classTypes).map(item=>item.id)).toEqual(order);
    }
    const after=loadHallWorkspace(id);
    expect(after.state.schedule.updatedAt).toBe(new Date(now).toISOString());
    expect(getDb().$client.prepare("SELECT updated_at FROM halls WHERE id=?").get(id)).toEqual({updated_at:now});
    expect(loadHallWorkspace(other).state.schedule).toEqual(untouched);
  });

  it("keeps a duplicated maximum-length hall name portable through export and import", () => {
    const source=hallAction({action:"create",name:"З".repeat(80)}).activeScheduleId!;
    const copy=hallAction({action:"duplicate",sourceId:source}).activeScheduleId!;
    const exported=exportHalls([copy]);
    expect(exported.halls[0].name.length).toBeLessThanOrEqual(80);
    expect(exported.halls[0].name).toMatch(/ — копія$/);
    expect(()=>importHalls(exported)).not.toThrow();
    expect(exportHalls().halls.filter(hall=>hall.name===exported.halls[0].name)).toHaveLength(2);
  });

  it.each(["trainers", "class_types"] as const)("deletes %s and its current events atomically, preserving other halls and restorable history", entity => {
    const id=populated();
    const other=hallAction({action:"duplicate",sourceId:id,name:"Other"}).activeScheduleId!;
    const otherBefore=exportHalls([other]).halls;
    const stale=loadHallWorkspace(id);
    const target=entity === "trainers" ? "trainer" : "class";
    const result=deleteHallCatalog(id,entity,target);
    const after=loadHallWorkspace(id);
    expect(result).toMatchObject({deactivated:false,deletedEvents:1,revision:stale.revision!+1});
    expect(after.state.events).toEqual([]);
    expect(entity === "trainers" ? after.trainers : after.classTypes).toEqual([]);
    expect(after.classTypes.every(type=>!type.trainerIds.includes(entity === "trainers" ? target : "no-match"))).toBe(true);
    expect(exportHalls([other]).halls).toEqual(otherBefore);
    expect(()=>saveHallState({hallId:id,scheduleId:id,revision:stale.revision,settings:stale.state.settings,events:stale.state.events})).toThrow(/іншій вкладці/);
    const checkpoint=exportHalls([id]).halls[0].versions.find(version=>version.description.startsWith("Перед видаленням"))!;
    expect(checkpoint.snapshot.events).toHaveLength(1);
    restoreHallVersion(id,checkpoint.id);
    const restored=loadHallWorkspace(id);
    expect(restored.trainers).toHaveLength(1);
    expect(restored.classTypes).toHaveLength(1);
    expect(restored.classTypes[0].trainerIds).toEqual(["trainer"]);
    expect(restored.state.events).toEqual(stale.state.events);
    expect(()=>importHalls(exportHalls([id]))).not.toThrow();
  });

  it.each(["trainers", "class_types"] as const)("keeps deleted %s absent after exchange, with history available for explicit restoration", entity => {
    const id=populated();
    deleteHallCatalog(id,entity,entity === "trainers" ? "trainer" : "class");
    importHalls(exportHalls([id]));
    const imported=exportHalls().halls.find(item=>item.id!==id)!;
    expect(imported.snapshot.events).toEqual([]);
    expect(entity === "trainers" ? imported.snapshot.trainers : imported.snapshot.classTypes).toEqual([]);
    const checkpoint=imported.versions.find(version=>version.description.startsWith("Перед видаленням"))!;
    restoreHallVersion(imported.id,checkpoint.id);
    const restored=loadHallWorkspace(imported.id);
    expect(restored.state.events).toHaveLength(1);
    expect(restored.trainers).toHaveLength(1);
    expect(restored.classTypes[0].trainerIds).toEqual([restored.trainers[0].id]);
  });

  it("rejects a foreign catalog deletion before creating a backup", () => {
    populated();
    const other=hallAction({action:"create",name:"Other"}).activeScheduleId!;
    const before=getDb().$client.serialize();
    expect(()=>deleteHallCatalog(other,"trainers","trainer")).toThrow(/не належить/);
    expect(getDb().$client.serialize()).toEqual(before);
    expect(fs.readdirSync(path.join(root,"backups"))).toEqual([]);
  });

  it("rejects a stale or missing HTTP revision before deleting any catalog data", () => {
    const id=populated(), before=exportHalls([id]).halls;
    const revision=loadHallWorkspace(id).revision!;
    for (const stale of [revision-1,NaN]) expect(()=>deleteHallCatalog(id,"trainers","trainer",stale)).toThrow(/застаріла/);
    expect(exportHalls([id]).halls).toEqual(before);
    expect(fs.readdirSync(path.join(root,"backups"))).toEqual([]);
  });

  it("rolls back catalog, events, revision and history if final catalog deletion fails", () => {
    const id=populated();
    const before=exportHalls([id]).halls;
    const revision=loadHallWorkspace(id).revision;
    getDb().$client.exec("CREATE TRIGGER injected_catalog_failure BEFORE DELETE ON trainers BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END");
    expect(()=>deleteHallCatalog(id,"trainers","trainer")).toThrow(/injected catalog/);
    expect(exportHalls([id]).halls).toEqual(before);
    expect(loadHallWorkspace(id).revision).toBe(revision);
    expect(fs.readdirSync(path.join(root,"backups"))).toHaveLength(1);
  });

  it("refuses catalog deletion when its safety copy cannot be written", () => {
    const id=populated();
    const before=exportHalls([id]).halls;
    fs.rmdirSync(path.join(root,"backups"));
    fs.writeFileSync(path.join(root,"backups"),"blocked");
    expect(()=>deleteHallCatalog(id,"class_types","class")).toThrow(/резервну копію/);
    expect(exportHalls([id]).halls).toEqual(before);
  });
  it("rotates completed hall backups while retaining migration and incomplete files", () => {
    hallAction({action:"create",name:"Backup"});
    const dir=path.join(root,"backups");
    fs.writeFileSync(path.join(dir,"risen-team-pre-migration-copy.db"),"keep");
    fs.writeFileSync(path.join(dir,"risen-team-halls-partial.json.tmp"),"keep");
    for(let i=0;i<12;i++) requireHallBackup("test");
    const files=fs.readdirSync(dir);
    expect(files.filter(file=>file.endsWith(".json"))).toHaveLength(10);
    expect(files).toContain("risen-team-pre-migration-copy.db");
    expect(files).toContain("risen-team-halls-partial.json.tmp");
  });
  it("reopens the most recently selected hall", () => {
    const first=hallAction({action:"create",name:"First"}).activeScheduleId!;
    hallAction({action:"create",name:"Second"});
    loadHallWorkspace(first);
    expect(loadHallWorkspace().hallId).toBe(first);
  });
  it("duplicates independently and rejects cross-hall IDs and stale writes",() => {
    const a=populated();
    const b=hallAction({action:"duplicate",sourceId:a,name:"Зал Б"}).activeScheduleId!;
    const first=loadHallWorkspace(a),second=loadHallWorkspace(b);
    expect(second.trainers[0].id).not.toBe(first.trainers[0].id);
    expect(second.classTypes[0].trainerIds).toEqual([second.trainers[0].id]);
    expect(() => saveHallState({hallId:a,scheduleId:a,revision:first.revision,settings:first.state.settings,events:[{...first.state.events[0],trainerId:second.trainers[0].id}]})).toThrow(/активного/);
    expect(() => saveHallState({hallId:a,scheduleId:a,revision:0,settings:first.state.settings,events:first.state.events})).toThrow(/іншій вкладці/);
    const copy=hallAction({action:"duplicate",sourceId:a,withoutEvents:true}).activeScheduleId!;
    expect(loadHallWorkspace(copy).state.events).toEqual([]);
    expect(loadHallWorkspace(copy).trainers).toHaveLength(1);
  });
  it("round-trips one hall with history and restores its remapped checkpoint without touching another hall",() => {
    const a=populated();
    const b=hallAction({action:"create",name:"Інший"}).activeScheduleId!;
    const untouched=loadHallWorkspace(b);
    const pkg=exportHalls([a]);
    const originalVersions=pkg.halls[0].versions;
    expect(originalVersions.length).toBeGreaterThan(0);
    importHalls(pkg);
    const copies=exportHalls().halls.filter(hall => hall.id!==a && hall.id!==b);
    expect(copies).toHaveLength(1);
    const imported=copies[0];
    expect(imported.versions.length).toBeGreaterThanOrEqual(originalVersions.length);
    expect(imported.versions.every(version => !originalVersions.some(old => old.id===version.id))).toBe(true);
    const eventVersion=imported.versions.find(version => version.snapshot.events.length>0)!;
    expect(eventVersion.snapshot.events[0].trainerId).toBe(imported.snapshot.trainers[0].id);
    restoreHallVersion(imported.id,eventVersion.id);
    const after=loadHallWorkspace(b);
    expect({state:after.state,trainers:after.trainers,classTypes:after.classTypes,revision:after.revision}).toEqual({state:untouched.state,trainers:untouched.trainers,classTypes:untouched.classTypes,revision:untouched.revision});
  });
  it("rejects an empty eligibility list and malformed time before producing a backup or mutating data",() => {
    const id=populated();
    const pkg=exportHalls([id]);
    pkg.halls[0].snapshot.classTypes[0].trainerIds=[];
    const before=getDb().$client.serialize();
    expect(() => importHalls(pkg)).toThrow(/не дозволений/);
    expect(getDb().$client.serialize()).toEqual(before);
    expect(fs.readdirSync(path.join(root,"backups"))).toEqual([]);
  });
  it("rejects version reads and writes scoped to another hall",() => {
    const a=populated();
    const b=hallAction({action:"create",name:"Б"}).activeScheduleId!;
    const version=exportHalls([a]).halls[0].versions[0];
    expect(() => assertHallVersionContext(b,a)).toThrow(/не належить/);
    expect(() => assertHallVersionContext(b,undefined,version.id)).toThrow(/не належить/);
    expect(() => restoreHallVersion(b,version.id)).toThrow(/не належить/);
  });
  it("rolls back a selected-hall replacement when inserting imported history fails",() => {
    const a=populated();
    const pkg=exportHalls([a]);
    const before=exportHalls([a]).halls;
    getDb().$client.exec("CREATE TRIGGER injected_history_failure BEFORE INSERT ON schedule_versions WHEN NEW.source='import' BEGIN SELECT RAISE(ABORT,'injected history failure'); END");
    pkg.halls[0].versions[0].source="import";
    expect(() => importHalls(pkg,"replace",a)).toThrow(/injected history/);
    expect(exportHalls([a]).halls).toEqual(before);
    expect(fs.readdirSync(path.join(root,"backups"))).toHaveLength(1);
  });
  it("refuses removing permissions used by saved events and keeps exported files valid",() => {
    const id=populated();
    expect(() => mutateHallCatalog(id,"class_types",{...loadHallWorkspace(id).classTypes[0],trainerIds:[]})).toThrow(/перепризначте/);
    expect(() => mutateHallCatalog(id,"trainers",{trainer:loadHallWorkspace(id).trainers[0],classTypeIds:[]})).toThrow(/перепризначте/);
    expect(() => importHalls(exportHalls([id]))).not.toThrow();
  });
  it("keeps replacement revisions monotonic so a stale tab cannot overwrite imported data",() => {
    const id=populated();
    const stale=loadHallWorkspace(id);
    importHalls(exportHalls([id]),"replace",id);
    expect(loadHallWorkspace(id).revision).toBe(stale.revision!+1);
    expect(() => saveHallState({hallId:id,scheduleId:id,revision:stale.revision,settings:stale.state.settings,events:stale.state.events})).toThrow(/іншій вкладці/);
  });
  it("hydrates file-backed historical logos for export, import and version restore",() => {
    const id=populated();
    const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
    const reference=storeLogoDataUrl(root,png);
    const original=exportHalls([id]).halls[0].versions.find(version=>version.snapshot.events.length)!;
    original.snapshot.settings.logoDataUrl=reference;
    getDb().$client.prepare("UPDATE schedule_versions SET snapshot=? WHERE id=?").run(JSON.stringify(original.snapshot),original.id);
    const pkg=exportHalls([id]);
    expect(pkg.halls[0].versions.find(version=>version.id===original.id)!.snapshot.settings.logoDataUrl).toBe(png);
    importHalls(pkg);
    const imported=exportHalls().halls.find(hall=>hall.id!==id)!;
    const checkpoint=imported.versions.find(version=>version.snapshot.settings.logoDataUrl===png)!;
    const stored=JSON.parse((getDb().$client.prepare("SELECT snapshot FROM schedule_versions WHERE id=?").get(checkpoint.id) as {snapshot:string}).snapshot);
    expect(stored.settings.logoDataUrl).toBe(reference);
    restoreHallVersion(imported.id,checkpoint.id);
    expect(loadHallWorkspace(imported.id).state.settings.logoDataUrl).toBe(png);
  });
});
