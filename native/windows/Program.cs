using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;

namespace RisenTeam;

internal static class Program
{
    internal const string BaseUrl = "http://127.0.0.1:3178";
    internal const string Identity = "risen-team-schedule-builder-v1";
    internal static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(2) };
    internal static string? SmokeProject => Environment.GetCommandLineArgs().FirstOrDefault(value => value.StartsWith("--smoke-test="))?[13..];
    internal static void Report(string message)
    {
        if (SmokeProject is { } root)
        {
            try
            {
                if (Path.IsPathFullyQualified(root) && Directory.Exists(root)) File.AppendAllText(Path.Combine(root, "launcher-smoke.log"), message + Environment.NewLine);
                else Console.Error.WriteLine(message);
            }
            catch (IOException) { Console.Error.WriteLine(message); }
        }
        else MessageBox.Show(message, "Risen Team", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        try { Application.Run(new Launcher()); }
        catch (Exception error) { Environment.ExitCode = 1; Report(error.Message); }
    }

    internal static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
    internal static async Task<JsonElement?> Health()
    {
        try
        {
            using var response = await Client.GetAsync(BaseUrl + "/api/health");
            if (!response.IsSuccessStatusCode) return null;
            return await response.Content.ReadFromJsonAsync<JsonElement>();
        }
        catch (HttpRequestException) { return null; }
        catch (TaskCanceledException) { return null; }
        catch (JsonException) { return null; }
    }

    internal static bool Matches(JsonElement? health, string workspaceId) =>
        health is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True &&
        value.TryGetProperty("app", out var app) && app.ValueKind == JsonValueKind.String && app.GetString() == Identity &&
        value.TryGetProperty("protocolVersion", out var protocol) && protocol.ValueKind == JsonValueKind.Number && protocol.TryGetInt32(out var version) && version == 1 &&
        value.TryGetProperty("workspaceId", out var workspace) && workspace.ValueKind == JsonValueKind.String && string.Equals(workspace.GetString(), workspaceId, StringComparison.OrdinalIgnoreCase);
}

internal sealed class Launcher : ApplicationContext
{
    private readonly NotifyIcon tray;
    private readonly string settings;
    private FileStream? reservation;
    private Process? server;
    private string workspace = "";
    private bool stopping;
    private bool ready;
    private System.Windows.Forms.Timer? monitor;
    private string? legacySource;
    private Process? importing;

    internal Launcher()
    {
        var smoke = Program.SmokeProject;
        if (smoke is not null && (!Path.IsPathFullyQualified(smoke) || !File.Exists(Path.Combine(smoke, "project.json")))) throw new IOException("Smoke test requires an absolute existing temporary project path.");
        var settingsDirectory = smoke is null ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RisenTeamLauncher") : Path.Combine(smoke, ".launcher-smoke");
        Directory.CreateDirectory(settingsDirectory);
        settings = Path.Combine(settingsDirectory, "last-project.txt");
        tray = new NotifyIcon { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? System.Drawing.SystemIcons.Application, Text = "Risen Team", Visible = smoke is null };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Відкрити конструктор", null, (_, _) => { if (ready) Program.Open(Program.BaseUrl + "/halls"); });
        menu.Items.Add("Відкрити папку проєкту", null, (_, _) => { if (workspace.Length > 0) Program.Open(workspace); });
        menu.Items.Add("Завершити", null, async (_, _) => await Stop());
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => { if (ready) Program.Open(Program.BaseUrl + "/halls"); };
        // A WinForms timer enters the message loop before asynchronous initialization starts.
        var start = new System.Windows.Forms.Timer { Interval = 1 };
        start.Tick += async (_, _) => { start.Stop(); start.Dispose(); await Start(settingsDirectory); };
        start.Start();
    }

