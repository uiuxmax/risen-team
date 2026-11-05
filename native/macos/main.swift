import AppKit
import Foundation
import Darwin

@MainActor
final class Launcher: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var child: Process?
    private var input: Pipe?
    private var lockFile: Int32 = -1
    private var workspace: URL?
    private var stopping = false
    private var ready = false
    private var monitor: Timer?
    private var legacySource: URL?
    private var importing: Process?
    private let base = URL(string: "http://127.0.0.1:3178")!
    private let identity = "risen-team-schedule-builder-v1"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let url = Bundle.main.url(forResource: "menubar", withExtension: "png"), let image = NSImage(contentsOf: url) {
            image.size = NSSize(width: 16, height: 16)
            image.isTemplate = false
            item.button?.image = image
        } else { item.button?.title = "Risen Team" }
        let menu = NSMenu()
        menu.addItem(withTitle: "Відкрити конструктор", action: #selector(openEditor), keyEquivalent: "")
        menu.addItem(withTitle: "Відкрити папку проєкту", action: #selector(openProject), keyEquivalent: "")
        menu.addItem(withTitle: "Завершити", action: #selector(quit), keyEquivalent: "q")
        for menuItem in menu.items { menuItem.target = self }
        item.menu = menu
        Task { await start() }
    }

    private func error(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = "Risen Team"; alert.informativeText = message; alert.runModal()
    }

    private func selectProject() throws -> URL? {
        let fm = FileManager.default
        if let last = UserDefaults.standard.string(forKey: "risenTeamProject") {
            let url = URL(fileURLWithPath: last, isDirectory: true)
            if fm.fileExists(atPath: url.appendingPathComponent("project.json").path) { return url }
            error("Останній проєкт недоступний. Виберіть його папку; дані не буде замінено.")
        }
        NSApp.activate(ignoringOtherApps: true)
        let choice = NSAlert(); choice.messageText = "Відкрити Risen Team"
        choice.addButton(withTitle: "Створити проєкт"); choice.addButton(withTitle: "Відкрити наявний")
        choice.addButton(withTitle: "Імпортувати стару базу"); choice.addButton(withTitle: "Скасувати")
        let result = choice.runModal()
        if result.rawValue == 1003 { return nil }
        let importLegacy = result == .alertThirdButtonReturn
        let create = result == .alertFirstButtonReturn || importLegacy
        if importLegacy {
            let source = NSOpenPanel(); source.canChooseDirectories = false; source.canChooseFiles = true; source.allowsMultipleSelection = false
            source.message = "Виберіть стару базу Risen Team. Оригінал залишиться без змін"
            source.allowedFileTypes = ["db", "sqlite", "sqlite3"]
            let candidates = [Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("data/risen-team.db"), fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/RisenTeamSchedule-v1.0/risen-team.db")]
            if let candidate = candidates.first(where: { fm.fileExists(atPath: $0.path) }) { source.directoryURL = candidate.deletingLastPathComponent(); source.nameFieldStringValue = candidate.lastPathComponent }
            if source.runModal() != .OK { return nil }
            legacySource = source.url
        }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.canCreateDirectories = create; panel.allowsMultipleSelection = false
        panel.message = create ? "Виберіть порожню папку нового проєкту" : "Виберіть папку з project.json"
        if panel.runModal() != .OK { return nil }
        guard let url = panel.url else { return nil }
        if create {
            guard try fm.contentsOfDirectory(atPath: url.path).isEmpty else { throw failure("Новий проєкт потребує порожньої папки.") }
            let manifest: [String: Any] = ["format": "risen-team-project", "formatVersion": 1, "workspaceId": UUID().uuidString.lowercased(), "createdAt": ISO8601DateFormatter().string(from: Date())]
            let data = try JSONSerialization.data(withJSONObject: manifest, options: .prettyPrinted)
            try data.write(to: url.appendingPathComponent("project.json"), options: .withoutOverwriting)
        }
        return url
    }

    private func failure(_ text: String) -> NSError { NSError(domain: "RisenTeam", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }

    private func projectIdentity(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url.appendingPathComponent("project.json"))
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["format"] as? String == "risen-team-project", json["formatVersion"] as? Int == 1,
              let id = json["workspaceId"] as? String, UUID(uuidString: id) != nil else { throw failure("Непідтримуваний project.json.") }
        return id.lowercased()
    }

    private func health() async -> [String: Any]? {
        var request = URLRequest(url: base.appendingPathComponent("api/health")); request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func matches(_ health: [String: Any]?, _ id: String) -> Bool {
        health?["ok"] as? Bool == true && health?["app"] as? String == identity &&
        health?["protocolVersion"] as? Int == 1 && (health?["workspaceId"] as? String)?.lowercased() == id
    }

    private func start() async {
        do {
            guard let root = try selectProject() else { NSApp.terminate(nil); return }
            workspace = root
            let id = try projectIdentity(root)
            let probe = root.appendingPathComponent(".write-test-" + UUID().uuidString)
            try Data([0]).write(to: probe, options: .withoutOverwriting); try FileManager.default.removeItem(at: probe)
            let settings = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("RisenTeamLauncher", isDirectory: true)
            try FileManager.default.createDirectory(at: settings, withIntermediateDirectories: true)
            lockFile = Darwin.open(settings.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
            guard lockFile >= 0 else { throw failure("Не вдалося зарезервувати запуск програми.") }
            if flock(lockFile, LOCK_EX | LOCK_NB) != 0 {
                for _ in 0..<40 {
                    if matches(await health(), id) { ready = true; openEditor(); NSApp.terminate(nil); return }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                throw failure("Risen Team уже запускається або відкрито інший проєкт. Завершіть його через меню програми.")
            }
            // Reserve the port long enough to detect any unrelated listener. It is
            // released immediately before child start; identity is rechecked later.
            let socketFD = socket(AF_INET, SOCK_STREAM, 0)
            guard socketFD >= 0 else { throw failure("Не вдалося перевірити локальний порт.") }
            var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET); address.sin_port = UInt16(3178).bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            Darwin.close(socketFD)
            guard bound == 0 else { throw failure("Порт 3178 зайнятий. Завершіть іншу копію програми або звільніть порт.") }
            guard let resources = Bundle.main.resourceURL else { throw failure("Пакет програми пошкоджено.") }
            let application = resources.appendingPathComponent("application", isDirectory: true)
            if let legacySource {
                let copier = Process(); copier.executableURL = application.appendingPathComponent("runtime/node/bin/node"); copier.currentDirectoryURL = application
                copier.arguments = [application.appendingPathComponent("import-legacy-project.cjs").path, legacySource.path, root.path]
                let errors = Pipe(); copier.standardOutput = FileHandle.nullDevice; copier.standardError = errors
                try copier.run(); importing = copier
                while copier.isRunning { try await Task.sleep(nanoseconds: 100_000_000) }
                importing = nil
                guard copier.terminationStatus == 0 else {
                    let diagnostic = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                    throw failure("Не вдалося перенести стару базу. Оригінал не змінено. " + diagnostic)
                }
                if stopping { return }
            }
            let process = Process(); process.executableURL = application.appendingPathComponent("runtime/node/bin/node")
            process.currentDirectoryURL = application
            process.arguments = ["--require", application.appendingPathComponent("desktop-shutdown.cjs").path, application.appendingPathComponent("server.js").path]
            var environment = ProcessInfo.processInfo.environment; environment.removeValue(forKey: "RISEN_DB_PATH")
            environment["RISEN_WORKSPACE_PATH"] = root.path; environment["HOSTNAME"] = "127.0.0.1"; environment["PORT"] = "3178"
            process.environment = environment
            let pipe = Pipe(); process.standardInput = pipe; input = pipe
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            child = process; try process.run()
            for _ in 0..<120 {
                guard process.isRunning else { throw failure("Локальний сервер завершився під час запуску. Перевірте проєкт і файли програми.") }
                if matches(await health(), id) {
                    UserDefaults.standard.set(root.path, forKey: "risenTeamProject"); ready = true
                    monitor = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                        Task { @MainActor in
                            guard let self, !self.stopping, let child = self.child, !child.isRunning else { return }
                            self.ready = false; self.monitor?.invalidate()
                            self.error("Локальний сервер завершився. Запустіть Risen Team знову. Збережені дані залишаються у папці проєкту.")
                            NSApp.terminate(nil)
                        }
                    }
                    openEditor(); return
                }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
            throw failure("Не вдалося підтвердити готовність цього проєкту.")
        } catch { self.error(error.localizedDescription); await stop() }
    }

    @objc private func openEditor() { if ready { NSWorkspace.shared.open(base.appendingPathComponent("halls")) } }
    @objc private func openProject() { if let workspace { NSWorkspace.shared.open(workspace) } }
    @objc private func quit() { Task { await stop() } }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Finder reactivates the existing app instead of starting a second
        // launcher. Initial startup opens the browser after readiness itself.
        if !stopping { openEditor() }
        return false
    }

    private func stop() async {
        if stopping { return }; stopping = true
        for _ in 0..<200 {
            if importing?.isRunning != true { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if importing?.isRunning == true { error("Зачекайте завершення перенесення бази, потім повторіть завершення."); stopping = false; return }
        if let child, child.isRunning {
            do { try input?.fileHandleForWriting.write(contentsOf: Data("shutdown\n".utf8)) }
            catch { self.error("Не вдалося надіслати запит завершення сервера."); stopping = false; return }
            for _ in 0..<80 {
                if !child.isRunning { break }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            if child.isRunning {
                error("Сервер ще завершує роботу. Повторіть завершення через кілька секунд; примусове закриття не виконано.")
                stopping = false; return
            }
        }
        monitor?.invalidate()
        if lockFile >= 0 { Darwin.close(lockFile); lockFile = -1 }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if importing?.isRunning == true || child?.isRunning == true { Task { await stop() }; return .terminateCancel }
        return .terminateNow
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = Launcher()
    application.delegate = delegate
    application.run()
}
