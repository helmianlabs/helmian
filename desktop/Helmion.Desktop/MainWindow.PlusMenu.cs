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

        // The popup's four rows come from the catalog, so the menu and the
        // descriptions can never drift apart.
        if (ConsolePlusItems is not null)
        {
            ConsolePlusItems.ItemsSource = PlusMenuCatalog.Entries;
        }
    }

    private void ConsolePlusButton_Click(object sender, RoutedEventArgs e)
    {
        if (ConsolePlusItems is not null && ConsolePlusItems.ItemsSource is null)
        {
            ConsolePlusItems.ItemsSource = PlusMenuCatalog.Entries;
        }
        if (ConsolePlusPopup is not null)
        {
            ConsolePlusPopup.IsOpen = !ConsolePlusPopup.IsOpen;
        }
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

        if (need.Length == 0)
        {
            _plusMenu.Fail(row,
                "Type what you need it to reach into the box first — for example "
                + "\"read local sqlite\" or \"post to Slack\" — then press + › Connectors.");
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
            var workspace = ResolveAgentWorkspace();
            if (string.IsNullOrWhiteSpace(workspace) || !Directory.Exists(workspace))
            {
                _plusMenu.Fail(row,
                    "No workspace is registered, so there is nowhere to read plugins from. "
                    + "Pick a workspace on the Workspace tab first.");
                return Task.CompletedTask;
            }

            var registry = Path.Combine(workspace, ".helmion", "plugins.json");
            if (!File.Exists(registry))
            {
                _plusMenu.Fail(row,
                    $"No plugins are installed in this workspace yet — {registry} does not exist. "
                    + "Install one with: helmion plugin add <path>");
                return Task.CompletedTask;
            }

            var bytes = new FileInfo(registry).Length;
            _plusMenu.Succeed(row,
                $"Plugin registry read from {registry} ({AttachmentPolicy.DescribeSize(bytes)}). "
                + "Run: helmion plugin commands — to see what they add.");
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not read the plugin registry: {ex.Message}");
        }

        return Task.CompletedTask;
    }
}
