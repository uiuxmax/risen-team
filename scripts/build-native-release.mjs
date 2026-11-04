#!/usr/bin/env node
/** Native final artifacts are gated by a review report for the exact source tree.
 * First: node scripts/build-native-release.mjs --source-digest
 * Then record that digest and passing tests/audit/codeReview in the report.
 * Usage: node scripts/build-native-release.mjs --target=win-x64 --verification=docs/audit/native-verification.json
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name) { return args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3); }
function fail(message) { throw new Error(message); }
function run(command, parameters, options = {}) {
  const result = spawnSync(command, parameters, { cwd: root, stdio: "inherit", ...options });
  if (result.error || result.status !== 0) fail(`${command} failed: ${result.error?.message ?? result.status}`);
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && path.relative(root, directory).split(path.sep)[0] === "native" && ["bin", "obj"].includes(entry.name)) return [];
    if (entry.isSymbolicLink()) fail(`Source symlink is not supported: ${target}`);
    return entry.isDirectory() ? files(target) : [target];
  });
}
function sourceDigest() {
  const hash = createHash("sha256");
  const sources = ["src", "scripts", "native", ".github", "public", "assets"].flatMap((directory) => files(path.join(root, directory)));
  sources.push(...[".gitattributes", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "eslint.config.mjs", "vitest.config.mts"].map((file) => path.join(root, file)));
  for (const file of sources.sort()) {
    hash.update(path.relative(root, file).split(path.sep).join("/")); hash.update("\0"); hash.update(fs.readFileSync(file)); hash.update("\0");
  }
  return hash.digest("hex");
}

try {
  const digest = sourceDigest();
  if (args.includes("--source-digest")) { console.log(digest); process.exit(0); }
  const target = option("target") ?? process.env.RELEASE_TARGET;
  if (!["win-x64", "darwin-arm64", "darwin-x64"].includes(target)) fail("Supply --target=win-x64|darwin-arm64|darwin-x64.");
  const [platform, architecture] = target.split("-");
  if (process.platform !== (platform === "win" ? "win32" : "darwin") || process.arch !== architecture) fail("Build on the matching OS and architecture; native SQLite must not be copied between targets.");
  const reportPath = option("verification") ?? process.env.VERIFICATION_REPORT;
  if (!reportPath) fail("Before creating an exe/app, supply --verification=<JSON report> with sourceDigest and tests/audit/codeReview all 'passed'.");
  const report = JSON.parse(fs.readFileSync(path.resolve(root, reportPath), "utf8"));
  if (report.sourceDigest !== digest || ["tests", "audit", "codeReview"].some((check) => report[check] !== "passed")) fail("Tests, audit and code review must pass for the exact current source digest before native compilation.");
  // Build and staging run here, after review, so an old .next tree can never ship.
  run(process.execPath, ["node_modules/next/dist/bin/next", "build"]);
  run(process.execPath, ["scripts/prepare-portable.mjs"]);
  run(process.execPath, ["scripts/build-portable-release.mjs", `--target=${target}`]);
  const portable = path.join(root, "dist", "releases", target, "RisenTeamSchedule");
  const output = path.join(root, "dist", "native-release", target, "RisenTeamSchedule");
  // Literal, verified workspace-scoped target; never delete an unchecked computed path.
  const allowed = path.join(root, "dist", "native-release") + path.sep;
  if (!output.startsWith(allowed)) fail("Output escaped release directory.");
  fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
  const appBundle = path.join(output, "Risen Team.app");
  const application = platform === "win" ? path.join(output, "application") : path.join(appBundle, "Contents", "Resources", "application");
  fs.cpSync(portable, application, { recursive: true, dereference: true, filter: (source) => !["start.bat", "start.command", "README.txt", "scripts", "manifest.json", "release-manifest.json"].includes(path.relative(portable, source).split(path.sep)[0]) });
  for (const file of files(application)) {
    const relative = path.relative(application, file).split(path.sep).join("/");
    if (/(^|\/)(?:\.env(?:\..*)?|project\.json)$|\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(relative) ||
        /^(?:workspace|data|backups|logs)\//i.test(relative)) fail(`User data or configuration cannot be distributed: ${relative}`);
  }
  fs.copyFileSync(path.join(root, "native", "desktop-shutdown.cjs"), path.join(application, "desktop-shutdown.cjs"));
  fs.copyFileSync(path.join(root, "native", "import-legacy-project.cjs"), path.join(application, "import-legacy-project.cjs"));
  if (platform === "win") {
    const buildOutput = path.join(root, "dist", "native-build", target);
    run("dotnet", ["publish", "native/windows/RisenTeam.csproj", "-c", "Release", "-r", "win-x64", "--self-contained", "true", "--artifacts-path", buildOutput, "-o", output]);
  } else {
    const executable = path.join(appBundle, "Contents", "MacOS", "RisenTeam");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(path.join(root, "native/assets/app.icns"), path.join(appBundle, "Contents", "Resources", "app.icns"));
    fs.copyFileSync(path.join(root, "native/assets/menubar.png"), path.join(appBundle, "Contents", "Resources", "menubar.png"));
    run("xcrun", ["swiftc", "-O", "-target", `${architecture === "arm64" ? "arm64" : "x86_64"}-apple-macosx12.0`, "native/macos/main.swift", "-o", executable]);
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(appBundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>RisenTeam</string><key>CFBundleIdentifier</key><string>team.risen.schedule</string><key>CFBundleName</key><string>Risen Team</string><key>CFBundleIconFile</key><string>app.icns</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>LSUIElement</key><true/></dict></plist>\n`);
    // Ad hoc signing permits local testing. Distribution signing/notarization must
    // replace this step using the release owner's Apple Developer identity.
    run("codesign", ["--force", "--deep", "--sign", "-", appBundle]);
  }
  fs.writeFileSync(path.join(output, "Інструкція.html"), `<!doctype html><html lang="uk"><meta charset="utf-8"><title>Risen Team</title><h1>Risen Team</h1><p>Розпакуйте весь архів. Запустіть ${platform === "win" ? "Risen Team.exe" : "Risen Team.app"}. Створіть проєкт у порожній папці або виберіть наявний проєкт.</p><p>Програма працює без інтернету. Команди доступні біля годинника: відкрити конструктор, папку проєкту, завершити.</p><p>Перед оновленням завершіть програму. Замініть файли програми, зберігши папку свого проєкту. Для передачі залу використовуйте експорт у конструкторі.</p><p>Ця тестова збірка не має сертифіката розповсюдження.</p></html>`);
  const manifest = { app: "risen-team-schedule-builder-v1", protocolVersion: 1, target, sourceDigest: digest, workspacePackaged: false, signedForDistribution: false, verification: report };
  fs.writeFileSync(path.join(output, "native-release-manifest.json"), JSON.stringify(manifest, null, 2));
  const zip = path.join(root, "dist", `RisenTeam-native-${target}.zip`);
  if (platform === "win") {
    const escape = (value) => `'${value.replaceAll("'", "''")}'`;
    run("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -LiteralPath ${escape(output)} -DestinationPath ${escape(zip)} -Force`]);
  } else run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", output, zip]);
  fs.writeFileSync(zip + ".sha256", createHash("sha256").update(fs.readFileSync(zip)).digest("hex") + "\n");
  console.log(`Native release staged: ${output}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
