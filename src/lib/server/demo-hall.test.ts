import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabaseForTests } from "@/db";
import { createProject } from "@/db/paths";
import { createDemoHallSnapshot, DEMO_HALL_NAME } from "@/lib/schedule/demo-hall";
import { validateScheduleState } from "@/lib/schedule/validation";
import { exportHalls, hallAction, importHalls, loadHallWorkspace, saveHallState, validateHallSnapshot } from "@/lib/server/halls";

let root:string;
const previous = { workspace:process.env.RISEN_WORKSPACE_PATH, database:process.env.RISEN_DB_PATH };
beforeEach(() => {
  closeDatabaseForTests();
  root=fs.mkdtempSync(path.join(os.tmpdir(),"risen-demo-hall-"));
  createProject(root);
  process.env.RISEN_WORKSPACE_PATH=root;
  delete process.env.RISEN_DB_PATH;
});
afterEach(() => {
  closeDatabaseForTests();
  if(previous.workspace===undefined)delete process.env.RISEN_WORKSPACE_PATH;else process.env.RISEN_WORKSPACE_PATH=previous.workspace;
  if(previous.database===undefined)delete process.env.RISEN_DB_PATH;else process.env.RISEN_DB_PATH=previous.database;
  fs.rmSync(root,{recursive:true,force:true});
});

describe("explicit demonstration hall", () => {
  it("offers a valid complete weekly example without seeding a fresh project automatically", () => {
    expect(loadHallWorkspace().empty).toBe(true);
    const example=createDemoHallSnapshot();
    expect(example.trainers).toHaveLength(4);
    expect(example.classTypes).toHaveLength(6);
    expect(example.events).toHaveLength(24);
    expect(new Set(example.events.map(event=>event.dayOfWeek)).size).toBe(6);
    expect(validateScheduleState(example).conflicts).toEqual([]);
    expect(()=>validateHallSnapshot(example)).not.toThrow();
    expect(loadHallWorkspace().empty).toBe(true);
  });

  it("creates independently editable examples with unique names and fresh references", () => {
    const firstId=hallAction({action:"template"}).activeScheduleId!;
    const first=loadHallWorkspace(firstId);
    const secondId=hallAction({action:"template"}).activeScheduleId!;
    const second=loadHallWorkspace(secondId);
    expect(first.state.schedule.name).toBe(DEMO_HALL_NAME);
    expect(second.state.schedule.name).toBe(`${DEMO_HALL_NAME} (2)`);
    expect(firstId).not.toBe(secondId);
    const firstIds=new Set([firstId,...first.trainers.map(item=>item.id),...first.classTypes.map(item=>item.id),...first.state.events.map(item=>item.id)]);
    expect([secondId,...second.trainers.map(item=>item.id),...second.classTypes.map(item=>item.id),...second.state.events.map(item=>item.id)].some(id=>firstIds.has(id))).toBe(false);
    const secondBefore=exportHalls([secondId]).halls;
    saveHallState({hallId:firstId,scheduleId:firstId,revision:first.revision,settings:first.state.settings,events:first.state.events.slice(1)});
    expect(loadHallWorkspace(firstId).state.events).toHaveLength(23);
    expect(exportHalls([secondId]).halls).toEqual(secondBefore);
  });

  it("round-trips the template through the same portable hall format without changing existing halls", () => {
    const existingId=hallAction({action:"create",name:"Робочий зал"}).activeScheduleId!;
    const existingBefore=exportHalls([existingId]).halls;
    const demoId=hallAction({action:"template"}).activeScheduleId!;
    const portable=exportHalls([demoId]);
    expect(importHalls(portable)).toMatchObject({schedules:1,events:24,mode:"merge"});
    const imported=exportHalls().halls.find(hall=>hall.id!==existingId&&hall.id!==demoId)!;
    expect(imported.snapshot.events).toHaveLength(24);
    expect(imported.snapshot.trainers.map(trainer=>trainer.name)).toEqual(portable.halls[0].snapshot.trainers.map(trainer=>trainer.name));
    expect(()=>validateHallSnapshot(imported.snapshot)).not.toThrow();
    expect(imported.versions.some(version=>version.description.includes("демонстраційний"))).toBe(true);
    expect(exportHalls([existingId]).halls).toEqual(existingBefore);
  });
});
