# Risen Team Schedule Builder v1.0

The current pre-release changes and verification results are recorded in
[the pre-release report](docs/audit/pre-release-review.uk.md).
The supplied full logo is the default schedule/export artwork; the sign is used
in the header, browser icon and native launcher icons. Custom hall logos still
override the default, and the logo can be hidden in Settings.

```text
npm run prepare:branding  # regenerate derived browser/native artwork
npm test                 # unit, component and isolated SQLite regression tests
npm run typecheck
npm run lint
npm run build
npm run prepare:portable
npm run smoke:project    # production HTTP/data/shutdown checks in a temporary project
npm run smoke:browser    # actual Chrome/Edge interactions and PNG/PDF/SVG downloads
```

Browser checks use an installed Chrome/Edge and a temporary project, never the
operator's database. Set `RISEN_TEST_BROWSER` to the browser executable when it
is not found in a standard location. `--server=<standalone server.js>` can target
the exact server inside a prepared native package.

The independent-halls implementation is documented in [the Ukrainian client guide](docs/CLIENT-GUIDE.uk.md), [data contracts](docs/hall-data-contracts.md), and [the current review](docs/audit/halls-development-review.md). Native launcher source and the reviewed build command are in [native/README.md](native/README.md). Platform verification is recorded separately; the historical release instructions below describe the earlier shell launchers.


Independent v1.0 release, copied from v0.1 without modifying the original.

- Start on Windows: double-click `start.bat`. The complete production bundle is already prepared in `dist/portable/RisenTeamSchedule/`.
- Open **http://127.0.0.1:3178**. Version v0.1 can keep using port 3177.
- The root launcher uses this copy's existing `data/risen-team.db`, including the copied schedule. A separately extracted portable package uses `RisenTeamSchedule-v1.0` in the OS user-data directory.
- Dependencies and generated builds are independent copies; no links to v0.1 are required.
- An alternate snapshot of the old desktop launcher database is preserved separately in `data/legacy-v0.1-launcher/`; it is not used automatically.
- See [audit report](docs/audit/v1.0-audit.md) for fixes, checks and remaining limits.

Local-first web application for building, versioning, previewing and exporting the
weekly Risen Team training schedule. One operator, one computer, no accounts and no
internet connection required.

---

## 1. Requirements

- **Node.js 22.12+** (the SQLite driver requires Node 22; tests require Node 22.12 or newer)
- npm
- A modern browser: Chrome, Edge or Safari (Windows or macOS)

No PostgreSQL, no Supabase, no cloud services, no environment secrets. Data lives in a
local SQLite file inside the project.

---

## 2. Install

```bash
npm install
```

The SQLite driver (`better-sqlite3`) ships prebuilt binaries; on a brand-new machine
Node may compile it once — that is normal and needs no extra configuration.

## 3. Run

Development (hot reload):

```bash
npm run dev
# http://127.0.0.1:3178  →  opens directly on the Schedule editor
```

Local production build (recommended for daily use):

```bash
npm run build
npm run start
# http://127.0.0.1:3178
```

There is **no login screen** — the application opens straight into the schedule editor.

### Desktop launchers (Windows / macOS)

For daily use the repository ships two one-click launchers:

| Platform | File | Backed by |
| --- | --- | --- |
| Windows | `start.bat` | `scripts/windows-launcher.ps1` |
| macOS | `start.command` | the script itself (bash) |

Both start the prepared production server and open the browser:

```bash
npm ci
npm run build
# then double-click start.bat (Windows) or run ./start.command (macOS)
```

A launcher **never** runs `npm install` and **never** builds. It only starts an
already-built standalone server; if no build exists it says so and stops rather than
starting a multi-minute build from a double-click.

What the launchers guarantee:

- **Loopback only.** The server is bound to `127.0.0.1` on the **fixed port `3178`**
  (`http://127.0.0.1:3178`). Nothing is reachable from the local network.
- **Browser opens only after health.** `/api/health` must answer first, so you never land
  on a connection-refused tab.
