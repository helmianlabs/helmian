using System.IO.Pipes;
using System.Text.Json;
using Helmion.Desktop.Core;

internal static class HeraldDesktopGatewayChecks
{
    public static void Run()
    {
        var instructions = new List<HeraldInstructionRequest>();
        var decisions = new List<HeraldApprovalDecision>();
        var audit = new List<HeraldAuditRecord>();
        HeraldSessionSnapshot? current = Snapshot();
        var gateway = new HeraldDesktopGateway(
            () => current,
            (request, _) => { instructions.Add(request); return Task.FromResult(new HeraldGatewayResult(true, "queued", "Visible in Helmian Desktop.")); },
            (decision, _) => { decisions.Add(decision); return Task.FromResult(new HeraldGatewayResult(true, "recorded", "Decision recorded.")); },
            (record, _) => { audit.Add(record); return Task.CompletedTask; },
            () => DateTimeOffset.Parse("2026-07-31T12:00:00Z"));

        Assert(gateway.IsAvailable(), "a selected desktop session is available");
        Assert(gateway.GetSessionSnapshot()?.Project.Name == "Demo", "the paired view reports the selected project");

        var valid = new HeraldInstructionRequest(
            "request-1", "phone-device-0001", "project-demo", "session-1",
            "Summarize the active work.", true, DateTimeOffset.UtcNow);
        var accepted = gateway.SubmitInstructionAsync(valid).GetAwaiter().GetResult();
        Assert(accepted.Accepted && instructions.Count == 1, "a confirmed selected-context instruction reaches the desktop delegate once");
        Assert(audit.Select(item => item.Event).SequenceEqual(
            ["remote_instruction_requested", "remote_instruction_result"]),
            "the desktop owns request and result audit records");

        var changed = valid with { Id = "request-2", ProjectId = "other-project" };
        var refused = gateway.SubmitInstructionAsync(changed).GetAwaiter().GetResult();
        Assert(!refused.Accepted && instructions.Count == 1, "a changed project reaches neither Maestro nor another session");

        var unconfirmed = valid with { Id = "request-3", Confirmed = false };
        refused = gateway.SubmitInstructionAsync(unconfirmed).GetAwaiter().GetResult();
        Assert(!refused.Accepted && instructions.Count == 1, "an unconfirmed phone instruction is denied");

        var approval = new HeraldApprovalDecision(
            "decision-1", "phone-device-0001", "project-demo", "session-1",
            "approval-1", "allow-once", true, DateTimeOffset.UtcNow);
        accepted = gateway.DecideApprovalAsync(approval).GetAwaiter().GetResult();
        Assert(accepted.Accepted && decisions.Count == 1, "an existing approval can be allowed once after confirmation");
        Assert(audit.Count == 4, "instruction and approval each record request and result");

        current = null;
        Assert(!gateway.IsAvailable(), "desktop shutdown makes Herald unavailable");
        refused = gateway.SubmitInstructionAsync(valid with { Id = "request-4" }).GetAwaiter().GetResult();
        Assert(!refused.Accepted && instructions.Count == 1, "desktop-offline instructions fail closed");

        var forbiddenNames = new[] { "Path", "Secret", "Token", "Credential", "Shell", "File" };
        var phoneTypes = new[] {
            typeof(HeraldSessionSnapshot), typeof(HeraldNamedState), typeof(HeraldGuardState),
            typeof(HeraldOutput), typeof(HeraldApproval), typeof(HeraldVoiceState),
        };
        Assert(phoneTypes.SelectMany(type => type.GetProperties())
                .All(property => forbiddenNames.All(fragment =>
                    !property.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase))),
            "the phone snapshot contract has no path, secret, token, credential, shell, or file property");

        var auditRoot = Path.Combine(Path.GetTempPath(), $"helmion-herald-audit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(auditRoot);
        try
        {
            var record = new HeraldAuditRecord(
                "remote_instruction_requested", "request-audit-1", "phone-device-0001",
                "project-demo", "session-1", "requested", DateTimeOffset.Parse("2026-07-31T12:00:00Z"));
            var path = HeraldAuditStore.AppendAsync(auditRoot, record).GetAwaiter().GetResult();
            HeraldAuditStore.AppendAsync(auditRoot, record with
            {
                Event = "remote_instruction_result", Result = "queued"
            }).GetAwaiter().GetResult();
            var lines = File.ReadAllLines(path);
            Assert(lines.Length == 2
                && lines[0].Contains("remote_instruction_requested", StringComparison.Ordinal)
                && lines[1].Contains("remote_instruction_result", StringComparison.Ordinal)
                && !string.Join("", lines).Contains("Summarize the active work", StringComparison.Ordinal),
                "the durable Herald ledger appends request/result metadata without instruction text");
        }
        finally
        {
            Directory.Delete(auditRoot, recursive: true);
        }

        current = Snapshot();
        var pipeName = $"helmion-herald-smoke-{Guid.NewGuid():N}";
        using var pipeCancellation = new CancellationTokenSource();
        var pipeServer = new HeraldDesktopPipeServer(pipeName, gateway);
        var pipeTask = Task.Run(async () =>
        {
            try { await pipeServer.RunAsync(pipeCancellation.Token); }
            catch (OperationCanceledException) when (pipeCancellation.IsCancellationRequested) { }
        });
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
                PipeOptions.Asynchronous);
            client.ConnectAsync(5_000).GetAwaiter().GetResult();
            var request = JsonSerializer.SerializeToUtf8Bytes(new
            {
                id = "pipe-request-1",
                action = "session.read",
                payload = new { },
            }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            var prefix = BitConverter.GetBytes(request.Length);
            client.Write(prefix);
            client.Write(request);
            client.Flush();
            var responsePrefix = new byte[4];
            client.ReadExactly(responsePrefix);
            var responseBytes = new byte[BitConverter.ToInt32(responsePrefix)];
            client.ReadExactly(responseBytes);
            using var response = JsonDocument.Parse(responseBytes);
            Assert(response.RootElement.GetProperty("ok").GetBoolean()
                && response.RootElement.GetProperty("value").GetProperty("project").GetProperty("name").GetString() == "Demo",
                "the current-user pipe returns the selected sanitized session snapshot");
        }
        finally
        {
            pipeCancellation.Cancel();
            pipeTask.GetAwaiter().GetResult();
        }

        Console.WriteLine("Helmion Herald desktop gateway checks passed (13 checks).");
    }

    private static HeraldSessionSnapshot Snapshot() => new(
        new HeraldNamedState("project-demo", "Demo"),
        new HeraldNamedState("session-1", "Build", "ready"),
        new HeraldNamedState("maestro", "Maestro"),
        new HeraldGuardState("quiet", "No pending review."),
        [new HeraldOutput("output-1", "Desktop is ready.")],
        [new HeraldApproval("approval-1", "Create the reviewed artifact.", "waiting")],
        new HeraldVoiceState(false, "Voice is not connected to Herald."),
        DateTimeOffset.Parse("2026-07-31T12:00:00Z"));

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Herald desktop gateway failed: {message}");
    }
}
