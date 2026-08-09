namespace Helmion.Desktop.Core;

/// <summary>
/// The fixed, phone-safe view of the selected desktop session. It intentionally
/// contains no workspace path, provider credential, tool, shell, or file model.
/// </summary>
public sealed record HeraldSessionSnapshot(
    HeraldNamedState Project,
    HeraldNamedState Session,
    HeraldNamedState? Agent,
    HeraldGuardState Guard,
    IReadOnlyList<HeraldOutput> Outputs,
    IReadOnlyList<HeraldApproval> Approvals,
    HeraldVoiceState Voice,
    DateTimeOffset CapturedAt);

public sealed record HeraldNamedState(string Id, string Name, string? State = null);
public sealed record HeraldGuardState(string State, string? Detail = null);
public sealed record HeraldOutput(string Id, string Text, DateTimeOffset? At = null);
public sealed record HeraldApproval(string Id, string Summary, string? State = null);
public sealed record HeraldVoiceState(bool Available, string? Reason = null);

public sealed record HeraldInstructionRequest(
    string Id,
    string DeviceId,
    string ProjectId,
    string SessionId,
    string Text,
    bool Confirmed,
    DateTimeOffset SubmittedAt);

public sealed record HeraldApprovalDecision(
    string Id,
    string DeviceId,
    string ProjectId,
    string SessionId,
    string ApprovalId,
    string Decision,
    bool Confirmed,
    DateTimeOffset DecidedAt);

public sealed record HeraldGatewayResult(bool Accepted, string State, string Message)
{
    public static HeraldGatewayResult Refused(string message) => new(false, "refused", message);
}

public sealed record HeraldAuditRecord(
    string Event,
    string RequestId,
    string DeviceId,
    string ProjectId,
    string SessionId,
    string Result,
    DateTimeOffset At);

/// <summary>
/// Desktop-owned policy boundary between Herald transport and Maestro.
/// Transport cannot select a project/session: every operation must still match
/// the desktop's current selection immediately before delegation.
/// </summary>
public sealed class HeraldDesktopGateway
{
    public const int MaxInstructionLength = 2_800;

    private readonly Func<HeraldSessionSnapshot?> _currentSnapshot;
    private readonly Func<HeraldInstructionRequest, CancellationToken, Task<HeraldGatewayResult>> _submitInstruction;
    private readonly Func<HeraldApprovalDecision, CancellationToken, Task<HeraldGatewayResult>> _decideApproval;
    private readonly Func<HeraldAuditRecord, CancellationToken, Task> _appendAudit;
    private readonly Func<DateTimeOffset> _clock;

