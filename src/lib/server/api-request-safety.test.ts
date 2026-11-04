import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabaseForTests } from "@/db";
import { ensureSeeded } from "@/lib/server/seed";
import { exportBackup } from "@/lib/server/export-backup";
import { loadWorkspace } from "@/lib/server/workspace";
import * as backup from "@/app/api/workspace/backup/route";
import * as classTypes from "@/app/api/workspace/class-types/route";
import * as reorder from "@/app/api/workspace/reorder/route";
import * as rooms from "@/app/api/workspace/rooms/route";
import * as schedules from "@/app/api/workspace/schedules/route";
import * as state from "@/app/api/workspace/state/route";
import * as trainers from "@/app/api/workspace/trainers/route";
import * as versions from "@/app/api/workspace/versions/route";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-request-safety-"));
const previousDbPath = process.env.RISEN_DB_PATH;
let databaseNumber = 0;
beforeEach(() => {
  closeDatabaseForTests();
  process.env.RISEN_DB_PATH = path.join(tempDir, `${databaseNumber++}.db`);
  ensureSeeded();
});
afterAll(() => {
  closeDatabaseForTests();
  if (previousDbPath === undefined) delete process.env.RISEN_DB_PATH;
  else process.env.RISEN_DB_PATH = previousDbPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function fixtures() {
  const current = exportBackup();
  const workspace = loadWorkspace();
  const cases = [
    { name: "backup", method: "POST", handler: backup.POST, body: { mode: "merge", backup: current } },
    { name: "class-types", method: "POST", handler: classTypes.POST, body: { ...current.classTypes[0], name: "Changed class" } },
    { name: "reorder", method: "POST", handler: reorder.POST, body: { entity: "trainers", order: [...current.trainers].reverse().map(item => item.id) } },
    { name: "rooms", method: "POST", handler: rooms.POST, body: { ...current.rooms[0], name: "Changed room" } },
    { name: "schedules", method: "POST", handler: schedules.POST, body: { action: "create", name: "Unexpected schedule" } },
    { name: "state", method: "PUT", handler: state.PUT, body: { scheduleId: workspace.activeScheduleId, settings: workspace.state.settings, events: [] } },
    { name: "trainers", method: "POST", handler: trainers.POST, body: { ...current.trainers[0], name: "Changed trainer" } },
    { name: "versions", method: "POST", handler: versions.POST, body: { action: "create", scheduleId: workspace.activeScheduleId, description: "Unexpected version" } },
    { name: "class-types-delete", method: "DELETE", handler: classTypes.DELETE, id: current.classTypes[0].id },
    { name: "rooms-delete", method: "DELETE", handler: rooms.DELETE, id: current.rooms[0].id },
    { name: "trainers-delete", method: "DELETE", handler: trainers.DELETE, id: current.trainers[0].id },
  ];
  return cases;
}
function graph() {
  const { exportedAt: _exportedAt, ...current } = exportBackup();
  return current;
}
const routeNames = ["backup", "class-types", "reorder", "rooms", "schedules", "state", "trainers", "versions", "class-types-delete", "rooms-delete", "trainers-delete"];

describe("local API mutation request safety", () => {
  it("uses the incoming loopback Host when Next has an internal request URL", async () => {
    const result = await schedules.POST(new Request("http://internal-next:3000/api/workspace/schedules", {
      method: "POST", headers: {Host:"127.0.0.1:3189",Origin:"http://127.0.0.1:3189","Content-Type":"application/json"},
      body: JSON.stringify({action:"create",name:"Loopback origin"}),
    }));
    expect(result.status).toBe(200);
  });

  it("rejects a non-loopback Host even when its Origin matches", async () => {
    const before=graph();
    const result = await schedules.POST(new Request("http://127.0.0.1:3177/api/workspace/schedules", {
      method:"POST",headers:{Host:"attacker.example",Origin:"http://attacker.example","Content-Type":"application/json"},
      body:JSON.stringify({action:"create",name:"Must reject"}),
    }));
    expect(result.status).toBe(403);
    expect(graph()).toEqual(before);
  });
  it.each(routeNames)("rejects foreign Origin before mutating %s", async name => {
    const route = fixtures().find(item => item.name === name)!;
    const before = graph();
    const response = await route.handler(new Request(`http://127.0.0.1:3177/api/workspace/${name}?id=${route.id ?? ""}`, {
      method: route.method,
      headers: { Origin: "https://foreign.example", "Content-Type": "application/json" },
      body: route.method === "DELETE" ? undefined : JSON.stringify(route.body),
    }));
    expect(response.status).toBe(403);
    expect(graph()).toEqual(before);
  });

  it.each(routeNames.slice(0, 8))("rejects text/plain JSON before mutating %s", async name => {
    const route = fixtures().find(item => item.name === name)!;
    const before = graph();
    const response = await route.handler(new Request(`http://127.0.0.1:3177/api/workspace/${name}`, {
      method: route.method,
      headers: { Origin: "http://127.0.0.1:3177", "Content-Type": "text/plain" },
      body: JSON.stringify(route.body),
    }));
    expect(response.status).toBe(415);
    expect(graph()).toEqual(before);
  });

  it.each(["http://127.0.0.1:3177", undefined])("accepts JSON from same-origin or no-Origin clients (%s)", async origin => {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (origin) headers.Origin = origin;
    const response = await schedules.POST(new Request("http://127.0.0.1:3177/api/workspace/schedules", {
      method: "POST", headers, body: JSON.stringify({ action: "create", name: "Allowed schedule" }),
    }));
    expect(response.status).toBe(200);
    expect(exportBackup().schedules.some(item => item.name === "Allowed schedule")).toBe(true);
  });
});
