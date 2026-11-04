#!/usr/bin/env node
/**
 * Deterministic portable staging for Risen Team Schedule Builder.
 *
 * `npm run prepare:portable` takes an existing production build and lays it out
 * as a self-contained, launchable folder:
 *
 *   dist/portable/RisenTeamSchedule/
 *     server.js                 <- Next.js standalone entry
 *     package.json
 *     node_modules/             <- pruned, includes the better-sqlite3 addon
 *     .next/server/             <- standalone server chunks
 *     .next/static/             <- copied in; Next does not do this itself
 *     public/                   <- copied in; Next does not do this itself
 *     start.bat                 <- Windows launcher
 *     start.command             <- macOS launcher
 *     scripts/windows-launcher.ps1
 *     manifest.json             <- deterministic description of the bundle
 *
 * Deliberate boundaries:
 *
 *   - This script does NOT build. It stages a build that already exists and
 *     fails with instructions when it does not, so a packaging step can never
 *     silently ship a stale or partial bundle.
 *   - The output is deterministic: the same inputs produce the same tree and
 *     the same manifest. No timestamps, no absolute paths, no machine-specific
 *     values are recorded, and file lists are always sorted.
 *   - User data is never packaged. No SQLite database, no WAL/SHM/journal
 *     sidecars, no `backups/`, no launcher logs and no local `.env` may appear
 *     in the staged folder. That is asserted, not merely assumed, and the
 *     script fails if the assertion is violated.
 *   - No Node runtime is bundled yet. The launchers already look for
 *     `runtime/node/` first, which is the hook the future portable-release
 *     phase will fill in; this script records `bundledNode: false` instead of
 *     inventing a directory that is not there.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PORT = 3178;
const HOSTNAME = "127.0.0.1";
const APP_DIR_NAME = "RisenTeamSchedule";
const MINIMUM_NODE_MAJOR = 22;

const STANDALONE_DIR = path.join(ROOT, ".next", "standalone");
const STATIC_DIR = path.join(ROOT, ".next", "static");
const PUBLIC_DIR = path.join(ROOT, "public");
const STAGING_ROOT = path.join(ROOT, "dist", "portable");
const OUTPUT_DIR = path.join(STAGING_ROOT, APP_DIR_NAME);

const LAUNCHER_FILES = [
  "start.bat",
  "start.command",
  path.join("scripts", "windows-launcher.ps1"),
];

/**
 * Anything matching these is user data or local config and must never ship.
 *
 * Explicit rules:
 *   1. Forbidden files anywhere in the bundle:
 *      - SQLite database files and sidecars (risen-team.db, -wal, -shm, -journal, .bak, etc.)
 *      - Local environment variable files (.env, .env.local, .env.production, etc.)
 *   2. Forbidden top-level directories:
 *      - data/, backups/, logs/ at the root of the staged bundle or standalone output,
 *        representing actual Risen user data or runtime logs.
 *
 * Allowed:
 *   - Nested directories named data/, logs/, etc. within runtime dependencies or
 *     framework files (e.g. node_modules/<package>/data/..., node_modules/<package>/logs/...).
 */
const FORBIDDEN_FILE_PATTERN = /(^|[\\/])(risen-team\.db(-wal|-shm|-journal|\..+)?|\.env(\..+)?)$/i;
const FORBIDDEN_TOP_LEVEL_DIRS = new Set(["data", "backups", "logs"]);

function isForbiddenRelativePath(relativePath) {
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

function fail(message) {
  console.error(`\n[prepare-portable] ${message}\n`);
  process.exit(1);
}

/**
 * The application identity is read back from the health route instead of being
 * duplicated here. The launchers use that exact string to tell Risen apart from
 * an unrelated listener on port 3178, so a bundle must never be able to carry a
 * stale copy of it.
 */
function readAppIdentity() {
  const routePath = path.join(ROOT, "src", "app", "api", "health", "route.ts");
  if (!fs.existsSync(routePath)) {
    fail(`Cannot find the health route at ${path.relative(ROOT, routePath)}.`);
  }
  const source = fs.readFileSync(routePath, "utf8");
  const match = source.match(/export const APP_IDENTITY\s*=\s*"([^"]+)"/);
  if (!match) {
    fail(
      `Cannot read APP_IDENTITY from ${path.relative(ROOT, routePath)}. ` +
        'Expected: export const APP_IDENTITY = "risen-team-schedule-builder-v1";',
    );
  }
  return match[1];
}

