namespace Helmion.LocalService.Protocol;

public sealed record ConnectionTargetBinding(
    string DisplayName,
    string ProjectName,
    string EndpointId,
    string ResourceName,
    string Transport,
    bool IsExactMatchRequired,
    bool IsIsolatedDevelopment);

public sealed record ConnectionTestProbe(
    string Id,
    string Purpose,
    string ExpectedEvidence,
    bool MutatesExternalState);

public sealed record ConnectionTestPlan(
    int Version,
    string ProfileId,
    string AdapterId,
    string AuthenticationClass,
    string CredentialInputBoundary,
    ConnectionTargetBinding? Target,
    IReadOnlyList<ConnectionTestProbe> Probes,
    bool MutatesExternalState,
    bool AcceptsCredentialFromRenderer);

public sealed record RedactedProviderIdentity(
    string DisplayLabel,
    string IdentityKind,
    bool Verified,
    string VerificationMethod);

public sealed record RedactedConnectionFinding(
    string Code,
    string Severity,
    string Message);

public sealed record ConnectionTestResult(
    int Version,
    string ProfileId,
    string AdapterId,
    string Status,
    RedactedProviderIdentity? Identity,
    ConnectionTargetBinding? Target,
    IReadOnlyList<string> ObservedCapabilities,
    IReadOnlyList<RedactedConnectionFinding> Findings,
    DateTimeOffset ObservedAt,
    bool MutatedExternalState,
    bool SecretMaterialReturned);

public static class NeonDevelopmentTarget
{
    public const string ProfileId = "neon-development";
    public const string ProjectDisplayName = "Helmion Development";
    public const string ProjectName = "helmion development";
    public const string EndpointId = "ep-divine-leaf-ay38p1af";
    public const string DatabaseName = "neondb";
    public const string AdapterId = "neon-postgresql-direct";

    public static ConnectionTargetBinding CreateBinding()
    {
        return new ConnectionTargetBinding(
            DisplayName: ProjectDisplayName,
            ProjectName,
            EndpointId,
            ResourceName: DatabaseName,
            Transport: "postgresql-direct",
            IsExactMatchRequired: true,
            IsIsolatedDevelopment: true);
    }

    public static ConnectionTestPlan CreateReadOnlyPlan()
    {
        return new ConnectionTestPlan(
            Version: 1,
            ProfileId,
            AdapterId,
            AuthenticationClass: "database-credential",
            CredentialInputBoundary:
                "Helmion local service protected enrollment only · never renderer, console, chat, logs, history, or arguments",
            Target: CreateBinding(),
            Probes:
            [
                new(
                    "transport-identity",
                    "Confirm the direct PostgreSQL endpoint, database, and isolated project binding",
                    "Redacted endpoint ID, database name, server identity, and exact-target decision",
                    MutatesExternalState: false),
                new(
                    "schema-readiness",
                    "Read Helmion migration and schema readiness without applying changes",
                    "Checksummed migration inventory and read-only schema state",
                    MutatesExternalState: false)
            ],
            MutatesExternalState: false,
            AcceptsCredentialFromRenderer: false);
    }
}

public static class ConnectionTestContract
{
    private static readonly HashSet<string> ValidStatuses =
        new(StringComparer.Ordinal)
        {
            "not-run",
            "passed",
            "failed",
            "target-mismatch",
            "credential-unavailable"
        };

    public static void ValidatePlan(ConnectionTestPlan plan)
    {
        if (plan.Version != 1
            || string.IsNullOrWhiteSpace(plan.ProfileId)
            || string.IsNullOrWhiteSpace(plan.AdapterId)
            || string.IsNullOrWhiteSpace(plan.AuthenticationClass)
            || string.IsNullOrWhiteSpace(plan.CredentialInputBoundary)
            || plan.Probes.Count == 0)
        {
            throw new InvalidDataException("Connection-test plan is incomplete");
        }
        if (plan.MutatesExternalState
            || plan.AcceptsCredentialFromRenderer
            || plan.Probes.Any(probe => probe.MutatesExternalState))
        {
            throw new InvalidDataException(
                "Connection tests must be non-mutating and accept no renderer credentials");
        }
        if (plan.ProfileId == NeonDevelopmentTarget.ProfileId
            && (plan.AdapterId != NeonDevelopmentTarget.AdapterId
                || plan.AuthenticationClass != "database-credential"
                || plan.Target != NeonDevelopmentTarget.CreateBinding()))
        {
            throw new InvalidDataException(
                "Neon Development connection test is not bound to the exact isolated target");
        }
    }

    public static void ValidateResult(
        ConnectionTestPlan plan,
        ConnectionTestResult result)
    {
        ValidatePlan(plan);
        if (result.Version != plan.Version
            || result.ProfileId != plan.ProfileId
            || result.AdapterId != plan.AdapterId
            || !ValidStatuses.Contains(result.Status))
        {
            throw new InvalidDataException(
                "Connection-test result does not match its plan");
        }
        if (result.MutatedExternalState || result.SecretMaterialReturned)
        {
            throw new InvalidDataException(
                "Connection-test result violates the non-mutating redacted contract");
        }
        if (result.Target != plan.Target)
        {
            throw new InvalidDataException(
                "Connection-test result target does not match its exact plan binding");
        }
    }
}
