import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabaseForTests, getDb } from "@/db";
import { createProject, projectPaths } from "@/db/paths";
import { storeLogoDataUrl } from "@/lib/server/assets";
import type { BackupPayload } from "@/lib/server/backup-types";
import { exportBackup } from "@/lib/server/export-backup";
import {
  exportHalls, hallAction, importHalls, loadHallWorkspace,
  mutateHallCatalog, normalizeHallPackageLogos, restoreHallVersion, saveHallState,
} from "@/lib/server/halls";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
const previous = { workspace: process.env.RISEN_WORKSPACE_PATH, db: process.env.RISEN_DB_PATH };
let temporary: string;
let root: string;

beforeEach(() => {
  closeDatabaseForTests();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "risen-publish-backup-"));
  root = path.join(temporary, "source");
  createProject(root);
  process.env.RISEN_WORKSPACE_PATH = root;
  delete process.env.RISEN_DB_PATH;
});

afterEach(() => {
  closeDatabaseForTests();
  if (previous.workspace === undefined) delete process.env.RISEN_WORKSPACE_PATH;
  else process.env.RISEN_WORKSPACE_PATH = previous.workspace;
  if (previous.db === undefined) delete process.env.RISEN_DB_PATH;
  else process.env.RISEN_DB_PATH = previous.db;
  fs.rmSync(temporary, { recursive: true, force: true });
});

function populated() {
  const id = hallAction({ action: "create", name: "Publish backup" }).activeScheduleId!;
  mutateHallCatalog(id, "trainers", { trainer: { id: "trainer", name: "Trainer", color: "#112233", active: true, sortOrder: 0 }, classTypeIds: [] });
  mutateHallCatalog(id, "class_types", { id: "class", name: "Class", shortName: "Class", defaultDuration: 60, active: true, sortOrder: 0, trainerIds: ["trainer"] });
  const current = loadHallWorkspace(id);
  saveHallState({ hallId: id, scheduleId: id, revision: current.revision,
    settings: { ...current.state.settings, logoDataUrl: png },
    events: [{ id: "event", scheduleId: id, trainerId: "trainer", classTypeId: "class", dayOfWeek: 0, startTime: "10:00", endTime: "11:00" }],
    snapshot: true, changeDescription: "Logo checkpoint" });
  const checkpoint = exportHalls([id]).halls[0].versions.find(version => version.description === "Logo checkpoint")!;
  // Project migrations/imports retain immutable references inside history too.
  const reference = storeLogoDataUrl(root, png);
  checkpoint.snapshot.settings.logoDataUrl = reference;
  getDb().$client.prepare("UPDATE schedule_versions SET snapshot=? WHERE id=?").run(JSON.stringify(checkpoint.snapshot), checkpoint.id);
  return { id, reference };
}

function publish(id: string, logo: string | null = png) {
  const current = loadHallWorkspace(id);
  return saveHallState({ hallId: id, scheduleId: id, revision: current.revision,
    settings: { ...current.state.settings, logoDataUrl: logo }, events: current.state.events, status: "published" });
}

function backupFiles() {
  return fs.readdirSync(projectPaths(root).backups).filter(file => file.endsWith(".json"));
}

describe("publish safety backup portability", () => {
  it("imports the actual publish safety file with current and historical project logos into an isolated project", async () => {
    const { id, reference } = populated();
    expect(publish(id).status).toBe("published");
    expect(backupFiles()).toHaveLength(1);
    const backup = JSON.parse(fs.readFileSync(path.join(projectPaths(root).backups, backupFiles()[0]), "utf8")) as BackupPayload & { safetyReason: string };
    expect(backup.safetyReason).toBe("publish");
    // Exercise the same normalization boundary as the supported HTTP importer.
    const normalized = await normalizeHallPackageLogos(backup);
    expect(backup.settings.find(settings => settings.scheduleId === id)?.logoDataUrl).toBe(png);
    expect(backup.versions.find(version => version.description === "Logo checkpoint")?.snapshot.settings.logoDataUrl).toBe(png);
    expect(backup.versions.some(version => version.source === "publish")).toBe(true);
    // Serialization must not rewrite references in the source database.
    expect((getDb().$client.prepare("SELECT logo_data_url AS logo FROM schedule_settings WHERE schedule_id=?").get(id) as { logo: string }).logo).toBe(reference);
    const stored = JSON.parse((getDb().$client.prepare("SELECT snapshot FROM schedule_versions WHERE description='Logo checkpoint'").get() as { snapshot: string }).snapshot);
    expect(stored.settings.logoDataUrl).toBe(reference);
    closeDatabaseForTests();
    const sourceBytes = fs.readFileSync(projectPaths(root).database);

    const destination = path.join(temporary, "destination");
    createProject(destination);
    process.env.RISEN_WORKSPACE_PATH = destination;
    importHalls(normalized);
    const imported = exportHalls().halls[0];
    expect(imported.snapshot.settings.logoDataUrl).toBe(png);
    expect(imported.snapshot.events).toHaveLength(1);
    expect(imported.versions.some(version => version.source === "publish")).toBe(true);
    const restored = imported.versions.find(version => version.description === "Logo checkpoint")!;
    expect(restored.snapshot.settings.logoDataUrl).toBe(png);
    restoreHallVersion(imported.id, restored.id);
    expect(loadHallWorkspace(imported.id).state.settings.logoDataUrl).toBe(png);
    expect(fs.existsSync(path.join(destination, reference))).toBe(true);
    expect(fs.readFileSync(projectPaths(root).database)).toEqual(sourceBytes);
  });

  it("refuses an incomplete export when a historical logo asset is missing", () => {
    const { id, reference } = populated();
    const current = loadHallWorkspace(id);
    saveHallState({ hallId: id, scheduleId: id, revision: current.revision,
      settings: { ...current.state.settings, logoDataUrl: null }, events: current.state.events });
    fs.unlinkSync(path.join(root, reference));
    expect(() => exportBackup()).toThrow();
    expect(backupFiles()).toEqual([]);
  });

  it("still publishes and increments revision when a historical logo cannot be serialized for its convenience backup", () => {
    const { id, reference } = populated();
    const current = loadHallWorkspace(id);
    saveHallState({ hallId: id, scheduleId: id, revision: current.revision,
      settings: { ...current.state.settings, logoDataUrl: null }, events: current.state.events });
    fs.unlinkSync(path.join(root, reference));
    const revision = loadHallWorkspace(id).revision!;
    expect(publish(id, null)).toMatchObject({ status: "published", revision: revision + 1 });
    const after = loadHallWorkspace(id);
    expect(after.state.schedule.status).toBe("published");
    expect(after.revision).toBe(revision + 1);
    expect(after.versions.some(version => version.source === "publish")).toBe(true);
    expect(backupFiles()).toEqual([]);
  });

  it("still publishes with a project logo when the backup directory cannot be written", () => {
    const { id } = populated();
    const revision = loadHallWorkspace(id).revision!;
    fs.rmdirSync(projectPaths(root).backups);
    fs.writeFileSync(projectPaths(root).backups, "blocked");
    expect(publish(id)).toMatchObject({ status: "published", revision: revision + 1 });
    expect(loadHallWorkspace(id).state.settings.logoDataUrl).toBe(png);
    expect(loadHallWorkspace(id).versions.some(version => version.source === "publish")).toBe(true);
  });
});