function requireDirectory(dir, what, hint) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`${what} is missing:\n  ${dir}\n\n${hint}`);
  }
}

function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  walk(dir);
  return found;
}

const APP_IDENTITY = readAppIdentity();

console.log("[prepare-portable] Staging a portable bundle");
console.log(`  application identity : ${APP_IDENTITY}`);
console.log(`  server              : ${HOSTNAME}:${PORT} (loopback only)`);

requireDirectory(
  STANDALONE_DIR,
  "The Next.js standalone build output",
  "Run `npm run build` first. `next.config.ts` must keep `output: \"standalone\"`.",
);
if (!fs.existsSync(path.join(STANDALONE_DIR, "server.js"))) {
  fail(
    `server.js is missing from ${STANDALONE_DIR}.\n\n` +
      "Run `npm run build` again with `output: \"standalone\"` in next.config.ts.",
  );
}
requireDirectory(STATIC_DIR, "The Next.js static build output", "Run `npm run build` first.");

for (const relative of LAUNCHER_FILES) {
  if (!fs.existsSync(path.join(ROOT, relative))) {
    fail(`Required launcher file is missing: ${relative}`);
  }
}

// ---------------------------------------------------------------------------
// Stage from an empty directory so a previous run can never leak into this one.
// ---------------------------------------------------------------------------
fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const copyStandaloneFilter = (source) => {
  const relative = path.relative(STANDALONE_DIR, source);
  return !isForbiddenRelativePath(relative);
};

const copyStaticFilter = (source) => {
  const relative = path.join(".next", "static", path.relative(STATIC_DIR, source));
  return !isForbiddenRelativePath(relative);
};

const copyPublicFilter = (source) => {
  const relative = path.join("public", path.relative(PUBLIC_DIR, source));
  return !isForbiddenRelativePath(relative);
};

console.log("  copying standalone server (dereferencing symlinks for Windows compatibility) ...");
fs.cpSync(STANDALONE_DIR, OUTPUT_DIR, {
  recursive: true,
  filter: copyStandaloneFilter,
  dereference: true,
  // On Windows, recreating symlinks requires admin/dev-mode. Dereferencing ensures
  // the portable bundle contains real files, not links back to the source checkout.
});

console.log("  copying .next/static ...");
fs.cpSync(STATIC_DIR, path.join(OUTPUT_DIR, ".next", "static"), {
  recursive: true,
  filter: copyStaticFilter,
  dereference: true,
});

if (fs.existsSync(PUBLIC_DIR)) {
  console.log("  copying public ...");
  fs.cpSync(PUBLIC_DIR, path.join(OUTPUT_DIR, "public"), {
    recursive: true,
    filter: copyPublicFilter,
    dereference: true,
  });
} else {
  console.log("  no public/ directory to copy (skipped)");
}

// ---------------------------------------------------------------------------
// Windows symlink EPERM guard: verify better-sqlite3 is a real directory tree,
// not a symlink/junction back to the source checkout.
// ---------------------------------------------------------------------------
function assertNotSymlink(targetPath, description) {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(targetPath);
    fail(
      `${description} is still a symlink in the portable bundle:\\n` +
        `  ${targetPath} -> ${linkTarget}\\n\\n` +
        "The staging must dereference symlinks so the bundle is self-contained and works without admin rights on Windows.",
    );
  }
}

function assertNoForbiddenSymlinks(dir) {
  const forbidden = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      let lstat;
      try {
        lstat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) {
        let target = "";
        try {
          target = fs.readlinkSync(full);
        } catch {
          target = "<unreadable>";
        }
        // Any symlink that points outside the bundle or back to source checkout is forbidden.
        // With dereference:true there should be no symlinks at all for native deps, but we
        // explicitly check better-sqlite3 and any link that escapes the bundle.
        const resolved = path.resolve(path.dirname(full), target);
        const isInside = resolved.startsWith(path.resolve(OUTPUT_DIR) + path.sep) || resolved === path.resolve(OUTPUT_DIR);
        const pointsToSource =
          resolved.includes(`${path.sep}node_modules${path.sep}`) ||
          resolved.includes(`${path.sep}.next${path.sep}`) ||
          resolved.startsWith(ROOT + path.sep);
        if (!isInside || pointsToSource || full.toLowerCase().includes("better-sqlite3")) {
          forbidden.push(`${path.relative(OUTPUT_DIR, full)} -> ${target}`);
        }
      }
      if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
        walk(full);
      }
    }
  };
  walk(dir);
  if (forbidden.length > 0) {
    fail(
      "Portable bundle contains symlinks that point outside the bundle or back to the source checkout:\\n  " +
        forbidden.join("\\n  ") +
        "\\n\\nThe bundle must contain real copied files, not symlinks. Ensure fs.cpSync uses dereference:true.",
    );
  }
}

