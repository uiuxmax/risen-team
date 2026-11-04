import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, projectPaths, readProjectManifest } from "@/db/paths";
import { closeDatabaseForTests, getDb } from "@/db";
import { initializeDatabaseSchema } from "@/db/migrations";
import { applyHallMigration } from "@/db/hall-migration";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { prepareHallMigrationLogos } from "@/lib/server/assets";
import { exportHalls, importHalls, loadHallWorkspace, restoreHallVersion } from "@/lib/server/halls";
import { PUT } from "@/app/api/workspace/state/route";

let root: string;
let legacy: Database.Database;
const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#123456"/></svg>').toString("base64")}`;
beforeEach(() => {
  closeDatabaseForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "risen-legacy-logo-"));
  createProject(root);
  vi.stubEnv("RISEN_WORKSPACE_PATH", root);
  vi.stubEnv("RISEN_DB_PATH", "");
  legacy = new Database(projectPaths(root).database);
  initializeDatabaseSchema(legacy, projectPaths(root).database);
  legacy.exec("INSERT INTO schedules(id,name,is_active,created_at,updated_at) VALUES('hall','Legacy hall',1,1,1)");
  legacy.prepare("INSERT INTO schedule_settings(schedule_id,logo_data_url,updated_at) VALUES('hall',?,1)").run(svg);
  const snapshot = { schemaVersion: 1, schedule: { id: "hall", name: "Legacy hall", status: "draft" }, settings: { ...DEFAULT_SETTINGS, logoDataUrl: svg }, events: [], trainers: [], classTypes: [], rooms: [] };
  legacy.prepare("INSERT INTO schedule_versions(id,schedule_id,created_at,source,description,snapshot) VALUES('legacy-version','hall',1,'manual','Before migration',?)").run(JSON.stringify(snapshot));
});
afterEach(() => {
  if (legacy.open) legacy.close();
  closeDatabaseForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy SVG resources across migration, save, exchange and restore", () => {
  it("prepares resources without changing old SQLite data, keeps the before-image, and remains editable after restore", async () => {
    const before = legacy.serialize();
    const logos = await prepareHallMigrationLogos(legacy, root);
    expect(legacy.serialize()).toEqual(before);
    expect(logos[svg]).toMatch(/^assets\/logos\/[a-f0-9]{64}\.png$/);
    const migrated = applyHallMigration(legacy, projectPaths(root).database, { confirmed: true, policy: "one-hall-per-schedule", logoReferences: logos });
    expect(legacy.prepare("SELECT logo_data_url FROM schedule_settings").get()).toEqual({ logo_data_url: logos[svg] });
    const history = JSON.parse((legacy.prepare("SELECT snapshot FROM schedule_versions WHERE id='legacy-version'").get() as { snapshot: string }).snapshot);
    expect(history.settings.logoDataUrl).toBe(logos[svg]);
    const archive = JSON.parse((legacy.prepare("SELECT original_graph FROM hall_migration_archive").get() as { original_graph: string }).original_graph);
    expect(archive.schedule_settings[0].logo_data_url).toBe(svg);
    const safety = new Database(migrated.backupFile!, { readonly: true });
    try { expect(safety.prepare("SELECT logo_data_url FROM schedule_settings").get()).toEqual({ logo_data_url: svg }); }
    finally { safety.close(); }
    legacy.close();

    const state = loadHallWorkspace("hall");
    expect(state.state.settings.logoDataUrl).toMatch(/^data:image\/png;base64,/);
    // An old browser/recovery payload can still send its original inline SVG.
    const response = await PUT(new Request("http://127.0.0.1:3178/api/workspace/state", { method: "PUT", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3178", "X-Risen-Workspace-Id": readProjectManifest(root).workspaceId }, body: JSON.stringify({ hallId: "hall", scheduleId: "hall", revision: state.revision, settings: { ...state.state.settings, scheduleTitle: "Edited after upgrade", logoDataUrl: svg }, events: [] }) }));
    expect(response.status).toBe(200);
    expect(loadHallWorkspace("hall").state.settings.scheduleTitle).toBe("Edited after upgrade");
    restoreHallVersion("hall", "legacy-version");
    expect(loadHallWorkspace("hall").state.settings.logoDataUrl).toMatch(/^data:image\/png;base64,/);
    const pkg = exportHalls(["hall"]);
    expect(pkg.halls[0].versions.every((version) => !version.snapshot.settings.logoDataUrl || version.snapshot.settings.logoDataUrl.startsWith("data:image/png;base64,"))).toBe(true);
    importHalls(pkg);
    const copy = exportHalls().halls.find((hall) => hall.id !== "hall")!;
    restoreHallVersion(copy.id, copy.versions.find((version) => version.description === "Before migration")!.id);
    expect(loadHallWorkspace(copy.id).state.settings.logoDataUrl).toBe(state.state.settings.logoDataUrl);
    expect((getDb().$client.prepare("SELECT logo_data_url FROM schedule_settings WHERE schedule_id=?").get(copy.id) as { logo_data_url: string }).logo_data_url).toBe(logos[svg]);
  });

  it("refuses unsafe legacy SVG before schema/data mutation", async () => {
    const dangerous = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private/data"/></svg>').toString("base64")}`;
    legacy.prepare("UPDATE schedule_settings SET logo_data_url=?").run(dangerous);
    const before = legacy.serialize();
    await expect(prepareHallMigrationLogos(legacy, root)).rejects.toThrow(/unsupported/);
    expect(legacy.serialize()).toEqual(before);
    expect(legacy.pragma("user_version", { simple: true })).toBe(1);
  });
});
