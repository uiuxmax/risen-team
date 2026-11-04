#!/usr/bin/env node
/**
 * Build self-contained portable releases with bundled Node.js runtime.
 *
 * Usage:
 *   npm run release:portable -- --target=win-x64
 *   npm run release:portable -- --target=darwin-arm64
 *   npm run release:portable -- --target=darwin-x64
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import https from "node:https";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "scripts", "node-runtime-lock.json");
const PORTABLE_DIR = path.join(ROOT, "dist", "portable", "RisenTeamSchedule");
const CACHE_DIR = path.join(ROOT, "dist", "cache", "node-runtime");
const RELEASES_ROOT = path.join(ROOT, "dist", "releases");
const DIST_ROOT = path.join(ROOT, "dist");

const ALLOWED_TARGETS = ["win-x64", "darwin-arm64", "darwin-x64"];

function fail(msg) {
  console.error(`\n[release:portable] ${msg}\n`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let target = null;
  for (const arg of args) {
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  node scripts/build-portable-release.mjs --target=<target>

Targets:
  win-x64
  darwin-arm64
  darwin-x64
`);
      process.exit(0);
    }
  }
  if (!target) fail("Missing --target. Use --target=win-x64|darwin-arm64|darwin-x64");
  if (!ALLOWED_TARGETS.includes(target)) fail(`Invalid target '${target}'. Allowed: ${ALLOWED_TARGETS.join(", ")}`);
  return target;
}

function readLock() {
  if (!fs.existsSync(LOCK_PATH)) fail(`Runtime lock file not found: ${LOCK_PATH}`);
  const raw = fs.readFileSync(LOCK_PATH, "utf8");
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (e) {
    fail(`Invalid JSON in lock file: ${e.message}`);
  }
  if (!lock.version) fail("Lock file missing version");
  if (!lock.targets) fail("Lock file missing targets");
  return lock;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function downloadFileOnce(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error(`Redirect without location for ${url}`));
          return;
        }
        file.close();
        try {
          fs.unlinkSync(destPath);
        } catch {}
        downloadFileOnce(redirectUrl, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve());
      });
    });
    request.on("error", (err) => {
      try {
        fs.unlinkSync(destPath);
      } catch {}
      reject(err);
    });
    file.on("error", (err) => {
      try {
        fs.unlinkSync(destPath);
      } catch {}
      reject(err);
    });
  });
}

async function downloadFile(url, destPath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await downloadFileOnce(url, destPath);
      return;
    } catch (err) {
      console.log(`  download attempt ${attempt} failed: ${err.message}`);
      try {
        fs.rmSync(destPath, { force: true });
      } catch {}
      if (attempt === retries) throw err;
      const delay = attempt * 1000;
      console.log(`  retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function ensureNodeArchive(targetInfo) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const archivePath = path.join(CACHE_DIR, targetInfo.filename);
  const expectedSha = targetInfo.sha256.toLowerCase();
  const skipChecksum = process.env.SKIP_CHECKSUM === "1" || process.env.SKIP_CHECKSUM === "true";

  if (fs.existsSync(archivePath)) {
    if (skipChecksum) {
      console.log(`  using cached archive (checksum skipped): ${archivePath}`);
      return archivePath;
    }
    const existingSha = sha256File(archivePath).toLowerCase();
    if (existingSha === expectedSha) {
      console.log(`  using cached archive: ${archivePath}`);
      console.log(`  SHA-256 verified (cached): ${existingSha}`);
      return archivePath;
    } else {
      console.log(`  cached archive checksum mismatch, re-downloading...`);
      console.log(`    expected: ${expectedSha}`);
      console.log(`    actual:   ${existingSha}`);
      fs.rmSync(archivePath, { force: true });
    }
  }

  console.log(`  downloading ${targetInfo.url}`);
  console.log(`  -> ${archivePath}`);

  try {
    await downloadFile(targetInfo.url, archivePath);
  } catch (err) {
    console.log(`  native https download failed: ${err.message}`);
    console.log(`  trying curl fallback...`);
    const curlResult = spawnSync("curl", ["-L", "--fail", "-o", archivePath, targetInfo.url], { stdio: "inherit" });
    if (curlResult.status !== 0 || !fs.existsSync(archivePath)) {
      console.log(`  curl failed, trying wget...`);
      const wgetResult = spawnSync("wget", ["-O", archivePath, targetInfo.url], { stdio: "inherit" });
      if (wgetResult.status !== 0 || !fs.existsSync(archivePath)) {
        throw new Error(`All download methods failed for ${targetInfo.url}: ${err.message}`);
      }
    }
  }

  if (skipChecksum) {
    console.log(`  skipping checksum verification (SKIP_CHECKSUM=1)`);
    return archivePath;
  }

  const actualSha = sha256File(archivePath).toLowerCase();
  if (actualSha !== expectedSha) {
    fs.rmSync(archivePath, { force: true });
    fail(
      `Checksum mismatch for ${targetInfo.filename}:\n` +
        `  expected: ${expectedSha}\n` +
        `  actual:   ${actualSha}\n` +
        `  URL: ${targetInfo.url}\n` +
        `Build fails on checksum mismatch as required.`,
    );
  }
  console.log(`  SHA-256 verified: ${actualSha}`);
  return archivePath;
}

function extractArchive(archivePath, target, runtimeNodeDir) {
  console.log(`  [${new Date().toISOString()}] extracting ${path.basename(archivePath)} to ${runtimeNodeDir}`);
  fs.mkdirSync(runtimeNodeDir, { recursive: true });

  // Clean existing runtime
  fs.rmSync(runtimeNodeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeNodeDir, { recursive: true });
  console.log(`  archive size: ${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB`);

  // Use temp dir for all targets to handle top-level folder case (official Node archives contain folder like node-v22.23.2-win-x64/)
  const tempExtractDir = path.join(path.dirname(runtimeNodeDir), `_tmp_extract_${target.replace(/[^a-z0-9]/gi, "_")}`);
  fs.rmSync(tempExtractDir, { recursive: true, force: true });
  fs.mkdirSync(tempExtractDir, { recursive: true });

  if (target === "win-x64") {
    if (process.platform === "win32") {
      const psCmd = `Expand-Archive -Path "${archivePath}" -DestinationPath "${tempExtractDir}" -Force`;
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: "inherit" });
    } else {
      const result = spawnSync("unzip", ["-o", archivePath, "-d", tempExtractDir], { stdio: "inherit" });
      if (result.status !== 0) {
        fail(`Failed to extract ZIP archive ${archivePath}. Ensure 'unzip' is available.`);
      }
    }
  } else {
    const tarResult = spawnSync("tar", ["-xzf", archivePath, "-C", tempExtractDir], { stdio: "inherit" });
    if (tarResult.status !== 0) {
      fail(`Failed to extract tar.gz archive ${archivePath}. Ensure 'tar' is available.`);
    }
  }

  const entries = fs.readdirSync(tempExtractDir);
  console.log(`  extracted entries: ${entries.join(", ")}`);
  if (entries.length === 0) fail(`Extracted archive is empty: ${tempExtractDir}`);

  let sourceDir = tempExtractDir;
  // If single top-level directory contains the runtime, use it
  if (entries.length === 1) {
    const single = path.join(tempExtractDir, entries[0]);
    if (fs.statSync(single).isDirectory()) {
      // For win-x64, check for node.exe inside
      if (target === "win-x64" && fs.existsSync(path.join(single, "node.exe"))) {
        sourceDir = single;
        console.log(`  detected top-level folder ${entries[0]} with node.exe, using as source`);
      } else if (target.startsWith("darwin-") && fs.existsSync(path.join(single, "bin", "node"))) {
        sourceDir = single;
        console.log(`  detected top-level folder ${entries[0]} with bin/node, using as source`);
      } else if (entries[0].startsWith("node-")) {
        // Generic case: official Node archives use node-vX.X.X-... folder
        sourceDir = single;
        console.log(`  detected Node top-level folder ${entries[0]}, using as source`);
      }
    }
  } else {
    // Multiple entries - look for subfolder containing expected binary
    if (target === "win-x64" && !fs.existsSync(path.join(tempExtractDir, "node.exe"))) {
      for (const entry of entries) {
        const candidate = path.join(tempExtractDir, entry);
        if (fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, "node.exe"))) {
          sourceDir = candidate;
          console.log(`  found node.exe in subfolder ${entry}`);
          break;
        }
      }
    }
    if (target.startsWith("darwin-") && !fs.existsSync(path.join(tempExtractDir, "bin", "node"))) {
      for (const entry of entries) {
        const candidate = path.join(tempExtractDir, entry);
        if (fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, "bin", "node"))) {
          sourceDir = candidate;
          console.log(`  found bin/node in subfolder ${entry}`);
          break;
        }
      }
    }
  }

  console.log(`  [${new Date().toISOString()}] copying from ${sourceDir} to ${runtimeNodeDir}`);
  fs.cpSync(sourceDir, runtimeNodeDir, { recursive: true, dereference: true });
  console.log(`  [${new Date().toISOString()}] copy finished, cleaning temp`);
  fs.rmSync(tempExtractDir, { recursive: true, force: true });
  console.log(`  [${new Date().toISOString()}] extraction complete`);

  if (target.startsWith("darwin-")) {
    const binPath = path.join(runtimeNodeDir, "bin", "node");
    if (fs.existsSync(binPath)) {
      try {
        fs.chmodSync(binPath, 0o755);
      } catch {}
    }
  }
}

function verifyBundledNode(target, runtimeNodeDir, expectedVersion) {
  let nodeExe;
  if (target === "win-x64") {
    nodeExe = path.join(runtimeNodeDir, "node.exe");
  } else {
    nodeExe = path.join(runtimeNodeDir, "bin", "node");
  }

  if (!fs.existsSync(nodeExe)) {
    // Debug: list runtime dir
    console.log(`  runtime dir listing for ${runtimeNodeDir}:`);
    try {
      const list = fs.readdirSync(runtimeNodeDir);
      console.log(`    ${list.join(", ")}`);
      // Recursively list a bit
      for (const entry of list.slice(0, 20)) {
        const full = path.join(runtimeNodeDir, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            console.log(`    ${entry}/: ${fs.readdirSync(full).slice(0, 20).join(", ")}`);
          }
        } catch {}
      }
    } catch (e) {
      console.log(`    failed to list: ${e.message}`);
    }
    fail(`Bundled Node executable not found: ${nodeExe}`);
  }
  console.log(`  bundled Node exists: ${nodeExe}`);

  let shouldRun = false;
  if (target === "win-x64" && process.platform === "win32") shouldRun = true;
  if (target.startsWith("darwin-") && process.platform === "darwin") shouldRun = true;

  if (shouldRun) {
    console.log(`  running bundled Node --version ...`);
    const result = spawnSync(nodeExe, ["--version"], { encoding: "utf8" });
    if (result.status !== 0) {
      fail(`Bundled Node --version failed: ${result.stderr || result.stdout}`);
    }
    const versionOutput = result.stdout.trim();
    console.log(`  bundled Node version: ${versionOutput}`);
    const expected = `v${expectedVersion}`;
    if (versionOutput !== expected) {
      fail(`Bundled Node version mismatch: expected ${expected}, got ${versionOutput}`);
    }

    const archResult = spawnSync(nodeExe, ["-p", "process.arch"], { encoding: "utf8" });
    if (archResult.status === 0) {
      const arch = archResult.stdout.trim();
      console.log(`  bundled Node arch: ${arch}`);
      const expectedArch = target.endsWith("arm64") ? "arm64" : "x64";
      if (arch !== expectedArch) {
        fail(`Bundled Node arch mismatch for target ${target}: expected ${expectedArch}, got ${arch}`);
      }
    }
  } else {
    console.log(`  skipping bundled Node execution (cross-platform build: current ${process.platform} vs target ${target})`);
    try {
      const stat = fs.statSync(nodeExe);
      if (stat.size < 1024 * 1024) {
        console.log(`  warning: bundled Node binary seems small (${stat.size} bytes)`);
      }
    } catch {}
  }

  return nodeExe;
}

function getGitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function generateReadme(target) {
  if (target === "win-x64") {
    return `Risen Team Schedule Builder

1. Extract the complete ZIP.
2. Keep all files together.
3. Double-click start.bat.
4. Your default browser opens automatically.

Your schedule data is stored separately in:

%LOCALAPPDATA%\\RisenTeamSchedule-v1.0

No Node.js installation is required.

Notes:
- This is a portable release: no installer, no admin rights, no system Node.js needed.
- The application runs a local server on http://127.0.0.1:3178 only.
- Replacing or deleting the application folder does NOT delete your schedule database.
- This build is not code-signed; Windows may show a SmartScreen warning on first launch. This is expected for unsigned portable apps.

Target: ${target}
`;
  } else {
    return `Risen Team Schedule Builder

1. Extract the complete ZIP.
2. Keep all files together.
3. Double-click start.command.
4. Your default browser opens automatically.

Your schedule data is stored separately in:

~/Library/Application Support/RisenTeamSchedule-v1.0

No Node.js or Homebrew installation is required.

Notes:
- This is a portable release: no installer, no admin rights, no system Node.js needed.
- The application runs a local server on http://127.0.0.1:3178 only.
- Replacing or deleting the application folder does NOT delete your schedule database.
- This build is not signed or notarized; macOS may show a Gatekeeper warning on first launch.
  Right-click start.command and choose Open, or allow it in System Settings > Privacy & Security.
  Do NOT disable Gatekeeper globally.

Target: ${target}
`;
  }
}

function createZip(sourceDir, zipPath, target) {
  console.log(`  creating ZIP: ${zipPath}`);
  console.log(`  [${new Date().toISOString()}] ZIP creation started`);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });

  const startCommandPath = path.join(sourceDir, "start.command");
  if (fs.existsSync(startCommandPath)) {
    try {
      fs.chmodSync(startCommandPath, 0o755);
    } catch {}
  }

  if (process.platform === "win32") {
    // Use Fastest compression on Windows to avoid long hangs
    const psCmd = `Compress-Archive -Path "${sourceDir}" -DestinationPath "${zipPath}" -Force -CompressionLevel Fastest`;
    console.log(`  running: ${psCmd}`);
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: "inherit" });
  } else {
    const parent = path.dirname(sourceDir);
    const folderName = path.basename(sourceDir);
    console.log(`  running: zip -r -y ${zipPath} ${folderName} in ${parent}`);
    const result = spawnSync("zip", ["-r", "-y", zipPath, folderName], {
      cwd: parent,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      fail(`Failed to create ZIP ${zipPath}`);
    }
  }
  console.log(`  [${new Date().toISOString()}] ZIP creation finished, size ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
  const target = process.argv.slice(2).find((a) => a.startsWith("--target="))?.slice("--target=".length);
  if (!target) fail("Missing --target. Use --target=win-x64|darwin-arm64|darwin-x64");
  if (!["win-x64", "darwin-arm64", "darwin-x64"].includes(target)) fail(`Invalid target '${target}'`);

  console.log(`[release:portable] Building portable release for target: ${target}`);

  const lock = readLock();
  const targetInfo = lock.targets[target];
  if (!targetInfo) fail(`Target ${target} not found in lock file`);

  console.log(`  Node version pinned: ${lock.version}`);
  console.log(`  archive: ${targetInfo.filename}`);
  console.log(`  URL: ${targetInfo.url}`);
  console.log(`  SHA-256: ${targetInfo.sha256}`);

  if (!fs.existsSync(PORTABLE_DIR)) {
    fail(`Portable staging not found: ${PORTABLE_DIR}\nRun npm run build && npm run prepare:portable first.`);
  }
  const requiredFiles = ["server.js", "package.json", "start.bat", "start.command", "manifest.json"];
  for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(PORTABLE_DIR, f))) {
      fail(`Portable staging incomplete: missing ${f} in ${PORTABLE_DIR}`);
    }
  }
  if (!fs.existsSync(path.join(PORTABLE_DIR, ".next", "static"))) {
    fail(`Portable staging incomplete: .next/static missing in ${PORTABLE_DIR}`);
  }
  if (!fs.existsSync(path.join(PORTABLE_DIR, "node_modules", "better-sqlite3"))) {
    fail(`Portable staging incomplete: better-sqlite3 missing in ${PORTABLE_DIR}`);
  }

  // Refuse stale staging before copying files or downloading a runtime. A fresh
  // source identity must never relabel an older staged application as v1.
  let baseManifest;
  try {
    baseManifest = JSON.parse(fs.readFileSync(path.join(PORTABLE_DIR, "manifest.json"), "utf8"));
  } catch {
    fail("Portable staging contract mismatch: manifest.json is invalid. Run npm run prepare:portable again.");
  }
  const appIdentity = "risen-team-schedule-builder-v1";
  if (
    baseManifest.app !== appIdentity ||
    baseManifest.server?.port !== 3178 ||
    baseManifest.server?.hostname !== "127.0.0.1" ||
    baseManifest.server?.loopbackOnly !== true ||
    baseManifest.dataDirectory?.windows !== "%LOCALAPPDATA%\\RisenTeamSchedule-v1.0" ||
    baseManifest.dataDirectory?.macos !== "~/Library/Application Support/RisenTeamSchedule-v1.0" ||
    baseManifest.dataDirectory?.override !== "RISEN_DB_PATH" ||
    baseManifest.dataDirectory?.packaged !== false ||
    baseManifest.runtime?.minimumNodeMajor !== 22
  ) {
    fail("Portable staging contract mismatch: expected the v1 identity, port, runtime and data paths. Run npm run build and npm run prepare:portable again.");
  }

  const forbiddenFiles = [];
  const walkForForbidden = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const lower = entry.name.toLowerCase();
      if (lower.includes("risen-team.db") || lower === ".env" || lower.startsWith(".env.")) {
        forbiddenFiles.push(path.relative(PORTABLE_DIR, full));
      }
      if (entry.isDirectory()) walkForForbidden(full);
    }
  };
  walkForForbidden(PORTABLE_DIR);
  if (forbiddenFiles.length > 0) {
    fail(`Portable staging contains forbidden user data: ${forbiddenFiles.join(", ")}`);
  }

  const releaseDir = path.join(RELEASES_ROOT, target, "RisenTeamSchedule");
  console.log(`  [${new Date().toISOString()}] release working dir: ${releaseDir}`);
  fs.rmSync(path.join(RELEASES_ROOT, target), { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  console.log(`  [${new Date().toISOString()}] copying portable staging to release dir ...`);
  console.log(`  portable dir exists: ${fs.existsSync(PORTABLE_DIR)}, listing:`);
  try {
    console.log(`    ${fs.readdirSync(PORTABLE_DIR).slice(0, 20).join(', ')}`);
  } catch {}
  fs.cpSync(PORTABLE_DIR, releaseDir, { recursive: true, dereference: true });
  console.log(`  [${new Date().toISOString()}] portable staging copy complete`);

  const scPath = path.join(releaseDir, "start.command");
  if (fs.existsSync(scPath) && process.platform !== "win32") {
    fs.chmodSync(scPath, 0o755);
  }

  const archivePath = await ensureNodeArchive(targetInfo);
  const runtimeNodeDir = path.join(releaseDir, "runtime", "node");
  extractArchive(archivePath, target, runtimeNodeDir);

  const bundledNodeExe = verifyBundledNode(target, runtimeNodeDir, lock.version);

  const gitSha = getGitSha();
  const manifestPath = path.join(releaseDir, "manifest.json");
  const releaseManifest = {
    app: appIdentity,
    gitCommit: gitSha,
    releaseTarget: target,
    os: targetInfo.os,
    cpuArch: targetInfo.arch,
    nodeVersion: lock.version,
    nodeArchive: targetInfo.filename,
    nodeArchiveSha256: targetInfo.sha256,
    nodeArchiveUrl: targetInfo.url,
    bundledNode: true,
    runtimeRelativePath: target === "win-x64" ? "runtime\\node\\node.exe" : "runtime/node/bin/node",
    runtimeDir: "runtime/node",
    serverEntry: "server.js",
    hostname: "127.0.0.1",
    port: 3178,
    loopbackOnly: true,
    userData: {
      windows: "%LOCALAPPDATA%\\RisenTeamSchedule-v1.0",
      macos: "~/Library/Application Support/RisenTeamSchedule-v1.0",
      override: "RISEN_DB_PATH",
      packaged: false,
    },
    launchers: ["start.bat", "start.command", "scripts/windows-launcher.ps1"],
    generatedAt: new Date().toISOString(),
    baseManifest: {
      totals: baseManifest.totals || null,
    },
  };

  const releaseManifestPath = path.join(releaseDir, "release-manifest.json");
  fs.writeFileSync(releaseManifestPath, JSON.stringify(releaseManifest, null, 2) + "\n", "utf8");
  console.log(`  wrote ${path.relative(ROOT, releaseManifestPath)}`);

  if (baseManifest.runtime) {
    baseManifest.runtime.bundledNode = true;
    baseManifest.runtime.bundledNodeVersion = lock.version;
    fs.writeFileSync(manifestPath, JSON.stringify(baseManifest, null, 2) + "\n", "utf8");
  }

  const readmeContent = generateReadme(target);
  fs.writeFileSync(path.join(releaseDir, "README.txt"), readmeContent, "utf8");
  console.log(`  wrote README.txt`);

  let zipName;
  if (target === "win-x64") zipName = "RisenTeamSchedule-Windows-x64.zip";
  else if (target === "darwin-arm64") zipName = "RisenTeamSchedule-macOS-AppleSilicon.zip";
  else if (target === "darwin-x64") zipName = "RisenTeamSchedule-macOS-Intel.zip";
  else zipName = `RisenTeamSchedule-${target}.zip`;

  const zipPath = path.join(DIST_ROOT, zipName);
  const zipPathInReleases = path.join(RELEASES_ROOT, target, zipName);

  createZip(releaseDir, zipPath, target);
  if (zipPath !== zipPathInReleases) {
    fs.copyFileSync(zipPath, zipPathInReleases);
  }

  const zipSha = sha256File(zipPath);
  const shaPath = `${zipPath}.sha256`;
  fs.writeFileSync(shaPath, `${zipSha}  ${zipName}\n`, "utf8");
  console.log(`  ZIP SHA-256: ${zipSha}`);
  console.log(`  wrote ${shaPath}`);

  const shaPathInReleases = `${zipPathInReleases}.sha256`;
  fs.writeFileSync(shaPathInReleases, `${zipSha}  ${zipName}\n`, "utf8");

  console.log(`  verifying ZIP extraction ...`);
  const verifyDir = path.join(RELEASES_ROOT, target, "_verify_extract");
  fs.rmSync(verifyDir, { recursive: true, force: true });
  fs.mkdirSync(verifyDir, { recursive: true });

  if (process.platform === "win32") {
    const psCmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${verifyDir}" -Force`;
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: "inherit" });
  } else {
    const res = spawnSync("unzip", ["-o", zipPath, "-d", verifyDir], { stdio: "inherit" });
    if (res.status !== 0) fail(`Failed to verify ZIP extraction for ${zipPath}`);
  }

  const extractedFolder = path.join(verifyDir, "RisenTeamSchedule");
  if (!fs.existsSync(extractedFolder)) {
    const files = fs.readdirSync(verifyDir);
    console.log(`  extracted contents: ${files.join(", ")}`);
    fail(`ZIP extraction did not produce RisenTeamSchedule folder`);
  }

  const extractedStartCommand = path.join(extractedFolder, "start.command");
  if (fs.existsSync(extractedStartCommand) && process.platform !== "win32") {
    const stat = fs.statSync(extractedStartCommand);
    const isExecutable = (stat.mode & 0o111) !== 0;
    console.log(`  start.command executable: ${isExecutable} (mode ${stat.mode.toString(8)})`);
  }

  const checkForbidden = (dir) => {
    const forb = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const rel = path.relative(dir, full);
        const lower = e.name.toLowerCase();
        if (lower.includes("risen-team.db") || lower === ".env" || lower.startsWith(".env.")) {
          forb.push(rel);
        }
        if (e.isDirectory() && !["node_modules", ".next"].includes(e.name)) {
          if (["data", "backups", "logs"].includes(lower) && path.dirname(rel) === ".") {
            forb.push(rel);
          }
        }
        if (e.isDirectory()) walk(full);
      }
    };
    walk(dir);
    return forb;
  };
  const forbiddenInRelease = checkForbidden(releaseDir);
  if (forbiddenInRelease.length > 0) {
    fail(`Release contains forbidden user data: ${forbiddenInRelease.join(", ")}`);
  }

  console.log(`\n[release:portable] SUCCESS for target ${target}`);
  console.log(`  ZIP: ${path.relative(ROOT, zipPath)}`);
  console.log(`  size: ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  SHA-256: ${zipSha}`);
  console.log(`  bundled Node: ${bundledNodeExe}`);
  console.log(`  release manifest: ${path.relative(ROOT, releaseManifestPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
