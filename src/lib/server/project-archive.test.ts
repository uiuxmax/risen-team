import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabaseForTests, getDb } from "@/db";
import { createProject, readProjectManifest } from "@/db/paths";
import { hallAction, exportHalls } from "@/lib/server/halls";
import { exportProjectArchive, restoreProjectArchive } from "@/lib/server/project-archive";
import { readLogoDataUrl, storeLogoDataUrl } from "@/lib/server/assets";

let root: string;
let oldWorkspace: string | undefined;
let oldDatabase: string | undefined;
beforeEach(() => {
  oldWorkspace = process.env.RISEN_WORKSPACE_PATH; oldDatabase = process.env.RISEN_DB_PATH;
  delete process.env.RISEN_DB_PATH;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "risen-archive-test-"));
  createProject(root); process.env.RISEN_WORKSPACE_PATH = root;
});
afterEach(() => {
  closeDatabaseForTests();
  if (oldWorkspace === undefined) delete process.env.RISEN_WORKSPACE_PATH; else process.env.RISEN_WORKSPACE_PATH = oldWorkspace;
  if (oldDatabase === undefined) delete process.env.RISEN_DB_PATH; else process.env.RISEN_DB_PATH = oldDatabase;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("complete project archive", () => {
  it("round-trips a manifest timestamp emitted with a Windows UTC offset", async () => {
    const manifest=readProjectManifest(root);
    fs.writeFileSync(path.join(root,"project.json"),JSON.stringify({...manifest,createdAt:"2026-11-03T16:00:00.0000000+00:00"}));
    hallAction({action:"create",name:"Windows project"});
    const archive=await exportProjectArchive();
    expect(restoreProjectArchive(archive).schedules).toBe(1);
  });
  it("moves referenced immutable logos to another project and rejects a missing resource", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
    const sourceId = hallAction({ action: "create", name: "З логотипом" }).activeScheduleId;
    const reference = storeLogoDataUrl(root, png);
    getDb().$client.prepare("UPDATE schedule_settings SET logo_data_url=? WHERE schedule_id=?").run(reference, sourceId);
    const bytes = await exportProjectArchive();
    const envelope = JSON.parse(gunzipSync(bytes).toString());
    expect(envelope.assets).toHaveLength(1);
    closeDatabaseForTests();
    const target = path.join(root, "target");
    const targetIdentity = createProject(target).workspaceId; process.env.RISEN_WORKSPACE_PATH = target;
    hallAction({ action: "create", name: "Поточний зал" });
    envelope.assets = [];
    expect(() => restoreProjectArchive(gzipSync(JSON.stringify(envelope)))).toThrow("відсутній логотип");
    expect(exportHalls().halls[0].name).toBe("Поточний зал");
    restoreProjectArchive(bytes);
    expect(exportHalls().halls[0].name).toBe("З логотипом");
    expect(readLogoDataUrl(target, reference)).toBe(png);
    expect(readProjectManifest(target).workspaceId).toBe(targetIdentity);
  });

  it("backs up committed WAL data and restores independent halls while retaining target project identity", async () => {
    hallAction({ action: "create", name: "Перший зал" });
    const second = hallAction({ action: "create", name: "Другий зал" }).activeScheduleId;
    const identity = readProjectManifest(root).workspaceId;
    const bytes = await exportProjectArchive();
    const unpacked = JSON.parse(gunzipSync(bytes).toString());
    expect(unpacked.manifest.workspaceId).toBe(identity);
    expect(Buffer.from(unpacked.database.data, "base64").subarray(0, 15).toString()).toBe("SQLite format 3");
    hallAction({ action: "rename", id: second, name: "Змінений зал" });
    const result = restoreProjectArchive(bytes);
    expect(result.schedules).toBe(2);
    expect(exportHalls().halls.map(hall => hall.name).sort()).toEqual(["Другий зал", "Перший зал"]);
    expect(readProjectManifest(root).workspaceId).toBe(identity);
    expect(fs.existsSync(result.safetyBackup)).toBe(true);
  });

  it("rejects corrupted database checksums before altering current halls", async () => {
    hallAction({ action: "create", name: "Збережений зал" });
    const bytes = await exportProjectArchive();
    const envelope = JSON.parse(gunzipSync(bytes).toString());
    envelope.database.sha256 = "0".repeat(64);
    expect(() => restoreProjectArchive(gzipSync(JSON.stringify(envelope)))).toThrow("Контрольна сума");
    expect(exportHalls().halls[0].name).toBe("Збережений зал");
  });

  it("refuses traversal-shaped resources without extracting any paths", async () => {
    hallAction({ action: "create", name: "Збережений зал" });
    const envelope = JSON.parse(gunzipSync(await exportProjectArchive()).toString());
    envelope.assets = [{ reference: "../../outside.png", dataUrl: "data:image/png;base64,AA==" }];
    expect(() => restoreProjectArchive(gzipSync(JSON.stringify(envelope)))).toThrow("ресурс");
    expect(exportHalls().halls[0].name).toBe("Збережений зал");
  });

  it("cancels restore when the mandatory target safety backup cannot be written", async () => {
    const id = hallAction({ action: "create", name: "Оригінал" }).activeScheduleId;
    const bytes = await exportProjectArchive();
    hallAction({ action: "rename", id, name: "Поточний стан" });
    fs.rmSync(path.join(root, "backups"), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, "backups"), "blocked");
    expect(() => restoreProjectArchive(bytes)).toThrow("резервну копію");
    expect(exportHalls().halls[0].name).toBe("Поточний стан");
    expect(getDb().$client.pragma("foreign_key_check")).toEqual([]);
  });
});
