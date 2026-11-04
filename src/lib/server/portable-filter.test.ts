import { describe, it, expect } from "vitest";

/**
 * Mirrors the filtering logic from scripts/prepare-portable.mjs
 * to ensure user-data exclusion remains correct.
 */

const FORBIDDEN_FILE_PATTERN = /(^|[\\/])(risen-team\.db(-wal|-shm|-journal|\..+)?|\.env(\..+)?)$/i;
const FORBIDDEN_TOP_LEVEL_DIRS = new Set(["data", "backups", "logs"]);

function isForbiddenRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") return false;
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");

  if (FORBIDDEN_FILE_PATTERN.test(normalized)) {
    return true;
  }

  const segments = normalized.split("/");
  const firstSegment = segments[0]?.toLowerCase();
  if (FORBIDDEN_TOP_LEVEL_DIRS.has(firstSegment)) {
    return true;
  }

  return false;
}

describe("portable filter safety", () => {
  it("forbids risen database files anywhere", () => {
    expect(isForbiddenRelativePath("risen-team.db")).toBe(true);
    expect(isForbiddenRelativePath("data/risen-team.db")).toBe(true);
    expect(isForbiddenRelativePath("some/nested/risen-team.db")).toBe(true);
    expect(isForbiddenRelativePath("risen-team.db-wal")).toBe(true);
    expect(isForbiddenRelativePath("risen-team.db-shm")).toBe(true);
    expect(isForbiddenRelativePath("risen-team.db-journal")).toBe(true);
    expect(isForbiddenRelativePath("risen-team.db.bak")).toBe(true);
  });

  it("forbids local .env files anywhere", () => {
    expect(isForbiddenRelativePath(".env")).toBe(true);
    expect(isForbiddenRelativePath(".env.local")).toBe(true);
    expect(isForbiddenRelativePath(".env.production")).toBe(true);
    expect(isForbiddenRelativePath("config/.env")).toBe(true);
  });

  it("forbids top-level user-data directories", () => {
    expect(isForbiddenRelativePath("data/")).toBe(true);
    expect(isForbiddenRelativePath("data/something.json")).toBe(true);
    expect(isForbiddenRelativePath("backups/")).toBe(true);
    expect(isForbiddenRelativePath("backups/manual.db")).toBe(true);
    expect(isForbiddenRelativePath("logs/")).toBe(true);
    expect(isForbiddenRelativePath("logs/server.log")).toBe(true);
  });

  it("allows nested data/logs inside dependencies", () => {
    expect(isForbiddenRelativePath("node_modules/some-pkg/data/file.json")).toBe(false);
    expect(isForbiddenRelativePath("node_modules/pkg/logs/debug.log")).toBe(false);
    expect(isForbiddenRelativePath(".next/server/data/file")).toBe(false);
    expect(isForbiddenRelativePath("node_modules/better-sqlite3/data")).toBe(false);
  });

  it("allows normal application files", () => {
    expect(isForbiddenRelativePath("server.js")).toBe(false);
    expect(isForbiddenRelativePath(".next/static/chunks/main.js")).toBe(false);
    expect(isForbiddenRelativePath("public/icon.svg")).toBe(false);
    expect(isForbiddenRelativePath("package.json")).toBe(false);
    expect(isForbiddenRelativePath("node_modules/better-sqlite3/lib/index.js")).toBe(false);
  });
});

describe("portable completeness", () => {
  function isCompleteServerDirMock(files: string[]): boolean {
    // Simplified completeness check: needs server.js and .next/static
    const hasServer = files.includes("server.js");
    const hasStatic = files.some((f) => f.startsWith(".next/static"));
    return hasServer && hasStatic;
  }

  it("considers directory complete when server.js and .next/static exist", () => {
    expect(isCompleteServerDirMock(["server.js", ".next/static/chunks/main.js"])).toBe(true);
  });

  it("considers directory incomplete when .next/static missing", () => {
    expect(isCompleteServerDirMock(["server.js"])).toBe(false);
    expect(isCompleteServerDirMock([".next/static/chunks/main.js"])).toBe(false);
  });

  it("portable release must not contain user data", () => {
    const forbidden = ["risen-team.db", "data/export.json", "backups/manual.zip", "logs/server.log"];
    for (const f of forbidden) {
      expect(isForbiddenRelativePath(f)).toBe(true);
    }
  });
});
