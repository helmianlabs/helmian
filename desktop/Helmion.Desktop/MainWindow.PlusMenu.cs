using System.IO;
using System.Windows;
using System.Windows.Controls;
using Helmion.Desktop.Core;
using Microsoft.Win32;

namespace Helmion.Desktop;

/// <summary>
/// The composer's + menu: Connectors, Plugins, Skills, Upload.
///
/// A SEPARATE PARTIAL ON PURPOSE. MainWindow.xaml.cs is over four thousand lines
/// and is claimed by other work; nothing in this feature needs to be in it. The
/// only coupling is the existing <c>_agentBridge</c> field, reached through a
/// small accessor below so a future refactor breaks at compile time rather than
/// silently.
///
/// THE STATE MACHINE IS NOT IN HERE. It lives in Helmion.Desktop.Core.PlusMenu as
/// a pure object, because Troy's directive singled out the two states that never
/// get tested — in-progress and failed — and a state machine welded into a window
/// can only be exercised by clicking it. This file does the I/O; Core decides
/// what the row says. Every path below ends in exactly one of Succeed or Fail,
/// and there is no early return that leaves a row spinning.
/// </summary>
public partial class MainWindow
{
    private readonly PlusMenuController _plusMenu = new();

    // ── wiring ────────────────────────────────────────────────────────────────

    private void ConsolePlusRows_Loaded(object sender, RoutedEventArgs e)
    {
        if (sender is ItemsControl rows)
        {
            rows.ItemsSource = _plusMenu.Items;
        }
    }

    /// <summary>
    /// The current Maestro, read fresh from settings every time the menu opens.
    ///
    /// Read at OPEN rather than cached at startup because the coordinator is a
    /// dropdown the operator changes mid-session, and a menu that still shows the
    /// previous provider's syntax after the switch is worse than no menu.
    /// </summary>
    private static string? CurrentMaestro()
    {
        try
        {
            return EnvironmentSettingsStore.Load().MaestroCoordinator;
        }
        catch
        {
            return null;
        }
    }

    private void ConsolePlusButton_Click(object sender, RoutedEventArgs e)
    {
        if (ConsolePlusPopup is null) return;

        if (ConsolePlusPopup.IsOpen)
        {
            ConsolePlusPopup.IsOpen = false;
            return;
        }

        var maestro = CurrentMaestro();
        var display = MaestroKey.DisplayName(maestro);
        var capabilities = ProviderCapabilityCatalog.For(maestro);

        if (ConsolePlusItems is not null)
        {
            // An unmapped Maestro shows an EMPTY list and a header that says so.
            // It deliberately does not fall back to another provider's menu —
            // offering Claude's plugin command while Grok is driving would be a
            // confident answer to a question nobody asked.
            ConsolePlusItems.ItemsSource = capabilities;
        }

        if (ConsolePlusHeader is not null)
        {
            ConsolePlusHeader.Text = capabilities is null
                ? $"{display} is not mapped yet. Switch Maestro to ChatGPT (Codex), Claude, Gemini, or Grok."
                : $"{display} · Attach, skills, plugins, connectors. Lists and attaches only — does not install.";
        }

        ConsolePlusPopup.IsOpen = true;
    }

    private async void ConsolePlusItem_Click(object sender, RoutedEventArgs e)
    {
        if (ConsolePlusPopup is not null) ConsolePlusPopup.IsOpen = false;
        if (sender is not Button { Tag: PlusMenuKind kind }) return;

        switch (kind)
        {
            case PlusMenuKind.Upload: await AddUploadAsync(); break;
            case PlusMenuKind.Skill: await AddSkillsAsync(); break;
            case PlusMenuKind.Connector: await AddConnectorAsync(); break;
            case PlusMenuKind.Plugin: await AddPluginsAsync(); break;
            case PlusMenuKind.Permission:
                if (ConsolePermissionPopup is not null)
                {
                    ConsolePermissionPopup.IsOpen = true;
                }
                break;
        }
    }

