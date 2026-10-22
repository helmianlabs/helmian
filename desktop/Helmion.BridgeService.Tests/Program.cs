using Helmion.BridgeService;

var failures = 0;
void Check(string name, bool ok) { Console.WriteLine($"{(ok ? "ok" : "FAIL")} - {name}"); if (!ok) failures++; }
static string P(params string[] parts) => Path.Combine(parts);

var svc = P("C:", "Program Files", "Helmian", "Bridge");
var root = P("E:", "Helmion");
var node = P("C:", "Program Files", "nodejs", "node.exe");
var appData = P("C:", "Users", "troy", "AppData", "Roaming");
var config = SpokeLocator.ConfigPath(appData);
var spokeScript = P(root, "bin", "hands-spoke.mjs");
var bridgeScript = P(root, "bin", "pc-bridge.mjs");
Func<string, bool> Has(params string[] files) => f => files.Contains(f);

// Hands spoke
var (l, reason, notPaired) = SpokeLocator.Resolve(svc, root, node, appData, Has(node, spokeScript));
Check("spoke: not paired is a clean skip, not an error", l is null && notPaired && reason == SpokeLocator.NotPairedReason);

(l, reason, notPaired) = SpokeLocator.Resolve(svc, root, node, appData, Has(node, spokeScript, config));
Check("spoke: paired runs node bin/hands-spoke.mjs with no other args", l is not null && !notPaired && l.FileName == node && l.Arguments.SequenceEqual(new[] { spokeScript }) && l.WorkingDirectory == root);

(l, reason, notPaired) = SpokeLocator.Resolve(svc, root, null, appData, Has(spokeScript, config));
Check("spoke: no node is a real error with a plain reason", l is null && !notPaired && reason!.Contains("Node.js"));

(l, reason, notPaired) = SpokeLocator.Resolve(svc, null, node, appData, Has(node, config));
Check("spoke: missing script names HELMIAN_ROOT", l is null && !notPaired && reason!.Contains("HELMIAN_ROOT"));

(l, _, _) = SpokeLocator.Resolve(svc, null, node, appData, Has(node, config, P(svc, "bin", "hands-spoke.mjs")));
Check("spoke: falls back to the service folder", l is not null && l.WorkingDirectory == svc);

(l, _, notPaired) = SpokeLocator.Resolve(svc, root, node, "", Has(node, spokeScript, config));
Check("spoke: no APPDATA means not paired, never a guess", l is null && notPaired);

Check("spoke: config lives in %APPDATA%\\Helmian\\hands-spoke.json", config == P(appData, "Helmian", "hands-spoke.json"));

// Bridge is unchanged
var (b, bReason) = BridgeLocator.Resolve(svc, root, node, Has(node, bridgeScript));
Check("bridge: node bin/pc-bridge.mjs", b is not null && b.Arguments.SequenceEqual(new[] { bridgeScript }));
(b, _) = BridgeLocator.Resolve(svc, root, node, Has(node, bridgeScript, P(svc, "pc-bridge.exe")));
Check("bridge: packaged exe wins", b is not null && b.FileName == P(svc, "pc-bridge.exe"));

// Backoff
Check("backoff: 2s first, capped at 5 min", RestartBackoff.Next(0) == TimeSpan.FromSeconds(2) && RestartBackoff.Next(20) == TimeSpan.FromMinutes(5));
Check("backoff: 10 healthy minutes reset", RestartBackoff.CountsAsHealthy(TimeSpan.FromMinutes(10)) && !RestartBackoff.CountsAsHealthy(TimeSpan.FromMinutes(9)));


// Install config: HELMIAN_ROOT wins, else helmian-bridge.json next to the exe, never a crash
string? Read(string json, string path) => path == P(svc, InstallConfig.FileName) ? json : null;
Check("config: env var wins", InstallConfig.HelmianRoot(svc, root, _ => throw new IOException()) == root);
Check("config: file next to the exe", InstallConfig.HelmianRoot(svc, null, f => Read("{\"helmianRoot\":\"E:\\\\Helmion\"}", f)) == "E:\\Helmion");
Check("config: missing file is null", InstallConfig.HelmianRoot(svc, null, _ => null) is null);
Check("config: broken json is null, not a crash", InstallConfig.HelmianRoot(svc, null, f => Read("{nope", f)) is null);
Check("config: unreadable file is null", InstallConfig.HelmianRoot(svc, "", _ => throw new UnauthorizedAccessException()) is null);

// Plain-process (sign-in task) mode
Check("mode: not under SCM means the sign-in task mode", RunModeInfo.From(false) == RunMode.SignInTask && RunModeInfo.From(true) == RunMode.WindowsService);
Check("mode: one copy per PC across both modes", RunModeInfo.SingleInstanceName == @"Global\HelmianBridgeService");
Check("mode: log goes to %LOCALAPPDATA%\\Helmian\\logs", RunModeInfo.LogPath(P("C:", "Users", "troy", "AppData", "Local")) == P("C:", "Users", "troy", "AppData", "Local", "Helmian", "logs", "bridge-service.log"));
Check("mode: log rotates at 5 MB", RunModeInfo.ShouldRotate(5 * 1024 * 1024) && !RunModeInfo.ShouldRotate(5 * 1024 * 1024 - 1));

// Source guards for things only Windows can run: windowless exe, hidden children, children die with the parent
var dir = new DirectoryInfo(AppContext.BaseDirectory);
while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "Helmion.BridgeService"))) dir = dir.Parent;
var svcSrc = Path.Combine(dir!.FullName, "Helmion.BridgeService");
var csproj = File.ReadAllText(Path.Combine(svcSrc, "Helmion.BridgeService.csproj"));
var sup = File.ReadAllText(Path.Combine(svcSrc, "BridgeSupervisor.cs"));
var prog = File.ReadAllText(Path.Combine(svcSrc, "Program.cs"));
Check("exe: WinExe, so a plain start shows no console", csproj.Contains("<OutputType>WinExe</OutputType>"));
Check("children: CreateNoWindow, no shell, stdin closed", sup.Contains("CreateNoWindow = true") && sup.Contains("UseShellExecute = false") && sup.Contains("StandardInput.Close()"));
Check("children: joined to a kill-on-close job", sup.Contains("ChildJob.Track(process)") && File.ReadAllText(Path.Combine(svcSrc, "ChildJob.cs")).Contains("0x2000"));
Check("exe: event log only when the source exists", prog.Contains("EventSourceReady(") && prog.Contains("FileLoggerProvider"));

Console.WriteLine(failures == 0 ? "all checks passed" : $"{failures} check(s) failed");
return failures == 0 ? 0 : 1;