// Specific check for better-sqlite3 - the package that triggered EPERM on Windows.
const betterSqlitePaths = [
  path.join(OUTPUT_DIR, "node_modules", "better-sqlite3"),
  path.join(OUTPUT_DIR, ".next", "standalone", "node_modules", "better-sqlite3"),
];
for (const p of betterSqlitePaths) {
  assertNotSymlink(p, "better-sqlite3");
}
assertNoForbiddenSymlinks(OUTPUT_DIR);

for (const relative of LAUNCHER_FILES) {
  const destination = path.join(OUTPUT_DIR, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(ROOT, relative), destination);
}

// The macOS launcher must stay executable inside the staged bundle too.
if (process.platform !== "win32") {
  fs.chmodSync(path.join(OUTPUT_DIR, "start.command"), 0o755);
}

// ---------------------------------------------------------------------------
// Assert the staged bundle is complete and free of user data.
// ---------------------------------------------------------------------------
const stagedFiles = listFiles(OUTPUT_DIR);
const stagedRelative = stagedFiles.map((file) => path.relative(OUTPUT_DIR, file)).sort();

const violations = stagedRelative.filter((relative) => isForbiddenRelativePath(relative));
if (violations.length > 0) {
  fail(
    "User data or local configuration was staged into the bundle:\n  " +
      violations.join("\n  ") +
      "\n\nNothing user-specific may be packaged. Remove it from the build output and re-run.",
  );
}

for (const required of ["server.js", "package.json", path.join(".next", "static")]) {
  if (!fs.existsSync(path.join(OUTPUT_DIR, required))) {
    fail(`Staged bundle is incomplete: ${required} is missing.`);
  }
}
for (const relative of LAUNCHER_FILES) {
  if (!fs.existsSync(path.join(OUTPUT_DIR, relative))) {
    fail(`Staged bundle is incomplete: ${relative} is missing.`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic manifest: sorted, hashed, no timestamps and no absolute paths.
// ---------------------------------------------------------------------------
const entries = stagedRelative.map((relative) => {
  const absolute = path.join(OUTPUT_DIR, relative);
  const bytes = fs.readFileSync(absolute);
  return {
    path: relative.split(path.sep).join("/"),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

const manifest = {
  app: APP_IDENTITY,
  layout: "next-standalone",
  entry: "server.js",
  server: { hostname: HOSTNAME, port: PORT, loopbackOnly: true },
  dataDirectory: {
    windows: "%LOCALAPPDATA%\\RisenTeamSchedule-v1.0",
    macos: "~/Library/Application Support/RisenTeamSchedule-v1.0",
    override: "RISEN_DB_PATH",
    packaged: false,
  },
  runtime: {
    bundledNode: false,
    bundledNodePath: { windows: "runtime\\node\\node.exe", macos: "runtime/node/bin/node" },
    fallback: "system node",
    minimumNodeMajor: MINIMUM_NODE_MAJOR,
  },
  launchers: LAUNCHER_FILES.map((relative) => relative.split(path.sep).join("/")).sort(),
  files: entries,
  totals: { files: entries.length, bytes: totalBytes },
};

fs.writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log("");
console.log(`[prepare-portable] Staged ${entries.length} files (${(totalBytes / 1024 / 1024).toFixed(1)} MB) into:`);
console.log(`  ${path.relative(ROOT, OUTPUT_DIR)}`);
console.log("[prepare-portable] Start it with start.bat (Windows) or ./start.command (macOS).");
console.log("[prepare-portable] The launcher will run it on http://127.0.0.1:3178 only.");
