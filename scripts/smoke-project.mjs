import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "Risen Team smoke Київ "));
const workspaceId = randomUUID();
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({format:"risen-team-project",formatVersion:1,workspaceId,createdAt:new Date().toISOString()}));
const base = "http://127.0.0.1:3189";
const serverPath = process.argv.find(argument=>argument.startsWith("--server="))?.slice(9) ?? "dist/portable/RisenTeamSchedule/server.js";
const environment = {...process.env,RISEN_WORKSPACE_PATH:root, HOSTNAME:"127.0.0.1", PORT:"3189"};
delete environment.RISEN_DB_PATH;
const child = spawn(process.execPath,["--require",path.resolve("native/desktop-shutdown.cjs"),serverPath],{env:environment,stdio:["pipe","pipe","pipe"],windowsHide:true});
let log="";
child.stdout.on("data",data=>{log+=data;});child.stderr.on("data",data=>{log+=data;});
const exited = new Promise(resolve=>child.on("exit",resolve));
async function request(route,body,method=body?"POST":"GET") {
  const response = await fetch(base+route,{method,headers:method!=="GET"?{"Content-Type":"application/json",Origin:base,"X-Risen-Workspace-Id":workspaceId}:undefined,body:body?JSON.stringify(body):undefined});
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
}
try {
  let ready;
  for(let n=0;n<100;n++) {try { ready=await request("/api/health");break;} catch {if(child.exitCode!==null)throw new Error(log);await new Promise(resolve=>setTimeout(resolve,200));}}
  assert.equal(ready.workspaceId,workspaceId);assert.equal(ready.schemaVersion,2);
  assert.equal((await request("/api/workspace")).empty,true);
  const demo=(await request("/api/workspace/schedules",{action:"template"})).activeScheduleId;
  let demoState=await request(`/api/workspace?scheduleId=${demo}`);
  assert.equal(demoState.trainers.length,4);assert.equal(demoState.classTypes.length,6);assert.equal(demoState.state.events.length,24);
  const themes=["risen-carbon","risen-crimson","risen-signal"];
  for(const themeId of themes) {
    await request("/api/workspace/state",{hallId:demo,scheduleId:demo,revision:demoState.revision,settings:{...demoState.state.settings,themeId},events:demoState.state.events},"PUT");
    demoState=await request(`/api/workspace?scheduleId=${demo}`);
    assert.equal(demoState.state.settings.themeId,themeId);
  }
  for (const entity of ["class-types","trainers"]) {
    const target = entity === "trainers" ? demoState.trainers[0] : demoState.classTypes[0];
    const affected = demoState.state.events.filter(event => (entity === "trainers" ? event.trainerId : event.classTypeId) === target.id).length;
    for (const revision of ["",`&revision=${demoState.revision-1}`]) {
      const staleDelete=await fetch(`${base}/api/workspace/${entity}?hallId=${demo}&id=${target.id}${revision}`,{method:"DELETE",headers:{Origin:base,"X-Risen-Workspace-Id":workspaceId}});
      assert.equal(staleDelete.status,409);
    }
    const deleted=await request(`/api/workspace/${entity}?hallId=${demo}&id=${target.id}&revision=${demoState.revision}`,undefined,"DELETE");
    assert.equal(deleted.deactivated,false);assert.equal(deleted.deletedEvents,affected);
    const afterDelete=await request(`/api/workspace?scheduleId=${demo}`);
    assert.equal(afterDelete.state.events.length,24-affected);
    assert.equal((entity === "trainers" ? afterDelete.trainers : afterDelete.classTypes).some(item=>item.id===target.id),false);
    const checkpoint=afterDelete.versions.find(version=>version.description.startsWith("Перед видаленням"));
    assert.ok(checkpoint);
    await request(`/api/workspace/versions?hallId=${demo}`,{action:"restore",versionId:checkpoint.id});
    demoState=await request(`/api/workspace?scheduleId=${demo}`);
    assert.equal(demoState.state.events.length,24);assert.equal(demoState.trainers.length,4);assert.equal(demoState.classTypes.length,6);
  }
  await request("/api/workspace/schedules",{action:"delete",id:demo});
  const first=(await request("/api/workspace/schedules",{action:"create",name:"Київ"})).activeScheduleId;
  await request(`/api/workspace/trainers?hallId=${first}`,{trainer:{id:"t1",name:"Тренер",color:"#112233",sortOrder:0,active:true},classTypeIds:[]});
  await request(`/api/workspace/class-types?hallId=${first}`,{id:"c1",name:"Бокс",shortName:"Бокс",defaultDuration:60,sortOrder:0,active:true,trainerIds:["t1"]});
  let state=await request(`/api/workspace?scheduleId=${first}`);
  const payload={hallId:first,scheduleId:first,revision:state.revision,settings:state.state.settings,events:[{id:"e1",scheduleId:first,trainerId:"t1",classTypeId:"c1",dayOfWeek:0,startTime:"10:00",endTime:"11:00"}],snapshot:true};
  await request("/api/workspace/state",payload,"PUT");
  const stale=await fetch(base+"/api/workspace/state",{method:"PUT",headers:{"Content-Type":"application/json",Origin:base,"X-Risen-Workspace-Id":workspaceId},body:JSON.stringify(payload)});
  assert.equal(stale.status,409);
  const second=(await request("/api/workspace/schedules",{action:"duplicate",sourceId:first,name:"Львів"})).activeScheduleId;
  const b=await request(`/api/workspace?scheduleId=${second}`);assert.notEqual(b.trainers[0].id,"t1");assert.equal(b.state.events.length,1);
  const backup=(await request(`/api/workspace/backup?hallId=${first}`)).backup;
  await request("/api/workspace/backup",{backup,mode:"replace",targetId:first});
  assert.equal((await request(`/api/workspace?scheduleId=${second}`)).state.events.length,1);
  const archiveResponse=await fetch(base+"/api/workspace/project-archive");assert.equal(archiveResponse.status,200);
  const archiveBase64=Buffer.from(await archiveResponse.arrayBuffer()).toString("base64");
  await request("/api/workspace/project-archive",{archiveBase64});
  assert.equal((await request("/api/workspace")).schedules.length,2);
  assert.equal((await request("/api/health")).workspaceId,workspaceId);
  const page = await fetch(base+"/halls");
  assert.equal(page.status,200);
  const html = await page.text();
  const staticPaths = [...html.matchAll(/(?:src|href)="([^"\s]*\/_next\/static\/[^"\s]+)"/g)].map(match=>match[1]);
  assert.ok(staticPaths.length>0,"The rendered application should include its browser bundles.");
  for (const route of new Set(staticPaths)) assert.equal((await fetch(new URL(route,base))).status,200,route);
  assert.equal((await fetch(base+"/versions",{redirect:"manual"})).status,307);
  child.stdin.write("shutdown\n");
  const code=await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Shutdown timed out")),20000).unref())]);
  // Next reports its completed SIGTERM cleanup using the conventional signal exit status.
  assert.equal(code,143);
  const savedDatabase = new Database(path.join(root,"data","risen-team.db"),{readonly:true});
  try { assert.equal(savedDatabase.pragma("quick_check",{simple:true}),"ok"); assert.equal(savedDatabase.prepare("SELECT count(*) AS n FROM halls").get().n,2); }
  finally { savedDatabase.close(); }
  const result={passed:true,checkedAt:new Date().toISOString(),platform:process.platform,workspacePathWithSpacesAndCyrillic:true,emptyProject:true,demoTemplate:{trainers:4,classTypes:6,events:24},themesPersisted:themes,catalogCascadeDeletion:true,catalogHistoryRestoration:true,staleCatalogDeletionRejected:true,hallCrud:true,independentDuplication:true,staleWriteRejected:true,selectedReplacement:true,archiveRoundTrip:true,identityPreserved:true,hallsSSR:true,legacyRedirect:true,gracefulShutdown:true};
  fs.writeFileSync("docs/audit/halls-production-smoke.json",JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {console.error(error);console.error(log);process.exitCode=1;}
finally {
  if(child.exitCode===null){child.stdin.write("shutdown\n");await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);}
  if(child.exitCode!==null)fs.rmSync(root,{recursive:true,force:true});
}