    private void ConsolePlusRemove_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { DataContext: PlusActionItem item }) _plusMenu.Remove(item);
    }

    private void ConsolePlusUndo_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { DataContext: PlusActionItem item }) _plusMenu.Undo(item);
    }

    // ── the four actions ──────────────────────────────────────────────────────

    /// <summary>
    /// Attach a file. Every refusal from <see cref="AttachmentPolicy"/> becomes a
    /// visible failed row carrying the policy's own sentence — file too large and
    /// unsupported type included, which is the specific thing Troy said must
    /// never fail silently.
    /// </summary>
    private Task AddUploadAsync()
    {
        var dialog = new OpenFileDialog
        {
            Title = "Attach a file to your next message",
            CheckFileExists = true,
            Multiselect = false,
            Filter = "Supported files|*.png;*.jpg;*.jpeg;*.webp;*.txt;*.md;*.log;*.csv;*.json;*.yaml;*.yml;*.xml;*.html;*.css;"
                   + "*.js;*.mjs;*.ts;*.tsx;*.cs;*.py;*.rb;*.go;*.rs;*.java;*.sql;*.sh;*.ps1;*.xaml"
                   + "|All files|*.*",
        };

        // Cancelling is not a failure and must not leave a row behind.
        if (dialog.ShowDialog(this) != true) return Task.CompletedTask;

        // THE FULL PATH IS KEPT, not just the name. Keeping only the name is what
        // made this whole feature decorative: the row said "Added" and nothing
        // downstream could ever reopen the file the user picked.
        var row = _plusMenu.Begin(
            PlusMenuKind.Upload,
            Path.GetFileName(dialog.FileName),
            message: null,
            sourcePath: dialog.FileName);
        var decision = AttachmentPolicy.Validate(dialog.FileName);

        if (!decision.Accepted)
        {
            _plusMenu.Fail(row, decision.Message);
            return Task.CompletedTask;
        }

        // The same evidence-first preflight used for downloads, MCP servers,
        // plugins and skills also covers attachments. Attachment mode marks
        // install-only evidence as not applicable because the file is sent as
        // text and never executed, but still hashes the exact selected bytes and
        // fails closed on any blocking finding. Render the same review in the
        // Integrations panel so the decision is inspectable rather than hidden in
        // this one row.
        var preflight = _externalItemPreflight.ReviewLocalFile(
            dialog.FileName,
            ExternalItemReviewCoverage.ForPlusMenu(PlusMenuKind.Upload));
        RenderExternalItemReview(preflight);
        if (preflight.Decision != ExternalItemReviewDecision.ReadyToApprove)
        {
            _plusMenu.Fail(
                row,
                $"Review before attach: {preflight.DecisionLabel}. {preflight.Explanation}");
            return Task.CompletedTask;
        }

        _plusMenu.Succeed(
            row,
            $"{decision.Message} Review before attach: {preflight.DecisionLabel}; "
            + $"SHA-256 {preflight.Evidence.Sha256}.");
        return Task.CompletedTask;
    }

    /// <summary>
    /// List the slash commands this session can call, BY NAME.
    ///
    /// <para>
    /// TWO DEFECTS FIXED HERE, both of which left the row looking healthy.
    /// </para>
    /// <para>
    /// FIRST, IT ASKED ABOUT THE WRONG FOLDER. The call was
    /// <c>ListCommandsAsync()</c> with no argument, and AgentBridge.cs:236-245 says
    /// in its own documentation what that means: the bridge answers about the
    /// directory it started in — the Helmion repo root, stamped as WORKSPACE_PATH
    /// at AgentBridge.cs:90 — not the workspace the operator registered. The
    /// console's own listing at MainWindow.xaml.cs:2328 already passed
    /// <c>ResolveAgentWorkspace()</c>; this one did not, so the same button in two
    /// places described two different projects.
    /// </para>
    /// <para>
    /// SECOND, IT THREW THE ANSWER AWAY. It read <c>ev.Event</c> and nothing else,
    /// then printed a sentence written at compile time. The bridge re-scans the
    /// command directories on every call (src/agent/bridge.mjs:304) and hands back
    /// the whole registry — and none of it reached the screen. An empty workspace
    /// and a workspace with fifty skills produced identical output, so the row
    /// could not be wrong and could not be useful.
    /// </para>
    /// </summary>
    private async Task AddSkillsAsync()
    {
        var workspace = ResolveAgentWorkspace();
        var row = _plusMenu.Begin(PlusMenuKind.Skill, "Skills", successWord: "Listed");
        try
        {
            _agentBridge ??= new AgentBridge();

            // Whether this is Succeeded, Empty or Failed is decided in Core against
            // the real payload, so the headless suite asserts the same sentence the
            // window draws rather than a parallel one that can drift from it.
            _plusMenu.Settle(
                row,
                BridgeCapabilitySummary.Skills(
                    await _agentBridge.ListCommandsAsync(workspace),
                    workspace,
                    CodexSkillDiscovery.Discover()));
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not load skills: {ex.Message}");
        }
    }

    /// <summary>
    /// SEARCH for a candidate connector (an MCP server). It does not connect one,
    /// and it is not going to.
    ///
    /// <para>
    /// THIS ROW MUST STAY GATED, AND THAT IS A DECISION RATHER THAN A GAP. Installing
    /// an MCP server means letting somebody else's process run on Troy's machine
    /// with his files and his keys in reach. The approval step for that requires a
    /// human to type a challenge phrase generated on the spot, at a real terminal —
    /// <c>src/core/mcp-approval.mjs:61-74</c> — and it refuses outright any caller
    /// whose stdin/stdout is not a TTY (<c>mcp-approval.mjs:80-89</c>). A WPF
    /// window never has one. That refusal is the feature: it is what makes "a human
    /// approved this" mean something, and it cannot be satisfied from here without
    /// destroying the thing it protects.
    /// </para>
    /// <para>
    /// So what this button honestly does is stage 1 of three: search GitHub for
    /// candidates (McpSecurityRunner.cs:42-60). Stage 2 reads a cloned candidate's
    /// source; stage 3 is the approval, on the command line. The row's own text now
    /// says that, and the result no longer settles as "Added" — nothing was added.
    /// </para>
    /// </summary>
    private async Task AddConnectorAsync()
    {
        // Prefer MCP panel need field, then composer, then a small prompt so
        // + › Connectors never dead-ends on "Nothing yet" with nowhere to type.
        var need = ResolveConnectorNeed();

        // "Found", not "Added". A list of GitHub repositories is not a connection,
        // and the state chip is the first thing the operator reads.
        var row = _plusMenu.Begin(
            PlusMenuKind.Connector, "Connector search", successWord: "Found");

        if (FirstRunStates.ConnectorNeed(need) is { } notYet)
        {
            _plusMenu.Settle(row, notYet);
            ConsoleInputBox?.Focus();
            return;
        }

        // Mirror into the MCP stage-1 box so Discover and + Connectors share state.
        if (McpDiscoverNeedInput is not null && string.IsNullOrWhiteSpace(McpDiscoverNeedInput.Text))
            McpDiscoverNeedInput.Text = need;

        try
        {
            var result = await McpSecurityRunner.DiscoverAsync(need!);
            if (!result.Ok)
            {
                _plusMenu.Fail(row, string.IsNullOrWhiteSpace(result.Summary)
                    ? $"Discovery failed with exit code {result.ExitCode}."
                    : result.Summary);
                return;
            }

            var summary = result.Summary;
            if (!string.IsNullOrWhiteSpace(summary)
                && !summary.Contains("helmion mcp", StringComparison.OrdinalIgnoreCase))
            {
                summary += " Next: clone a candidate, then MCP panel → Audit. Install only from a real terminal (helmion mcp review).";
            }

            _plusMenu.Succeed(row, summary);
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not search for connectors: {ex.Message}");
        }
    }

    /// <summary>
    /// Where the operator can type a connector need, in priority order.
    /// </summary>
    private string? ResolveConnectorNeed()
    {
        var fromMcp = (McpDiscoverNeedInput?.Text ?? string.Empty).Trim();
        if (fromMcp.Length > 0)
            return fromMcp;

        var fromConsole = (ConsoleInputBox?.Text ?? string.Empty).Trim();
        // Ignore slash commands / @mentions as "need" — those are not search phrases.
        if (fromConsole.Length > 0
            && !fromConsole.StartsWith('/')
            && !fromConsole.StartsWith('@'))
            return fromConsole;

        return PromptForConnectorNeed();
    }

    /// <summary>
    /// Small modal so + Connectors always has a place to type the need.
    /// Cancel → null (Empty state with next-step copy).
    /// </summary>
    private string? PromptForConnectorNeed()
    {
        var box = new TextBox
        {
            MinWidth = 360,
            Margin = new Thickness(0, 8, 0, 12),
            Padding = new Thickness(10, 8, 10, 8),
            FontSize = 13,
            Text = "read local sqlite",
        };
        var ok = new Button
        {
            Content = "Search",
            IsDefault = true,
            MinWidth = 88,
            Padding = new Thickness(14, 6, 14, 6),
            Margin = new Thickness(0, 0, 8, 0),
        };
        var cancel = new Button
        {
            Content = "Cancel",
            IsCancel = true,
            MinWidth = 88,
            Padding = new Thickness(14, 6, 14, 6),
        };
        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Children = { ok, cancel },
        };
        var root = new StackPanel
        {
            Margin = new Thickness(18),
            Children =
            {
                new TextBlock
                {
                    Text = "What should the connector reach?",
                    FontWeight = FontWeights.SemiBold,
                    FontSize = 14,
                    TextWrapping = TextWrapping.Wrap,
                },
                new TextBlock
                {
                    Text = "Example: read local sqlite · post to Slack · GitHub issues",
                    FontSize = 11,
                    Opacity = 0.75,
                    Margin = new Thickness(0, 4, 0, 0),
                    TextWrapping = TextWrapping.Wrap,
                },
                box,
                buttons,
            },
        };
        var dlg = new Window
        {
            Title = "Connector search",
            Content = root,
            SizeToContent = SizeToContent.WidthAndHeight,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Owner = this,
            ShowInTaskbar = false,
        };
        string? result = null;
        ok.Click += (_, _) =>
        {
            result = box.Text?.Trim();
            dlg.DialogResult = !string.IsNullOrWhiteSpace(result);
            dlg.Close();
        };
        cancel.Click += (_, _) =>
        {
            result = null;
            dlg.DialogResult = false;
            dlg.Close();
        };
        box.SelectAll();
        box.Focus();
        dlg.ShowDialog();
        return string.IsNullOrWhiteSpace(result) ? null : result;
    }

    /// <summary>
    /// List the plugins loaded in this workspace, and — the part that matters —
    /// every MCP server the install gate REFUSED, with the gate's reason.
    ///
    /// <para>
    /// WHAT THIS USED TO DO. It called <see cref="FirstRunStates.Plugins"/>, which
    /// stat()s <c>.helmion/plugins.json</c> and reports its SIZE IN BYTES
    /// (FirstRunStates.cs:78-95). The file was never opened. A workspace with five
    /// plugins, two of them broken and three declaring MCP servers that had been
    /// refused, read as "Plugin registry read from …\plugins.json (412 bytes)". The
    /// row was true and told the operator nothing.
    /// </para>
    /// <para>
    /// WHY THE BRIDGE AND NOT A LOCAL JSON PARSE. Parsing the registry here would
    /// have produced a second, weaker loader that agrees with the real one only
    /// until one of them changes. The bridge already runs the REAL loader —
    /// <c>loadEnabledPlugins</c> in src/agent/plugins.mjs, gate and all — on every
    /// <c>commands</c> call (src/agent/bridge.mjs:103), and already sends back the
    /// verdicts (bridge.mjs:309-317). Nothing new is executed to get this: reading
    /// a plugin never runs a line of it (plugins.mjs:22-25), and a declared MCP
    /// server stays refused unless the ledger already holds a human-approved
    /// baseline (plugins.mjs:196-266). This shows that decision instead of hiding it.
    /// </para>
    /// <para>
    /// THE FIRST-RUN PRE-FLIGHT IS KEPT AHEAD OF THE CALL. No workspace and no
    /// registry are still answered locally and still settle as EMPTY, so the "a
    /// fresh empty workspace produces zero red banners" guarantee does not start
    /// depending on whether Node is installed.
    /// </para>
    /// </summary>
    private async Task AddPluginsAsync()
    {
        var workspace = ResolveAgentWorkspace();
        var row = _plusMenu.Begin(PlusMenuKind.Plugin, "Plugins", successWord: "Listed");
        try
        {
            // Nothing to list, or a registry that is there and unreadable. Both are
            // decided without Node so a fresh workspace never depends on it.
            var firstRun = FirstRunStates.Plugins(workspace);
            if (firstRun.State != PlusActionState.Succeeded)
            {
                _plusMenu.Settle(row, firstRun);
                return;
            }

            _agentBridge ??= new AgentBridge();
            _plusMenu.Settle(
                row,
                BridgeCapabilitySummary.Plugins(
                    await _agentBridge.ListCommandsAsync(workspace),
                    workspace));
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not read the plugin registry: {ex.Message}");
        }
    }
}