- **Repeat launches reuse the running app.** A second launch detects the existing instance
  through `/api/health` and simply opens the browser — it does not start a second server.
- **Foreign processes are never touched.** If some *unrelated* program already occupies
  port 3178, the launcher reports it and exits non-zero. It never kills, stops or replaces
  another application. The check uses the stable application identity
  `risen-team-schedule-builder` returned by `/api/health`.
- **Data lives outside the application folder** (see below), so deleting or replacing the
  app folder never deletes your schedule.

### Data location used by portable launchers

| Platform | SQLite database | Launcher logs |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\RisenTeamSchedule-v1.0\risen-team.db` | `%LOCALAPPDATA%\RisenTeamSchedule-v1.0\logs\` |
| macOS | `~/Library/Application Support/RisenTeamSchedule-v1.0/risen-team.db` | `…/RisenTeamSchedule-v1.0/logs/` |

`data/backups/` safety copies are written beside the database, exactly as before. An
explicit `RISEN_DB_PATH` always overrides these defaults, and `npm run dev` / `npm run start`
still default to `./data/risen-team.db`. The root desktop launcher uses that same file when it already exists in this source checkout.

### Portable staging

```bash
npm run build
npm run prepare:portable
# → dist/portable/RisenTeamSchedule/
```

`prepare:portable` copies the Next.js `output: "standalone"` server together with
`.next/static` and `public` (Next does not copy those itself) into a single launchable
folder, adds the launchers and writes a `manifest.json`. It is **deterministic**: the same
inputs produce the same tree and the same manifest, with no timestamps or absolute paths.
It refuses to package any user data — no database, no WAL sidecars, no `backups/`, no
launcher logs, no local `.env` — and it fails if any of those would be staged. `dist/` is
ignored by both Git and ESLint.

The launchers already look for a bundled Node runtime first
(`runtime\node\node.exe` / `runtime/node/bin/node`) and fall back to a system Node ≥ 22.
The prepared bundle uses a system Node 22+. The release script can add a pinned runtime for distributable archives.

## 4. Quality commands

```bash
npm run typecheck   # TypeScript, strict
npm test      # unit + integration tests (SQLite, migrations, versions, import, PDF font, layout)
npm run build       # production build
```

---

## 5. Where the data is stored

```
project-root/
  data/
    risen-team.db          ← the whole workspace (SQLite)
    backups/               ← automatic safety backups (rotating, latest 10)
  src/
  public/
    fonts/                 ← embedded PDF font (Cyrillic support)
