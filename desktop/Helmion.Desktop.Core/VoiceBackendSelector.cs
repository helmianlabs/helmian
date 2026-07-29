using System.Runtime.Versioning;

namespace Helmion.Desktop.Core;

/// <summary>
/// The single listen/speak entry point the app calls through. It decides which
/// voice backend is live, keeps exactly one of them live, and moves to the other
/// one when the preferred backend is unavailable or dies mid-call.
/// </summary>
/// <remarks>
/// <para>
/// Two backends, one boundary each, and they are not interchangeable:
/// <see cref="VoiceSession"/> is turn-based and text-mediated (Helmion's own
/// model writes the reply), while <see cref="IDuplexVoiceSession"/> is
/// speech-to-speech (the duplex model writes the reply). The selector sits above
/// both rather than forcing one behind the other's interface.
/// </para>
/// <para>
/// The invariant this class exists to hold: at most one of
/// <see cref="TurnBased"/> and <see cref="Duplex"/> is ever non-null. Both stacks
/// open the same microphone and the same render device, so a second live backend
/// is not a degraded experience, it is a broken one.
/// </para>
/// <para>
/// Moshi is the preferred backend by default and Whisper+Kokoro is the automatic
/// fallback, so that voice never fully dies: an unreachable Moshi host, a duplex
/// session that throws on start, and a duplex stream that ends unrequested all
/// land on the turn-based stack rather than on silence.
/// </para>
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class VoiceBackendSelector : IDisposable
{
    private readonly Func<VoiceSession> _turnBasedFactory;
    private readonly Func<IDuplexVoiceSession>? _duplexFactory;
    private readonly IMoshiAvailabilityProbe _probe;
    private readonly VoiceBackend _preferred;
    private readonly SemaphoreSlim _transition = new(1, 1);
    private readonly object _gate = new();

    private VoiceSession? _turnBased;
    private IDuplexVoiceSession? _duplex;
    private VoiceBackendStatus _status = VoiceBackendStatus.Off;
    private Task _pendingTransition = Task.CompletedTask;
    private bool _wantsVoice;
    private bool _disposed;

    /// <param name="turnBasedFactory">Builds the Whisper+Kokoro session. Required — it is the fallback.</param>
    /// <param name="duplexFactory">
    /// Builds the duplex session. Null when no duplex backend is installed on this
    /// machine, which is a supported configuration: the selector then runs
    /// turn-based only and says so, rather than pretending a duplex backend exists.
    /// </param>
    /// <param name="probe">Answers whether the duplex host is reachable. Null uses a live TCP probe.</param>
    /// <param name="preferred">Which backend to try first. Defaults to Moshi.</param>
    public VoiceBackendSelector(
        Func<VoiceSession> turnBasedFactory,
        Func<IDuplexVoiceSession>? duplexFactory = null,
        IMoshiAvailabilityProbe? probe = null,
        VoiceBackend preferred = VoiceBackend.Moshi)
    {
        _turnBasedFactory = turnBasedFactory ?? throw new ArgumentNullException(nameof(turnBasedFactory));
        _duplexFactory = duplexFactory;
        _preferred = preferred;
        _probe = probe
            ?? (duplexFactory is null
                ? new MoshiNotConfiguredProbe("Moshi is not installed on this machine.")
                : new MoshiAvailabilityProbe());
    }

    /// <summary>Fires on every backend or health transition, for a UI status pill.</summary>
    public event EventHandler<VoiceBackendStatus>? StatusChanged;

    /// <summary>Surfaces both backends' non-fatal faults on one channel.</summary>
    public event EventHandler<string>? Error;

    /// <summary>Current backend and health.</summary>
    public VoiceBackendStatus Status
    {
        get { lock (_gate) return _status; }
    }

    /// <summary>The single live backend, or <see cref="VoiceBackend.None"/>.</summary>
    public VoiceBackend ActiveBackend => Status.Backend;

    /// <summary>The turn-based session, non-null only while it is the live backend.</summary>
    public VoiceSession? TurnBased
    {
        get { lock (_gate) return _turnBased; }
    }

    /// <summary>The duplex session, non-null only while it is the live backend.</summary>
    public IDuplexVoiceSession? Duplex
    {
        get { lock (_gate) return _duplex; }
    }

    /// <summary>
    /// The core invariant, exposed so it can be asserted rather than assumed:
    /// the two backends are never both constructed.
    /// </summary>
    public bool HoldsSingleBackendInvariant
    {
        get
        {
            lock (_gate)
            {
                return _turnBased is null || _duplex is null;
            }
        }
    }

    /// <summary>
    /// Turn voice on. Tries the preferred backend, falls back to the turn-based
    /// stack when it is unavailable, and reports <c>None</c> with a degraded
    /// status when neither can run. Never throws — a voice failure must not take
    /// the text path down with it.
    /// </summary>
    public async Task<VoiceBackend> StartAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed)
        {
            return VoiceBackend.None;
        }

        await _transition.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _wantsVoice = true;
            await StopBackendsAsync().ConfigureAwait(false);

            string? fallbackReason = null;

            if (_preferred == VoiceBackend.Moshi)
            {
                if (_duplexFactory is null)
                {
                    fallbackReason = "Moshi is not installed on this machine.";
                }
                else
                {
                    var availability = await _probe.ProbeAsync(cancellationToken).ConfigureAwait(false);
                    if (!availability.IsAvailable)
                    {
                        fallbackReason = availability.Reason ?? "Moshi host unavailable.";
                    }
                    else if (await TryStartDuplexAsync(cancellationToken).ConfigureAwait(false) is { } duplexFailure)
                    {
                        fallbackReason = duplexFailure;
                    }
                    else
                    {
                        return VoiceBackend.Moshi;
                    }
                }
            }

            return StartTurnBased(fallbackReason);
        }
        catch (OperationCanceledException)
        {
            SetStatus(VoiceBackendStatus.Off);
            return VoiceBackend.None;
        }
        finally
        {
            _transition.Release();
        }
    }

    /// <summary>Turn voice off and release both backends. Never throws.</summary>
    public async Task StopAsync()
    {
        await _transition.WaitAsync().ConfigureAwait(false);
        try
        {
            _wantsVoice = false;
            await StopBackendsAsync().ConfigureAwait(false);
            SetStatus(VoiceBackendStatus.Off);
        }
        finally
        {
            _transition.Release();
        }
    }

    /// <summary>
    /// Wait for any in-flight automatic transition (a mid-call fallback) to
    /// settle. A mid-call death arrives on an event, so the resulting switch is
    /// asynchronous; this is how a caller — or a test — observes the settled
    /// state instead of racing it.
    /// </summary>
    public Task DrainPendingTransitionsAsync()
    {
        Task pending;
        lock (_gate)
        {
            pending = _pendingTransition;
        }

        return pending;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _wantsVoice = false;

        try
        {
            StopBackendsAsync().GetAwaiter().GetResult();
        }
        catch
        {
            // Disposal must not throw.
        }

        _transition.Dispose();
    }

    /// <summary>
    /// Returns null on success, or the reason to fall back. A duplex backend that
    /// throws on start is unusable, not half-usable, so it is torn down before we
    /// move on — leaving it constructed would break the single-backend invariant.
    /// </summary>
    private async Task<string?> TryStartDuplexAsync(CancellationToken cancellationToken)
    {
        IDuplexVoiceSession? duplex = null;
        try
        {
            duplex = _duplexFactory!();
            duplex.Ended += Duplex_Ended;
            duplex.Error += Duplex_Error;
            duplex.StateChanged += Duplex_StateChanged;

            await duplex.StartAsync(cancellationToken).ConfigureAwait(false);

            if (!duplex.IsRunning)
            {
                throw new InvalidOperationException("Moshi session did not open its stream.");
            }

            lock (_gate)
            {
                _duplex = duplex;
            }

            SetStatus(VoiceBackendStatus.MoshiActive(duplex.State));
            return null;
        }
        catch (Exception ex)
        {
            if (duplex is not null)
            {
                duplex.Ended -= Duplex_Ended;
                duplex.Error -= Duplex_Error;
                duplex.StateChanged -= Duplex_StateChanged;
                try { await duplex.StopAsync().ConfigureAwait(false); } catch { /* tearing down anyway */ }
                try { duplex.Dispose(); } catch { /* tearing down anyway */ }
            }

            lock (_gate)
            {
                _duplex = null;
            }

            return $"Moshi unavailable: {ex.Message}";
        }
    }

    private VoiceBackend StartTurnBased(string? fallbackReason)
    {
        VoiceSession? session = null;
        try
        {
            session = _turnBasedFactory();
            session.OnError += TurnBased_Error;
            session.StartVoiceMode();

            if (!session.IsVoiceModeActive)
            {
                throw new InvalidOperationException(
                    "Whisper+Kokoro could not open the microphone.");
            }

            lock (_gate)
            {
                _turnBased = session;
            }

            SetStatus(VoiceBackendStatus.WhisperKokoroActive(session.EngineState, fallbackReason));
            return VoiceBackend.WhisperKokoro;
        }
        catch (Exception ex)
        {
            if (session is not null)
            {
                session.OnError -= TurnBased_Error;
                try { session.Dispose(); } catch { /* tearing down anyway */ }
            }

            lock (_gate)
            {
                _turnBased = null;
            }

            var detail = fallbackReason is null
                ? ex.Message
                : $"{fallbackReason} Fallback also failed: {ex.Message}";

            SetStatus(VoiceBackendStatus.Degraded(detail));
            Error?.Invoke(this, $"[Voice warning] {detail}");
            return VoiceBackend.None;
        }
    }

    /// <summary>
    /// Tears both backends down. Handlers are detached before disposal so a
    /// deliberate stop cannot be mistaken for a mid-call death and trigger a
    /// fallback into the stack we are trying to shut off.
    /// </summary>
    private async Task StopBackendsAsync()
    {
        IDuplexVoiceSession? duplex;
        VoiceSession? turnBased;
        lock (_gate)
        {
            duplex = _duplex;
            turnBased = _turnBased;
            _duplex = null;
            _turnBased = null;
        }

        if (duplex is not null)
        {
            duplex.Ended -= Duplex_Ended;
            duplex.Error -= Duplex_Error;
            duplex.StateChanged -= Duplex_StateChanged;
            try { await duplex.StopAsync().ConfigureAwait(false); } catch { /* shutting down */ }
            try { duplex.Dispose(); } catch { /* shutting down */ }
        }

        if (turnBased is not null)
        {
            turnBased.OnError -= TurnBased_Error;
            try { turnBased.StopVoiceMode(); } catch { /* shutting down */ }
            try { turnBased.Dispose(); } catch { /* shutting down */ }
        }
    }

    /// <summary>
    /// The duplex stream ended. If the user still wants voice, this was a
    /// mid-call death rather than a requested stop, so move to the turn-based
    /// stack instead of leaving the user in silence.
    /// </summary>
    private void Duplex_Ended(object? sender, EventArgs e)
    {
        if (_disposed || !_wantsVoice)
        {
            return;
        }

        lock (_gate)
        {
            // Chain the recovery onto any transition already in flight so two
            // deaths in quick succession cannot start two fallbacks at once.
            _pendingTransition = _pendingTransition.ContinueWith(
                _ => FallBackToTurnBasedAsync("Moshi ended mid-call."),
                CancellationToken.None,
                TaskContinuationOptions.None,
                TaskScheduler.Default).Unwrap();
        }
    }

    private async Task FallBackToTurnBasedAsync(string reason)
    {
        if (_disposed || !_wantsVoice)
        {
            return;
        }

        await _transition.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed || !_wantsVoice)
            {
                return;
            }

            await StopBackendsAsync().ConfigureAwait(false);
            StartTurnBased(reason);
        }
        catch (Exception ex)
        {
            SetStatus(VoiceBackendStatus.Degraded($"{reason} Fallback failed: {ex.Message}"));
        }
        finally
        {
            _transition.Release();
        }
    }

    /// <summary>
    /// A duplex Error is informational and already handled at its source, so it
    /// is surfaced but does NOT trigger a fallback — switching backends on every
    /// transient fault would thrash the audio devices. Only
    /// <see cref="IDuplexVoiceSession.Ended"/> means the stream is gone.
    /// </summary>
    private void Duplex_Error(object? sender, string message) => Error?.Invoke(this, message);

    private void Duplex_StateChanged(object? sender, VoiceState state)
    {
        lock (_gate)
        {
            if (_duplex is null || _status.Backend != VoiceBackend.Moshi)
            {
                return;
            }
        }

        SetStatus(VoiceBackendStatus.MoshiActive(state));
    }

    private void TurnBased_Error(object? sender, string message) => Error?.Invoke(this, message);

    private void SetStatus(VoiceBackendStatus next)
    {
        bool changed;
        lock (_gate)
        {
            changed = _status != next;
            _status = next;
        }

        if (changed)
        {
            StatusChanged?.Invoke(this, next);
        }
    }
}