    public HeraldDesktopGateway(
        Func<HeraldSessionSnapshot?> currentSnapshot,
        Func<HeraldInstructionRequest, CancellationToken, Task<HeraldGatewayResult>> submitInstruction,
        Func<HeraldApprovalDecision, CancellationToken, Task<HeraldGatewayResult>> decideApproval,
        Func<HeraldAuditRecord, CancellationToken, Task> appendAudit,
        Func<DateTimeOffset>? clock = null)
    {
        _currentSnapshot = currentSnapshot ?? throw new ArgumentNullException(nameof(currentSnapshot));
        _submitInstruction = submitInstruction ?? throw new ArgumentNullException(nameof(submitInstruction));
        _decideApproval = decideApproval ?? throw new ArgumentNullException(nameof(decideApproval));
        _appendAudit = appendAudit ?? throw new ArgumentNullException(nameof(appendAudit));
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public bool IsAvailable() => _currentSnapshot() is not null;

    public HeraldSessionSnapshot? GetSessionSnapshot() => _currentSnapshot();

    public async Task<HeraldGatewayResult> SubmitInstructionAsync(
        HeraldInstructionRequest request,
        CancellationToken cancellationToken = default)
    {
        var refusal = ValidateInstruction(request);
        if (refusal is not null) return refusal;

        var current = _currentSnapshot();
        if (current is null)
        {
            return HeraldGatewayResult.Refused(
                "Helmian Desktop is unavailable. Start a desktop session and try again.");
        }

        // Transport never gets to retarget a request. The phone must submit the
        // project/session identity it just reviewed, and that identity must still
        // match immediately before Desktop delegation. A restart or project
        // change therefore requires a fresh snapshot and confirmation.
        if (!MatchesCurrent(current, request.ProjectId, request.SessionId))
        {
            return HeraldGatewayResult.Refused(
                "The selected project or session does not match Desktop. "
                + $"Phone sent project={request.ProjectId} session={request.SessionId}; "
                + $"Desktop has project={current.Project.Id} session={current.Session.Id}. "
                + "On the phone, re-select this Desktop session, then confirm the instruction again.");
        }

        await AuditAsync("remote_instruction_requested", request.Id, request.DeviceId,
            request.ProjectId, request.SessionId, "requested", cancellationToken).ConfigureAwait(false);
        var result = await _submitInstruction(request, cancellationToken).ConfigureAwait(false);
        await AuditAsync("remote_instruction_result", request.Id, request.DeviceId,
            request.ProjectId, request.SessionId, result.State, cancellationToken).ConfigureAwait(false);
        return result;
    }

    public async Task<HeraldGatewayResult> DecideApprovalAsync(
        HeraldApprovalDecision decision,
        CancellationToken cancellationToken = default)
    {
        if (!decision.Confirmed || !ValidIdentity(decision.Id) || !ValidDevice(decision.DeviceId)
            || !ValidIdentity(decision.ProjectId) || !ValidIdentity(decision.SessionId)
            || !ValidIdentity(decision.ApprovalId)
            || decision.Decision is not ("allow-once" or "deny"))
        {
            return HeraldGatewayResult.Refused("Review and explicitly confirm Allow once or Deny.");
        }

        var current = _currentSnapshot();
        if (!MatchesCurrent(current, decision.ProjectId, decision.SessionId)
            || !current!.Approvals.Any(item => string.Equals(item.Id, decision.ApprovalId, StringComparison.Ordinal)))
        {
            return HeraldGatewayResult.Refused(
                "The approval, selected project, or selected session changed. Review again.");
        }

        await AuditAsync("remote_approval_requested", decision.Id, decision.DeviceId,
            decision.ProjectId, decision.SessionId, "requested", cancellationToken).ConfigureAwait(false);
        var result = await _decideApproval(decision, cancellationToken).ConfigureAwait(false);
        await AuditAsync("remote_approval_result", decision.Id, decision.DeviceId,
            decision.ProjectId, decision.SessionId, result.State, cancellationToken).ConfigureAwait(false);
        return result;
    }

    private static HeraldGatewayResult? ValidateInstruction(HeraldInstructionRequest request)
    {
        if (!request.Confirmed || !ValidIdentity(request.Id) || !ValidDevice(request.DeviceId)
            || !ValidIdentity(request.ProjectId) || !ValidIdentity(request.SessionId)
            || string.IsNullOrWhiteSpace(request.Text) || request.Text.Length > MaxInstructionLength)
        {
            return HeraldGatewayResult.Refused(
                $"Review and explicitly confirm a 1–{MaxInstructionLength} character instruction.");
        }
        return null;
    }

    private static bool MatchesCurrent(HeraldSessionSnapshot? current, string projectId, string sessionId) =>
        current is not null
        && string.Equals(current.Project.Id, projectId, StringComparison.Ordinal)
        && string.Equals(current.Session.Id, sessionId, StringComparison.Ordinal);

    private static bool ValidIdentity(string? value) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= 128
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or ':' or '-');

    private static bool ValidDevice(string? value) => ValidIdentity(value) && value!.Length >= 8;

    private Task AuditAsync(string eventName, string requestId, string deviceId,
        string projectId, string sessionId, string result, CancellationToken cancellationToken) =>
        _appendAudit(new HeraldAuditRecord(eventName, requestId, deviceId, projectId,
            sessionId, result, _clock()), cancellationToken);
}