```

- The `data/` folder and the database file are created automatically on first start —
  together with the schema and (on a truly new database) Risen Team demo data.
- Demo data is seeded **once per database file**. If you delete everything on purpose,
  it will not come back.
- To store the database elsewhere, copy `.env.example` to `.env` and set
  `RISEN_DB_PATH=/absolute/or/relative/path/risen-team.db`.
- That layout is for `npm run dev` / `npm run start`. The desktop launchers keep the
  database and their logs in the OS user-data folder instead, so replacing the app never
  touches your schedule — see *Desktop launchers* in section 3. Setting `RISEN_DB_PATH`
  overrides both.

### What is persisted

Schedules, schedule events, trainers, class types, trainer↔class relationships, rooms,
per-schedule settings (visible days, time window, custom markers, branding, export
defaults), version history and application metadata.

`localStorage` is only used as a temporary recovery buffer for edits that have not been
saved yet (for example if the browser is refreshed mid-edit). SQLite is always the
authoritative store.

### SQLite schema migrations and integrity

The database schema has an explicit **latest version of `1`**, stored in SQLite's
transactional `PRAGMA user_version`. A metadata table is intentionally not used: one
local SQLite file needs one durable integer marker, and `user_version` can be updated
in the same transaction as the schema/data rebuild.

Startup opens the configured database intentionally (never on module import), enables
`PRAGMA foreign_keys = ON` on that connection, then follows this order:

1. reject a database whose `user_version` is newer than this app supports;
2. recognize either a blank file or the exact former unversioned Risen Team v0 schema;
3. for v0, validate all relationship and active-schedule invariants **before** changing
   any table;
4. write a required atomic pre-image backup for v0;
5. rebuild/copy/verify the constrained tables in one `BEGIN IMMEDIATE` transaction,
   run `PRAGMA foreign_key_check`, and set `user_version = 1` as the final statement;
6. roll back completely if any step after the backup fails. The safety copy is retained.

A v0 pre-migration copy is named like
`risen-team-pre-migration-v0-to-v1-YYYY-MM-DD-HHMMSS-SSS-<id>.json`. It uses the same
flushed temporary-file → atomic-rename writer as ordinary safety backups, but it has a
separate namespace and is **not** rotated with the usual latest-10 automatic backups.
If that backup cannot be created, migration does not begin. If legacy data has an
orphan, duplicate constrained key, invalid restore reference, multiple active
schedules, or another unsafe relationship, migration is refused without deleting,
repairing, reseeding or guessing at data.

Schema v1 enforces these real SQLite foreign keys (all updates are `NO ACTION`):

| Child relation | Parent | Delete policy | Why |
| --- | --- | --- | --- |
| `trainer_class_types.trainer_id` | `trainers.id` | `RESTRICT` | Administrative deletion removes links deliberately; a raw parent delete must not erase eligibility silently. |
| `trainer_class_types.class_type_id` | `class_types.id` | `RESTRICT` | Same deliberate link cleanup policy. |
| `schedule_events.schedule_id` | `schedules.id` | `RESTRICT` | Schedule deletion explicitly removes settings, events and versions in its atomic operation. |
| `schedule_events.trainer_id` | `trainers.id` | `RESTRICT` | Referenced trainers are deactivated, preserving saved schedules. |
| `schedule_events.class_type_id` | `class_types.id` | `RESTRICT` | Referenced class types are deactivated, preserving saved schedules. |
| `schedule_events.room_id` | `rooms.id` | `RESTRICT` | A referenced room is deactivated rather than stripping it from historical/current events. |
| `schedule_settings.schedule_id` | `schedules.id` | `RESTRICT` | One settings row belongs to a real schedule. |
| `schedule_versions.schedule_id` | `schedules.id` | `RESTRICT` | Version history is removed only by the supported schedule-delete transaction. |
| `schedule_versions.restored_from_version_id` | `schedule_versions.id` | `SET NULL` | This optional historical pointer can outlive a removed source version without leaving a dangling reference. |

Existing primary keys remain identity constraints. v1 also has the existing one-settings-row
and trainer/class-pair guarantees through their primary keys, child lookup indexes for
FK operations, and a partial unique index allowing at most one `is_active = 1` schedule.
Table checks forbid an archived schedule from being active and a version from restoring
itself. SQLite cannot safely express
"exactly one non-archived active schedule" without triggers that would conflict with the
existing multi-statement product flows, so that final rule remains in the established
application validation/atomic administrative layer.

#### Adding the next migration safely

1. Add a new immutable forward migration in `src/db/migrations.ts`, increment
   `LATEST_SCHEMA_VERSION`, and keep the old v0→v1 migration unchanged.
2. Extend the preflight validation in `src/db/migration-validation.ts` for every new
   constraint before any table rebuild.
3. Preserve the order: preflight → required backup → one transaction → schema/FK check
   → final `user_version` update.
4. Add fresh, real-previous-version, corruption, failure-injection and direct-FK tests
   using a unique temporary `RISEN_DB_PATH`. Never point migration tests at
   `data/risen-team.db`.
5. Run `npm run typecheck`, `npx vitest run`, `npm run build`, and `npm run lint`.

Released migrations are append-only historical code: **never edit an old released
migration** to change its effect on an existing user database.

---

## 6. Autosave

- Every change is debounced (~1.1 s) and then written to SQLite.
- The toolbar shows `Збереження…`, then `✓ Збережено 18:37`.
- Turning autosave **off** in Settings takes effect immediately for the current session
  (a local recovery copy is still kept, and `Зберегти зараз` saves explicitly).
- If saving fails you get a clear message, and the unsaved edits stay recoverable in the
  same browser.

## 7. Version history

- Automatic snapshots while editing, named checkpoints, publish checkpoints.
- **Restore is non-destructive**: restoring an older version writes a *new* version
  (`Відновлено з версії від …`) and keeps everything that came after it.
- A version belongs to **one schedule**. Restoring touches only that schedule's events,
  time window, visible days, custom markers and display settings. Trainers and class
  types are workspace-level entities and are never renamed or deleted by a restore.
  Snapshots keep a frozen copy of trainer/class data so old versions still display
  correct names and colours.

## 8. Draft / Published

`Опубліковано` simply means "this is the approved state used for the final
export/display". Publishing validates the schedule, stores a safety backup and creates a
version checkpoint. Nothing is uploaded anywhere.

## 9. Backup, import and safety copies

- **Export JSON backup** → `risen-team-schedule-backup-<date>.json` (schedules, events,
  trainers, class types, rooms, settings, full version history).
- **Import backup** is transaction-safe:
  1. the file shape and `schemaVersion` are validated,
  2. relationships are validated (every event must reference an existing trainer, class
     type, room and schedule),
  3. a rotating safety backup of the current data is written to `data/backups/`,
  4. the import runs inside a single SQLite transaction,
  5. integrity is verified again before `COMMIT`.
  Any failure **rolls back** and the existing data is untouched — the UI then reports
  «Не вдалося імпортувати резервну копію. Поточні дані не змінено.»
- **Destructive-operation policy** (which operations a safety backup protects):
  - *backup-gated* — the safety copy is part of the protection, so if it cannot be written
    the operation is **cancelled before anything is touched** and the UI reports
    «Не вдалося створити резервну копію. Операцію скасовано — дані не змінено.»:
    importing a backup (merge **and** replace), restoring a version, deleting a schedule;
  - *convenience only* — publishing writes a safety backup, but publishing is not
    destructive (the same flow records a version checkpoint), so a failed backup never
    blocks it;
  - every other action (renames, trainer/class/room edits, reordering) is not destructive
    and writes no backup at all.
- Automatic safety backups use collision-safe names
  (`risen-team-auto-YYYY-MM-DD-HHMMSS-SSS-<short-id>.json`: no colon, millisecond plus
  random suffix, still sorting chronologically) and are written atomically (fully
  serialized → temporary file → flush → rename), so a failed backup can never leave a
  truncated `.json` behind or overwrite an earlier copy. Automatic backups rotate
  (latest 10); backups you exported yourself are never touched, and neither listing nor
  rotation counts temporary or incomplete files.
- Invalid or corrupted files cannot damage the workspace.

## 10. Preview, PNG and PDF export

`Розклад → Перегляд` and `Експорт і друк` render the same SVG schedule model:

- Preview/PNG/PDF contain **no** application chrome — no navigation, filters, hover
  controls or drag handles.
- PNG: 1x / 2x / 3x / 4x rasterised from the vector artwork (4x = 6720 × 3520 for the
  1680 × 880 sheet), so text and borders stay sharp.
- PDF: A4/A3/custom, landscape or portrait, generated with vector primitives.
  **DejaVu Sans is embedded in the PDF**, so Ukrainian text (Розклад тренувань, Бокс
  підлітковий 12+, Коstantyn, Анастасія…) renders identically on Windows, macOS and on
  computers where the font is not installed. See `public/fonts/LICENSE.txt`.
- SVG export is available as a fully scalable master file.

## 11. Interface language

- **Ukrainian is the default language** on first launch (`DEFAULT_LOCALE = uk`).
- English remains available as a secondary language: Settings → `Мова інтерфейсу`, or
  the EN / УКР switch in the header.
- The chosen language is remembered per browser.

---

## 12. Moving the data to another computer

Option A — copy the project:

1. Copy the whole project folder **including `data/`** (`data/risen-team.db` and
   `data/backups/`).
2. On the new computer run `npm install`, then `npm run build && npm run start`.

Option B — export / import:

1. On the old computer: `Налаштування → Експортувати резервну копію (JSON)`.
2. Copy that JSON file to the new computer (mail, USB drive, cloud drive — your choice).
3. Install the app there (`npm install`), open it and use
   `Налаштування → Імпортувати копію…`.
4. The import validates the file and creates a safety copy of whatever was in the new
   installation before applying anything.

Windows → macOS and macOS → Windows both work; paths are handled cross-platform and the
database file is portable.

### Windows notes

- Use **Command Prompt / PowerShell / Git Bash**; all commands above work unchanged.
- With `npm run dev` / `npm run start` the data path is `%CD%\data\risen-team.db`
  (relative to the project folder, so moving the folder moves the data).
- With an extracted portable `start.bat` launcher the data path is
  `%LOCALAPPDATA%\RisenTeamSchedule-v1.0\risen-team.db`, and the app runs on
  `http://127.0.0.1:3178`.