    private string SelectProject()
    {
        if (Program.SmokeProject is { } smoke) return Path.GetFullPath(smoke);
        if (File.Exists(settings))
        {
            var previous = File.ReadAllText(settings).Trim();
            if (Directory.Exists(previous) && File.Exists(Path.Combine(previous, "project.json"))) return previous;
            MessageBox.Show("Останній проєкт недоступний. Виберіть його папку; дані не буде замінено.", "Risen Team");
        }
        using var choice = new Form { Text = "Risen Team", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        var actions = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, Padding = new Padding(18) };
        foreach (var action in new[] { ("Створити новий проєкт", DialogResult.Yes), ("Відкрити папку проєкту", DialogResult.No), ("Імпортувати стару базу", DialogResult.Retry), ("Скасувати", DialogResult.Cancel) })
        {
            var button = new Button { Text = action.Item1, DialogResult = action.Item2, AutoSize = true, MinimumSize = new System.Drawing.Size(260, 36) };
            actions.Controls.Add(button); if (action.Item2 == DialogResult.Cancel) choice.CancelButton = button;
        }
        choice.Controls.Add(actions);
        var selected = choice.ShowDialog();
        if (selected == DialogResult.Cancel) throw new OperationCanceledException();
        var create = selected is DialogResult.Yes or DialogResult.Retry;
        if (selected == DialogResult.Retry)
        {
            var candidates = new[] { Path.Combine(AppContext.BaseDirectory, "data", "risen-team.db"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RisenTeamSchedule-v1.0", "risen-team.db") };
            using var source = new OpenFileDialog { Title = "Виберіть стару базу Risen Team. Оригінал залишиться без змін", Filter = "База SQLite (*.db)|*.db|Усі файли (*.*)|*.*", CheckFileExists = true };
            var candidate = candidates.FirstOrDefault(File.Exists);
            if (candidate is not null) { source.InitialDirectory = Path.GetDirectoryName(candidate); source.FileName = Path.GetFileName(candidate); }
            if (source.ShowDialog() != DialogResult.OK) throw new OperationCanceledException();
            legacySource = Path.GetFullPath(source.FileName);
        }
        using var dialog = new FolderBrowserDialog { Description = create ? "Виберіть порожню папку нового проєкту" : "Виберіть папку з project.json", UseDescriptionForTitle = true };
        if (dialog.ShowDialog() != DialogResult.OK) throw new OperationCanceledException();
        var root = Path.GetFullPath(dialog.SelectedPath);
        if (create)
        {
            if (Directory.EnumerateFileSystemEntries(root).Any()) throw new IOException("Новий проєкт потребує порожньої папки.");
            var manifest = JsonSerializer.Serialize(new { format = "risen-team-project", formatVersion = 1, workspaceId = Guid.NewGuid().ToString(), createdAt = DateTime.UtcNow.ToString("O") });
            // Exclusive publication prevents overwriting an existing project identity.
            using var file = new FileStream(Path.Combine(root, "project.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None);
            using var writer = new StreamWriter(file);
            writer.Write(manifest); writer.Flush(); file.Flush(true);
        }
        return root;
    }

    private static string ReadIdentity(string root)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "project.json")));
        var manifest = doc.RootElement;
        if (manifest.GetProperty("format").GetString() != "risen-team-project" || manifest.GetProperty("formatVersion").GetInt32() != 1 ||
            !Guid.TryParse(manifest.GetProperty("workspaceId").GetString(), out var id)) throw new IOException("Непідтримуваний project.json.");
        return id.ToString();
    }

