/* Explicit desktop migration: copy a legacy DB with SQLite's backup API.
 * The source is always readonly and is never migrated, renamed or deleted. */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");

async function main() {
  const [source, root] = process.argv.slice(2);
  if (!source || !root || !path.isAbsolute(source) || !path.isAbsolute(root)) throw new Error("Choose absolute source and project paths.");
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Choose an ordinary project directory.");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8"));
  if (manifest.format !== "risen-team-project" || manifest.formatVersion !== 1 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(manifest.workspaceId)) throw new Error("Invalid target project manifest.");
  const allowedDirectories = new Set(["data", "assets", "backups", "exports", "logs"]);
  const emptyDirectoryTree = directory => fs.readdirSync(directory, { withFileTypes: true }).every(entry =>
    entry.isDirectory() && !entry.isSymbolicLink() && emptyDirectoryTree(path.join(directory, entry.name)));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "project.json" && entry.isFile()) continue;
    const full = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !allowedDirectories.has(entry.name) || !emptyDirectoryTree(full)) throw new Error("Legacy import requires a new empty project.");
  }
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error("Choose the original database file, not a symlink.");
  const database = new Database(source, { readonly: true, fileMustExist: true });
  let temporary;
  let publicationLock;
  let publicationLockPath;
  try {
    database.pragma("trusted_schema = OFF");
    const version = database.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1) throw new Error("Use project archive import for a newer project database.");
    if (database.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Legacy database integrity check failed.");
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!["schedules", "trainers", "class_types", "schedule_events", "schedule_settings", "schedule_versions"].every(table => tables.has(table))) throw new Error("This is not a supported Risen Team database.");
    const directory = path.join(root, "data"); fs.mkdirSync(directory, { recursive: true });
    temporary = path.join(directory, `.legacy-import-${randomUUID()}.db`);
    await database.backup(temporary);
    const descriptor = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    // A create-exclusive lock plus same-directory rename works on FAT/exFAT
    // too. Hard links are not available on common portable project volumes.
    publicationLockPath = path.join(directory, ".legacy-import.lock");
    publicationLock = fs.openSync(publicationLockPath, "wx");
    const destination = path.join(directory, "risen-team.db");
    if (fs.existsSync(destination)) throw new Error("Target project already contains a database.");
    fs.renameSync(temporary, destination);
    console.log("Legacy database copied. The original is unchanged; confirm hall migration in the constructor.");
  } finally {
    database.close();
    if (temporary) fs.rmSync(temporary, { force: true });
    if (publicationLock !== undefined) {
      fs.closeSync(publicationLock);
      fs.rmSync(publicationLockPath, { force: true });
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
