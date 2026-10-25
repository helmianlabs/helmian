// PC release chain guards: the pipeline must live where GitHub Actions looks,
// and the installer payload must contain the bridge an installed PC runs.
// Structural (file-content) tests, matching this repo's guard style — the real
// Windows build itself runs on the windows-latest release runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('release workflow lives under .github/workflows, not the installer folder', () => {
  assert.ok(existsSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url)));
  assert.ok(!existsSync(new URL('../desktop/installer/desktop-release.workflow.yml', import.meta.url)));
  const yml = read('.github/workflows/desktop-release.yml');
  assert.ok(!yml.includes('\t'), 'workflow YAML must not contain tabs');
  assert.match(yml, /name: desktop-release/u);
  assert.match(yml, /tags: \[ 'v\*\.\*\.\*' \]/u);
  assert.match(yml, /workflow_dispatch/u);
  assert.match(yml, /runs-on: windows-latest/u);
  assert.match(yml, /desktop\/scripts\/publish\.ps1/u);
  assert.match(yml, /Publish GitHub Release \(tags only\)/u);
  assert.match(yml, /gh release create/u);
});

test('publish.ps1 ships the bridge service and the Node bridge app', () => {
  const ps1 = read('desktop/scripts/publish.ps1');
  assert.match(ps1, /Helmion\.BridgeService\\Helmion\.BridgeService\.csproj/u);
  assert.match(ps1, /Publish-HelmionProject -Project \$bridgeProject/u);
  assert.match(ps1, /Helmian Bridge Service\.exe/u);
  // The Node app the service supervises: scripts staged beside the exes,
  // production dependencies installed, and a node.exe bundled from the
  // build machine so an installed PC needs no pre-installed Node.js.
  assert.match(ps1, /bin\\pc-bridge\.mjs/u);
  assert.match(ps1, /bin\\hands-spoke\.mjs/u);
  assert.match(ps1, /'hands-mcp'/u);
  assert.match(ps1, /npm ci --omit=dev/u);
  assert.match(ps1, /'node\.exe'\)/u);
});

test('packaged smoke tests are bounded: a stalled check kills its tree and fails loudly', () => {
  // Run 40211924669: the Publish step sat silent for 58 minutes until the job
  // cap killed it — Invoke-PackagedSmoke waited on WaitForExit() with no
  // timeout and the GUI-subsystem checks print nothing of their own. These
  // pins keep the bound (and the per-check announcement) from regressing.
  const ps1 = read('desktop/scripts/publish.ps1');
  assert.match(ps1, /\[int\]\$TimeoutSeconds = 120/u);
  assert.match(ps1, /WaitForExit\(\$TimeoutSeconds \* 1000\)/u);
  assert.match(ps1, /\$smokeProcess\.Kill\(\$true\)/u);
  assert.match(ps1, /Packaged smoke test timed out after \$\{TimeoutSeconds\}s: \$Executable \$Argument/u);
  assert.match(ps1, /Write-Host "Packaged smoke: \$Executable \$Argument/u);
  assert.match(ps1, /Write-Host "Packaged smoke passed: \$Executable \$Argument"/u);
  assert.match(ps1, /HELMION_SMOKE_TRACE_PATH/u);
  assert.ok(!ps1.includes('$smokeProcess.WaitForExit()\n'),
    'the unbounded WaitForExit() call must not come back');
});

test('service smoke test bounds its pipe reads and fails as exit 2, never a hang or a crash', () => {
  // RunServiceSmokeAsync used to call the connector with its default
  // CancellationToken.None, under which a pipe read waits indefinitely for a
  // response frame; and a thrown connect error escaped the async-void
  // OnStartup as an unhandled exception instead of a clean smoke failure.
  const app = read('desktop/Helmion.Desktop/App.xaml.cs');
  assert.match(app, /new CancellationTokenSource\(TimeSpan\.FromSeconds\(90\)\)/u);
  assert.match(app, /EnsureConnectedAsync\(timeout\.Token\)/u);
  assert.match(app, /DetectCapabilitiesAsync\(timeout\.Token\)/u);
  assert.match(app, /InspectWorkspaceAsync\(smokeWorkspace, timeout\.Token\)/u);
  assert.match(app, /succeeded = false;/u);
});

test('empty-workspace audit can never block on the connector prompt', () => {
  // Run 40219039046: --empty-workspace-audit timed out at 120s and had to be
  // killed by the packaged-smoke bound. CountFreshWorkspaceRedRows clears the console box and
  // then ran AddConnectorAsync() with default arguments; with nothing typed,
  // ResolveConnectorNeed fell through to PromptForConnectorNeed's modal
  // ShowDialog — a loop only a person can end, on an unattended runner — so
  // the audit never returned and ExitWith was never reached. These pins keep
  // the headless path prompt-free while the interactive prompt stays.
  const window_ = read('desktop/Helmion.Desktop/MainWindow.xaml.cs');
  const plusMenu = read('desktop/Helmion.Desktop/MainWindow.PlusMenu.cs');
  const app = read('desktop/Helmion.Desktop/App.xaml.cs');
  // The audit call passes the prompt off, explicitly.
  assert.match(window_, /AddConnectorAsync\(allowNeedPrompt: false\)/u);
  assert.ok(!window_.includes('_ = AddConnectorAsync();'),
    'the audit must not call AddConnectorAsync with the prompt left on');
  // The prompt is opt-out at the need resolution, and only there.
  assert.match(plusMenu, /AddConnectorAsync\(bool allowNeedPrompt = true\)/u);
  assert.match(plusMenu, /ResolveConnectorNeed\(allowNeedPrompt\)/u);
  assert.match(plusMenu, /allowPrompt \? PromptForConnectorNeed\(\) : null/u);
  // Interactive callers keep the prompt (default argument, unchanged calls).
  assert.match(plusMenu, /case PlusMenuKind\.Connector: await AddConnectorAsync\(\); break;/u);
  // The audit branch still terminates through ExitWith with its verdict
  // semantics: 0 when no first-run state reads red, 3 when one does.
  assert.match(app, /ExitWith\(red == 0 \? 0 : 3\)/u);
});

test('bridge service finds the bundled node.exe next to its own exe', () => {
  const cs = read('desktop/Helmion.BridgeService/BridgeSupervisor.cs');
  assert.match(cs, /AppContext\.BaseDirectory, "node\.exe"/u);
});