    private async Task Start(string settingsDirectory)
    {
        try
        {
            workspace = SelectProject();
            var workspaceId = ReadIdentity(workspace);
            // Probe write permission without altering schedule data.
            var probe = Path.Combine(workspace, ".write-test-" + Guid.NewGuid());
            using (var stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) stream.WriteByte(0);
            try { reservation = new FileStream(Path.Combine(settingsDirectory, "instance.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException)
            {
                for (var attempt = 0; attempt < 40; attempt++)
                {
                    if (Program.Matches(await Program.Health(), workspaceId)) { Program.Open(Program.BaseUrl + "/halls"); ExitThread(); return; }
                    await Task.Delay(250);
                }
                throw new IOException("Risen Team уже запускається або відкрито інший проєкт. Завершіть його через меню біля годинника.");
            }
            // Any listener, including a different Risen workspace, prevents a new server.
            using (var listener = new System.Net.Sockets.TcpClient())
            {
                try { await listener.ConnectAsync("127.0.0.1", 3178); throw new IOException("Порт 3178 зайнятий. Завершіть іншу копію програми або звільніть порт."); }
                catch (System.Net.Sockets.SocketException) { }
            }
            var application = Path.Combine(AppContext.BaseDirectory, "application");
            var node = Path.Combine(application, "runtime", "node", "node.exe");
            if (!File.Exists(node) || !File.Exists(Path.Combine(application, "server.js"))) throw new IOException("Файли програми неповні. Розпакуйте весь архів заново.");
            if (legacySource is not null)
            {
                var import = new ProcessStartInfo(node) { WorkingDirectory = application, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                import.ArgumentList.Add(Path.Combine(application, "import-legacy-project.cjs")); import.ArgumentList.Add(legacySource); import.ArgumentList.Add(workspace);
                using var copier = Process.Start(import) ?? throw new IOException("Не вдалося запустити перенесення бази.");
                importing = copier;
                var output = copier.StandardOutput.ReadToEndAsync(); var errors = copier.StandardError.ReadToEndAsync();
                await copier.WaitForExitAsync(); await output;
                importing = null;
                if (copier.ExitCode != 0) throw new IOException("Не вдалося перенести стару базу. Оригінал не змінено. " + await errors);
                if (stopping) return;
            }
            var info = new ProcessStartInfo(node) { WorkingDirectory = application, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            info.ArgumentList.Add("--require"); info.ArgumentList.Add(Path.Combine(application, "desktop-shutdown.cjs")); info.ArgumentList.Add(Path.Combine(application, "server.js"));
            info.Environment.Remove("RISEN_DB_PATH");
            info.Environment["RISEN_WORKSPACE_PATH"] = workspace;
            info.Environment["HOSTNAME"] = "127.0.0.1"; info.Environment["PORT"] = "3178";
            server = new Process { StartInfo = info, EnableRaisingEvents = true };
            server.OutputDataReceived += (_, _) => { }; server.ErrorDataReceived += (_, _) => { };
            server.Start(); server.BeginOutputReadLine(); server.BeginErrorReadLine();
            if (Program.SmokeProject is not null) Program.Report($"owned server pid: {server.Id}");
            for (var attempt = 0; attempt < 120; attempt++)
            {
                if (server.HasExited) throw new IOException("Локальний сервер завершився під час запуску. Перевірте проєкт і файли програми.");
                if (Program.Matches(await Program.Health(), workspaceId))
                {
                    File.WriteAllText(settings, workspace);
                    ready = true;
                    if (Program.SmokeProject is not null)
                    {
                        Program.Report("ready: matching app/protocol/workspace; graceful shutdown requested");
                        await Stop(); return;
                    }
                    monitor = new System.Windows.Forms.Timer { Interval = 1000 };
                    monitor.Tick += (_, _) =>
                    {
                        if (!stopping && server.HasExited)
                        {
                            ready = false; monitor.Stop();
                            MessageBox.Show("Локальний сервер завершився. Запустіть Risen Team знову. Збережені дані залишаються у папці проєкту.", "Risen Team", MessageBoxButtons.OK, MessageBoxIcon.Error);
                            ExitThread();
                        }
                    };
                    monitor.Start();
                    Program.Open(Program.BaseUrl + "/halls"); return;
                }
                await Task.Delay(250);
            }
            throw new IOException("Не вдалося підтвердити готовність цього проєкту за 30 секунд.");
        }
        catch (OperationCanceledException) { await Stop(); }
        catch (Exception error) { Environment.ExitCode = 1; Program.Report(error.Message); await Stop(); }
    }

    private async Task Stop()
    {
        if (stopping) return;
        stopping = true;
        for (var attempt = 0; attempt < 200 && importing is { HasExited: false }; attempt++) await Task.Delay(100);
        if (importing is { HasExited: false })
        {
            Program.Report("Зачекайте завершення перенесення бази, потім повторіть завершення.");
            stopping = false; return;
        }
        if (server is { HasExited: false })
        {
            try
            {
                await server.StandardInput.WriteLineAsync("shutdown"); await server.StandardInput.FlushAsync();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                await server.WaitForExitAsync(timeout.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or InvalidOperationException)
            {
                if (Program.SmokeProject is not null)
                {
                    Environment.ExitCode = 1;
                    Program.Report("graceful shutdown timed out; owned server left running for diagnosis");
                    ExitThread(); return;
                }
                Program.Report("Сервер ще завершує роботу. Повторіть завершення через кілька секунд; примусове закриття не виконано.");
                stopping = false; return;
            }
        }
        if (Program.SmokeProject is not null && Environment.ExitCode == 0) Program.Report("shutdown: owned server exited; test passed");
        ExitThread();
    }

    protected override void ExitThreadCore()
    {
        monitor?.Dispose(); tray.Visible = false; tray.Dispose(); server?.Dispose(); reservation?.Dispose();
        base.ExitThreadCore();
    }
}
