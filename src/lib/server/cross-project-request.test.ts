import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject, projectPaths } from "@/db/paths";
import { closeDatabaseForTests, getDb } from "@/db";
import { initializeDatabaseSchema } from "@/db/migrations";
import { applyHallMigration } from "@/db/hall-migration";
import { loadHallWorkspace, mutateHallCatalog } from "@/lib/server/halls";
import { PUT } from "@/app/api/workspace/state/route";
import { POST as saveTrainer } from "@/app/api/workspace/trainers/route";

const temporary: string[] = [];
const trainer = { id: "shared-trainer", name: "Trainer", color: "#123456", active: true, sortOrder: 0 };
function project(name: string) {
  closeDatabaseForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "risen-project-context-"));
  temporary.push(root);
  const identity = createProject(root);
  vi.stubEnv("RISEN_WORKSPACE_PATH", root);
  vi.stubEnv("RISEN_DB_PATH", "");
  // Two migrated copies can legitimately retain exactly the same hall IDs.
  const db = new Database(projectPaths(root).database);
  try {
    initializeDatabaseSchema(db, projectPaths(root).database);
    db.prepare("INSERT INTO schedules(id,name,is_active,created_at,updated_at) VALUES('shared-hall',?,1,1,1)").run(name);
    db.prepare("INSERT INTO schedule_settings(schedule_id,schedule_title,updated_at) VALUES('shared-hall',?,1)").run(name);
    applyHallMigration(db, projectPaths(root).database, { confirmed: true, policy: "one-hall-per-schedule" });
  } finally { db.close(); }
  mutateHallCatalog("shared-hall", "trainers", { trainer: { ...trainer, name: `${name} trainer` }, classTypeIds: [] });
  return { root, workspaceId: identity.workspaceId, workspace: loadHallWorkspace("shared-hall") };
}
function request(route: "state" | "trainers", workspaceId: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: "http://127.0.0.1:3178" };
  if (workspaceId) headers["X-Risen-Workspace-Id"] = workspaceId;
  return new Request(`http://127.0.0.1:3178/api/workspace/${route}?hallId=shared-hall`, { method: route === "state" ? "PUT" : "POST", headers, body: JSON.stringify(body) });
}
afterEach(() => {
  closeDatabaseForTests();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("project identity survives server restarts and repeated legacy hall IDs", () => {
  it("rejects stale-tab schedule and catalog writes before changing the newly opened project", async () => {
    const first = project("Project A");
    const second = project("Project B");
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.workspace.hallId).toBe(second.workspace.hallId);
    expect(first.workspace.revision).toBe(second.workspace.revision);
    const body = { hallId: "shared-hall", scheduleId: "shared-hall", revision: first.workspace.revision, events: [], settings: { ...first.workspace.state.settings, scheduleTitle: "Stale Project A edit" } };
    const before = getDb().$client.serialize();
    const stateResponse = await PUT(request("state", first.workspaceId, body));
    expect(stateResponse.status).toBe(409);
    expect(getDb().$client.serialize()).toEqual(before);
    const trainerResponse = await saveTrainer(request("trainers", first.workspaceId, { trainer: { ...trainer, name: "Stale Project A trainer" }, classTypeIds: [] }));
    expect(trainerResponse.status).toBe(409);
    expect(getDb().$client.serialize()).toEqual(before);
    expect(loadHallWorkspace("shared-hall").trainers[0].name).toBe("Project B trainer");

    // The exact same operation is allowed once the browser has loaded B's identity.
    const accepted = await PUT(request("state", second.workspaceId, { ...body, settings: { ...second.workspace.state.settings, scheduleTitle: "Intentional Project B edit" } }));
    expect(accepted.status).toBe(200);
    expect(loadHallWorkspace("shared-hall").state.settings.scheduleTitle).toBe("Intentional Project B edit");
  });

  it("refuses identity-free project mutations, including catalog updates without revision fields", async () => {
    project("Project B");
    const before = getDb().$client.serialize();
    const response = await saveTrainer(request("trainers", null, { trainer: { ...trainer, name: "Unidentified browser edit" }, classTypeIds: [] }));
    expect(response.status).toBe(409);
    expect(getDb().$client.serialize()).toEqual(before);
  });
});
