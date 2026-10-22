namespace Helmion.Desktop.Core;

/// <summary>
/// Decides when "Start phone sharing" must use account pairing (Local Service +
/// Helmian sign-in) instead of the legacy Node relay. The legacy relay exits with
/// no QR when Node, the bin\helmion.mjs files, or the per-PC owner secret are
/// missing, which is the "no QR code any more" report on installed EXEs.
/// </summary>
public static class HeraldPairingFallback
{
    /// <summary>Exit code bin/helmion.mjs herald --remote uses when no owner enrollment exists.</summary>
    public const int MissingOwnerEnrollmentExitCode = 3;

    public static bool ShouldUseAccountPairing(string? helmionRoot, string? nodeExecutable, bool ownerSecretPresent)
        => string.IsNullOrWhiteSpace(helmionRoot)
           || string.IsNullOrWhiteSpace(nodeExecutable)
           || !ownerSecretPresent;

    public static bool IsMissingOwnerEnrollmentExit(int? exitCode)
        => exitCode == MissingOwnerEnrollmentExitCode;
}
