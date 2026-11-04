import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupsDirectory, createProject, projectPaths, readProjectManifest, resolveDatabasePath } from "@/db/paths";

const temporary: string[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "risen-project-")); temporary.push(root); return root; }
afterEach(() => { vi.unstubAllEnvs(); for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("project paths and identity", () => {
  it("creates an external portable project and preserves identity on reopen", () => {
    const root = path.join(fixture(), "Проєкт з пробілами");
    const first = createProject(root);
    expect(readProjectManifest(root)).toEqual(first);
    expect(createProject(root)).toEqual(first);
    for (const folder of ["data", "assets/logos", "backups", "exports", "logs"]) expect(fs.statSync(path.join(root, folder)).isDirectory()).toBe(true);
    vi.stubEnv("RISEN_WORKSPACE_PATH", root);
    vi.stubEnv("RISEN_DB_PATH", "");
    expect(resolveDatabasePath()).toBe(projectPaths(root).database);
    expect(backupsDirectory()).toBe(projectPaths(root).backups);
  });
  it("preserves explicit legacy database overrides and backup locations", () => {
    const root = fixture(), database = path.join(root, "legacy.db");
    vi.stubEnv("RISEN_WORKSPACE_PATH", path.join(root, "project"));
    vi.stubEnv("RISEN_DB_PATH", database);
    expect(resolveDatabasePath()).toBe(database);
    expect(backupsDirectory()).toBe(path.join(root, "backups"));
  });
  it("refuses relative workspace paths, unknown folders and damaged manifests without fallback", () => {
    vi.stubEnv("RISEN_DB_PATH", "");
    vi.stubEnv("RISEN_WORKSPACE_PATH", "relative/project");
    expect(resolveDatabasePath).toThrow("absolute");
    const root = fixture();
    fs.writeFileSync(path.join(root, "existing.db"), "preserve me");
    expect(() => createProject(root)).toThrow("Legacy data");
    fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ format: "risen-team-project", formatVersion: 999 }));
    expect(() => createProject(root)).toThrow("unsupported");
    expect(fs.readFileSync(path.join(root, "existing.db"), "utf8")).toBe("preserve me");
  });
});