- If the app should start automatically, create a shortcut to `start.bat` (launcher) or to
  `npm run start` (CLI).

### macOS notes

- Apple Silicon and Intel are both supported.
- With `npm run dev` / `npm run start` the data path is `<project>/data/risen-team.db`.
- With an extracted portable `start.command` launcher the data path is
  `~/Library/Application Support/RisenTeamSchedule-v1.0/risen-team.db`, and the app runs on
  `http://127.0.0.1:3178`.
- Either way nothing leaves the machine, and nothing is uploaded anywhere. The launcher
  is the only mode that writes outside the project folder — into your own user-support
  folder — and an explicit `RISEN_DB_PATH` overrides it.

---

## 13. Architecture (short version)

```
DATA (SQLite, semantic events: day + start + end time)
        ↓
SCHEDULE LAYOUT ENGINE (pure, testable: time axis, day columns, lanes, brand panel)
        ↓
RISEN TEAM THEME (colours, sizes, typography — data/layout/theme separated)
        ↓
SVG RENDERER  →  preview  →  PNG  →  PDF  →  SVG
```

Key modules:

| Area | Path |
| --- | --- |
| Domain types & validation schemas | `src/lib/domain/types.ts` |
| Time system (5-minute precision, markers) | `src/lib/schedule/time.ts` |
| Overlap / lane engine | `src/lib/schedule/overlap.ts` |
| Layout engine | `src/lib/schedule/layout.ts` |
| Drag/resize boundary maths | `src/lib/schedule/placement.ts` |
| Editor state, undo/redo, change log | `src/lib/schedule/editor.ts` |
| Conflict & eligibility validation | `src/lib/schedule/validation.ts` |
| Theme | `src/lib/theme/risen-team-dark.ts` |
| SVG renderer (preview/PNG/PDF) | `src/components/schedule/ScheduleSvg.tsx` |
| SQLite connection + schema bootstrap | `src/db/index.ts`, `src/db/schema.ts` |
| Services (workspace, admin, backups) | `src/lib/server/*` |
| i18n (uk default, en optional) | `src/lib/i18n/*` |

## 14. Testing

```bash
npx vitest run
```

Covers: time conversions and custom markers, overlap lanes and reflow, layout geometry,
drag/resize boundaries, autosave decisions, conflict and trainer-eligibility validation,
Ukrainian dictionary completeness, trainer legend ordering, brand-panel composition,
SQLite persistence across restarts, version-restore scope, atomic import + rollback,
administrative-mutation atomicity (schedule deletion, class-type/trainer links, batch
reorder) with injected-failure rollback proofs, safety-backup filenames/atomic writes/
rotation and the backup-gated destructive-operation policy, backup filename and PNG/PDF
dimension maths, and Cyrillic PDF font embedding.
