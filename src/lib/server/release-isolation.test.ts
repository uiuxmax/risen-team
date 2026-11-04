import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const temporary: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-release-isolation-"));
  temporary.push(dir);
  return dir;
}
function write(dir: string, relative: string, content = "") {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function copy(dir: string, relative: string) {
  write(dir, relative, fs.readFileSync(path.join(root, relative), "utf8"));
}
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("v1 release isolation", () => {
  it("stages a v1 manifest with independent data paths and excludes copied schedule data", () => {
    const dir = fixture();
    for (const file of ["scripts/prepare-portable.mjs", "scripts/windows-launcher.ps1", "start.bat", "start.command", "src/app/api/health/route.ts"]) copy(dir, file);
    write(dir, ".next/standalone/server.js", "// fixture server");
    write(dir, ".next/standalone/package.json", "{}");
    write(dir, ".next/static/chunks/main.js", "// fixture asset");
    write(dir, ".next/standalone/data/risen-team.db", "private schedule");
    write(dir, ".next/standalone/risen-team.db-wal", "private sidecar");
    write(dir, ".next/standalone/.env.local", "private config");
    const result = spawnSync(process.execPath, [path.join(dir, "scripts/prepare-portable.mjs")], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const bundle = path.join(dir, "dist/portable/RisenTeamSchedule");
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
    expect(manifest.app).toBe("risen-team-schedule-builder-v1");
    expect(manifest.server).toEqual({ hostname: "127.0.0.1", port: 3178, loopbackOnly: true });
    expect(manifest.dataDirectory).toMatchObject({ windows: "%LOCALAPPDATA%\\RisenTeamSchedule-v1.0", macos: "~/Library/Application Support/RisenTeamSchedule-v1.0", override: "RISEN_DB_PATH", packaged: false });
    for (const file of ["data", "risen-team.db-wal", ".env.local"]) expect(fs.existsSync(path.join(bundle, file))).toBe(false);
  });

  it("uses independent launcher identities and keeps the package lookup separate from data", () => {
    const windows = fs.readFileSync(path.join(root, "scripts/windows-launcher.ps1"), "utf8");
    const macos = fs.readFileSync(path.join(root, "start.command"), "utf8");
    for (const launcher of [windows, macos]) {
      expect(launcher).toContain("risen-team-schedule-builder-v1");
      expect(launcher).not.toContain("3177");
      expect(launcher).toContain("RisenTeamSchedule-v1.0");
    }
    expect(windows).toContain('dist\\portable\\$PackageFolderName\\server.js');
    expect(macos).toContain('$APP_ROOT/dist/portable/$PACKAGE_FOLDER_NAME/server.js');
  });

  it.skipIf(process.platform !== "win32")("resolves copied source data before OS defaults while preserving explicit overrides", () => {
    const dir = fixture();
    write(dir, "data/risen-team.db", "copied schedule");
    const launcher = path.join(root, "scripts/windows-launcher.ps1").replaceAll("'", "''");
    const script = `
$source = Get-Content -Raw -LiteralPath '${launcher}'
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-DatabasePath' }, $true)
Invoke-Expression $fn.Extent.Text
$AppRoot = $env:TEST_APP_ROOT
$DataFolderName = 'RisenTeamSchedule-v1.0'
$resolved = Resolve-DatabasePath 6>$null
Write-Output $resolved
`;
    const resolve = (override: string) => spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", env: { ...process.env, TEST_APP_ROOT: dir, LOCALAPPDATA: path.join(dir, "os-data"), RISEN_DB_PATH: override } });
    expect(resolve("").stdout.trim()).toBe(path.join(dir, "data/risen-team.db"));
    const explicit = path.join(dir, "explicit.db");
    expect(resolve(explicit).stdout.trim()).toBe(explicit);
    fs.rmSync(path.join(dir, "data/risen-team.db"));
    expect(resolve("").stdout.trim()).toBe(path.join(dir, "os-data/RisenTeamSchedule-v1.0/risen-team.db"));
  });


  it("CI initializes the native addon and verifies the v1 release contract on every OS", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/portable-release.yml"), "utf8");
    expect((workflow.match(/npm rebuild better-sqlite3 --foreground-scripts/g) ?? [])).toHaveLength(3);
    expect((workflow.match(/Verify v1 release contract/g) ?? [])).toHaveLength(3);
    expect(workflow).not.toContain("3177");
    expect(workflow).toContain("RisenTeamSchedule-v1.0");
  });

  it("rejects stale staging before bundling a runtime or relabeling a release", () => {
    const dir = fixture();
    copy(dir, "scripts/build-portable-release.mjs");
    copy(dir, "scripts/node-runtime-lock.json");
    copy(dir, "src/app/api/health/route.ts");
    for (const file of ["server.js", "package.json", "start.bat", "start.command", ".next/static/main.js", "node_modules/better-sqlite3/package.json"]) write(dir, `dist/portable/RisenTeamSchedule/${file}`, "{}");
    write(dir, "dist/portable/RisenTeamSchedule/manifest.json", JSON.stringify({ app: "risen-team-schedule-builder", server: { port: 3177 } }));
    const result = spawnSync(process.execPath, [path.join(dir, "scripts/build-portable-release.mjs"), "--target=win-x64"], { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Portable staging contract mismatch");
    expect(fs.existsSync(path.join(dir, "dist/releases"))).toBe(false);
  });
});
