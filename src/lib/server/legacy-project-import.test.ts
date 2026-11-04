import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabaseSchema } from "@/db/migrations";
import { createProject, projectPaths } from "@/db/paths";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Risen legacy пробіли ")); roots.push(root);
  const source = path.join(root, "old.db"); const project = path.join(root, "new project");
  const db = new Database(source); initializeDatabaseSchema(db, source);
  createProject(project);
  return { root, source, project, db };
}
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function copy(source: string, project: string) {
  return spawnSync(process.execPath, [path.resolve("native/import-legacy-project.cjs"), source, project], { encoding: "utf8", timeout: 10000 });
}

describe("explicit native legacy database copy", () => {
  it("publishes without hard links on portable filesystem volumes", () => {
    const { root, source, project, db } = fixture(); db.close();
    const hook = path.join(root, "no-hardlinks.cjs");
    fs.writeFileSync(hook, "require('node:fs').linkSync = () => { throw new Error('Hardlinks unavailable on this filesystem'); };\n");
    const result = spawnSync(process.execPath, ["--require", hook, path.resolve("native/import-legacy-project.cjs"), source, project], { encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(projectPaths(project).database)).toBe(true);
    expect(fs.readdirSync(path.join(project, "data"))).toEqual(["risen-team.db"]);
  });

  it("copies committed WAL data with the source database unchanged", () => {
    const { source, project, db } = fixture();
    try {
      db.pragma("journal_mode=WAL"); db.prepare("INSERT INTO app_meta(key,value) VALUES('legacy-copy-test','committed WAL')").run();
      const original = sha(source); const wal = sha(source + "-wal");
      const result = copy(source, project);
      expect(result.status, result.stderr).toBe(0);
      expect(sha(source)).toBe(original); expect(sha(source + "-wal")).toBe(wal);
      expect(fs.readdirSync(path.join(project, "data"))).toEqual(["risen-team.db"]);
      const copied = new Database(projectPaths(project).database, { readonly: true });
      try {
        expect(copied.pragma("user_version", { simple: true })).toBe(1);
        expect(copied.prepare("SELECT value FROM app_meta WHERE key='legacy-copy-test'").get()).toEqual({ value: "committed WAL" });
      } finally { copied.close(); }
    } finally { db.close(); }
  });

  it("refuses an existing target database and preserves both databases", () => {
    const { source, project, db } = fixture(); db.close();
    fs.writeFileSync(projectPaths(project).database, "existing client data");
    const original = sha(source);
    const result = copy(source, project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("new empty project");
    expect(fs.readFileSync(projectPaths(project).database, "utf8")).toBe("existing client data");
    expect(sha(source)).toBe(original);
  });

  it("refuses unsupported or arbitrary databases without publishing a target", () => {
    const { source, project, db } = fixture(); db.pragma("user_version=99"); db.close();
    const original = sha(source);
    const result = copy(source, project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("newer project");
    expect(fs.existsSync(projectPaths(project).database)).toBe(false); expect(sha(source)).toBe(original);
  });
});
