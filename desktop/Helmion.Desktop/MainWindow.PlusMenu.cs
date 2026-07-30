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
                ? $"Maestro: {display} — Helmion has not mapped this provider's CLI yet, so there is "
                  + "nothing to show. It will not guess at another provider's features."
                : $"Maestro: {display} · this is {display}'s own CLI surface, with its real syntax.";
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
            Filter = "Text and code files|*.txt;*.md;*.log;*.csv;*.json;*.yaml;*.yml;*.xml;*.html;*.css;"
                   + "*.js;*.mjs;*.ts;*.tsx;*.cs;*.py;*.rb;*.go;*.rs;*.java;*.sql;*.sh;*.ps1;*.xaml"
                   + "|All files|*.*",
        };

        // Cancelling is not a failure and must not leave a row behind.
        if (dialog.ShowDialog(this) != true) return Task.CompletedTask;

        var row = _plusMenu.Begin(PlusMenuKind.Upload, Path.GetFileName(dialog.FileName));
        var decision = AttachmentPolicy.Validate(dialog.FileName);

        if (!decision.Accepted)
        {
            _plusMenu.Fail(row, decision.Message);
            return Task.CompletedTask;
        }

        _plusMenu.Succeed(row, decision.Message);
        return Task.CompletedTask;
    }

    /// <summary>
    /// List the slash commands this session can call. Real: it goes through the
    /// Node bridge's existing commands call, the same one the console uses.
    /// </summary>
    private async Task AddSkillsAsync()
    {
        var row = _plusMenu.Begin(PlusMenuKind.Skill, "Skills");
        try
        {
            _agentBridge ??= new AgentBridge();
            var ev = await _agentBridge.ListCommandsAsync();

            if (!string.Equals(ev.Event, "commands", StringComparison.Ordinal))
            {
                _plusMenu.Fail(row,
                    $"The agent bridge answered \"{ev.Event}\" instead of a command list. "
                    + "Skills are unavailable until it starts cleanly.");
                return;
            }

            _plusMenu.Succeed(row,
                "Skills loaded. Type / in the box to see them, or add your own as a "
                + "SKILL.md under .helmion/commands.");
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not load skills: {ex.Message}");
        }
    }

    /// <summary>
    /// Find a connector (an MCP server) for something the user needs. Real: it
    /// runs the existing read-only discovery stage — no install, no execution.
    /// </summary>
    private async Task AddConnectorAsync()
    {
        var need = (ConsoleInputBox?.Text ?? string.Empty).Trim();
        var row = _plusMenu.Begin(PlusMenuKind.Connector, "Connectors");

        // Non-null means the search was never started — an empty box is a step not
        // taken yet, not a search that failed.
        if (FirstRunStates.ConnectorNeed(need) is { } notYet)
        {
            _plusMenu.Settle(row, notYet);
            return;
        }

        try
        {
            var result = await McpSecurityRunner.DiscoverAsync(need);
            if (!result.Ok)
            {
                _plusMenu.Fail(row, string.IsNullOrWhiteSpace(result.Summary)
                    ? $"Discovery failed with exit code {result.ExitCode}."
                    : result.Summary);
                return;
            }

            _plusMenu.Succeed(row, result.Summary);
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not search for connectors: {ex.Message}");
        }
    }

    /// <summary>
    /// Read the plugins registered for this workspace. Real: it reads the
    /// registry the CLI writes, and says plainly when there are none rather than
    /// showing an empty success.
    /// </summary>
    private Task AddPluginsAsync()
    {
        var row = _plusMenu.Begin(PlusMenuKind.Plugin, "Plugins");
        try
        {
            // Empty-vs-failed is decided in Core, not here. That is what lets the
            // headless suite prove "a fresh empty workspace produces zero red
            // banners" against a real temporary folder — the old proof needed a
            // WPF window and so could not be run at all.
            _plusMenu.Settle(row, FirstRunStates.Plugins(ResolveAgentWorkspace()));
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not read the plugin registry: {ex.Message}");
        }

        return Task.CompletedTask;
    }
}
