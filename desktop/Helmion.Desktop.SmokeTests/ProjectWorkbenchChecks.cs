using System.Text;
using Helmion.Desktop.Core;

internal static class ProjectWorkbenchChecks
{
    public static void Run()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            $"helmian-project-workbench-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);

        try
        {
            var empty = ProjectWorkbenchStore.LoadCanvas(root);
            Check(empty.Text.Length == 0 && empty.ModifiedAtUtc is null,
                "an untouched project has an honest empty Canvas");
            Check(!File.Exists(empty.DocumentPath),
                "reading Canvas creates no project files");

            var at = new DateTimeOffset(2026, 8, 1, 8, 15, 0, TimeSpan.Zero);
            var note = "# Demo decisions\n\nKeep the browser non-executing.";
            var saved = ProjectWorkbenchStore.SaveCanvas(root, note, at);
            var canvasPath = Path.Combine(root, "planning", "canvas.md");
            Check(File.Exists(canvasPath) && File.ReadAllText(canvasPath) == note,
                "Save Canvas writes the exact note beneath the selected project");
            Check(saved.Kind == "note" && saved.EvidenceHash?.Length == 64,
                "a Canvas save records typed activity with a content hash");

            ProjectWorkbenchStore.RecordDecision(
                root,
                "Browser remains review-only until its trust gate passes.",
                at.AddMinutes(1));
            ProjectWorkbenchStore.RecordApproval(
                root,
                "approval-fixture-01",
                "approved",
                "Create one local preview from minimized fixture data.",
                "Approval fixture",
                at.AddMinutes(2));
            var agentEvent = ProjectWorkbenchStore.RecordAgentWorkbenchEvent(
                root,
                "Agent created src/phone-proof.txt",
                "created · src/phone-proof.txt · 5 bytes",
                "completed",
                new string('a', 64),
                at.AddMinutes(3));

            var activity = ProjectWorkbenchStore.ReadActivity(root);
            Check(activity.Select(item => item.Kind).SequenceEqual(["agent", "approval", "decision", "note"]),
                "project activity is newest-first across approvals, decisions and notes");
            Check(activity[1].Status == "approved"
                  && activity[1].Detail.Contains("approval-fixture-01", StringComparison.Ordinal),
                "approval evidence retains its id and explicit decision");
            Check(agentEvent.Source == "Helmian Agent Workbench"
                  && agentEvent.EvidenceHash?.Length == 64,
                "typed agent workbench results retain a distinct source and evidence hash");
            Check(activity.All(item => item.Source.Length > 0 && item.AtUtc.Offset == TimeSpan.Zero),
                "every activity entry names its source and uses a UTC timestamp");

            var activityPath = Path.Combine(root, ".helmion", "audit", "project-activity.jsonl");
            File.AppendAllText(activityPath, "{partial", Encoding.UTF8);
            var afterPartial = ProjectWorkbenchStore.ReadActivity(root);
            Check(afterPartial.Count == 4,
                "one partial JSONL append does not hide valid activity");

            var rejectedBlankDecision = false;
            try
            {
                ProjectWorkbenchStore.RecordDecision(root, "   ");
            }
            catch (ArgumentException)
            {
                rejectedBlankDecision = true;
            }
            Check(rejectedBlankDecision,
                "a blank project decision is refused rather than recorded as evidence");

            var rejectedUnknownApproval = false;
            try
            {
                ProjectWorkbenchStore.RecordApproval(
                    root, "approval-fixture-02", "maybe", "ambiguous", "fixture");
            }
            catch (ArgumentException)
            {
                rejectedUnknownApproval = true;
            }
            Check(rejectedUnknownApproval,
                "an ambiguous approval decision is refused");

            Check(ProjectWorkbenchStore.ReadActivity(root, limit: 2).Count == 2,
                "activity reads obey their explicit display limit");

            Console.WriteLine("Helmion project Canvas/activity checks passed (11 checks).");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void Check(bool condition, string description)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Project workbench check failed: {description}");
        }
    }
}
