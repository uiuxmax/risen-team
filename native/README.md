# Native launcher sources

Windows uses self-contained .NET 8 / WinForms; macOS uses Swift / AppKit.
The checked-in platform icons are generated from `assets/logo-sign.svg` with
`node scripts/generate-native-icons.mjs` using the locked `sharp` dependency.
The native launcher test checks that the generated files match those inputs.
Both select and remember an external project directory, validate `project.json`,
reserve one launcher per user, bind the child server to `127.0.0.1:3178`, and open
`/halls` only after matching application, protocol and workspace UUID readiness.
The tray/menu-bar Quit command sends `shutdown` over owned stdin; Next's SIGTERM
handler drains HTTP requests. A timeout keeps the launcher alive instead of
forcing a database-owning child to terminate.

`RISEN_WORKSPACE_PATH` is the absolute chosen project. Inherited `RISEN_DB_PATH`
is removed so a native launch cannot silently open a different database.
Application files and runtime are immutable; user data remains outside them.

No final executable or app is compiled until tests, audit and code review pass.
Generate the exact source digest with:

```text
node scripts/build-native-release.mjs --source-digest
```

Record a JSON report containing `sourceDigest`, `tests: "passed"`,
`audit: "passed"`, `codeReview: "passed"` after verification. Then run on each
matching OS/architecture:

```text
node scripts/build-native-release.mjs --target=win-x64 --verification=docs/audit/native-verification.json
node scripts/build-native-release.mjs --target=darwin-arm64 --verification=docs/audit/native-verification.json
node scripts/build-native-release.mjs --target=darwin-x64 --verification=docs/audit/native-verification.json
```

Build prerequisites are Node with dependencies, .NET 8 SDK on Windows, Xcode
command line tools on macOS. Client machines need no Node or .NET installation.
The legacy portable builder remains available for its existing smoke checks;
the native builder wraps it and places its server/runtime inside `application/`
or `Risen Team.app/Contents/Resources/application/`.

These are unsigned test builds (macOS ad hoc signed). Windows distribution
signing and Apple Developer ID signing/notarization require release credentials.
macOS 12 and Windows supporting .NET 8 are declared build targets, not a claim
of clean-machine testing. Run the plan's manual launcher scenarios on all three
targets before marking any platform ready. In particular first launch, repeat
launch, occupied port, another project, unavailable/read-only folder, offline
launch, update and graceful exit remain required acceptance checks.

Windows automation can invoke `Risen Team.exe --smoke-test=<absolute temporary
project directory>`. The directory must contain a valid project manifest. This
mode avoids remembered settings, folder/browser dialogs and tray display,
verifies readiness and immediately requests graceful shutdown. Exit code zero
and `launcher-smoke.log` confirm success. It never uses a real project by default.

The first-project chooser also offers **Імпортувати стару базу**. Select the old
SQLite file and a new empty project folder. The bundled readonly helper copies
committed data through the SQLite backup API; the original is preserved. The
constructor then shows the explicit hall migration preview/confirmation. Newer
projects with file assets use the project archive flow instead of copying only
their database file.
