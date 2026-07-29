using System.Net;
using System.Net.Sockets;
using Helmion.Desktop.Core;

/// <summary>
/// Checks for the backend selector that decides which voice stack is live.
/// </summary>
/// <remarks>
/// None of these need Moshi installed, and that is the point: the selector's
/// whole job is to behave correctly when the preferred backend is missing, so
/// the machine without it is the primary test case rather than a skipped one.
///
/// The duplex backend is faked here, but nothing about the selector is: the
/// turn-based side runs a real <see cref="VoiceSession"/> over a fake engine,
/// and the availability probe is exercised as the real
/// <see cref="MoshiAvailabilityProbe"/> against real sockets in both directions.
/// </remarks>
internal static class VoiceBackendSmokeChecks
{
    private static int _checks;

    public static void Run()
    {
        _checks = 0;

        CheckFallsBackWhenMoshiUnreachable();
        CheckFallsBackWhenNoMoshiInstalled();
        CheckRunsMoshiWhenAvailable();
        CheckNeverTwoBackendsAtOnce();
        CheckFallsBackWhenDuplexThrowsOnStart();
        CheckFallsBackOnMidCallDeath();
        CheckDeliberateStopDoesNotFallBack();
        CheckErrorAloneDoesNotSwitchBackends();
        CheckDegradedWhenBothBackendsFail();
        CheckPreferringTurnBasedSkipsTheProbe();
        CheckStatusTransitionSequence();
        CheckDuplexThatDiesWhileGoingLive();
        CheckConcurrentStartStopKeepsInvariant();
        CheckRealProbeBothDirections();

        Console.WriteLine($"Helmion voice backend selector smoke tests passed ({_checks} checks).");
    }

    private static void CheckFallsBackWhenMoshiUnreachable()
    {
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => new FakeDuplex(),
            new StubProbe(MoshiAvailability.Unavailable("No Moshi host at 127.0.0.1:8998.")));

        var chosen = selector.StartAsync().GetAwaiter().GetResult();

        Check(chosen == VoiceBackend.WhisperKokoro, "an unreachable Moshi host selects Whisper+Kokoro");
        Check(selector.Status.Backend == VoiceBackend.WhisperKokoro, "status reports the turn-based backend");
        Check(selector.Status.IsFallback, "status marks this as a fallback, not a preference");
        Check(selector.Status.Detail?.Contains("8998", StringComparison.Ordinal) == true,
            "the fallback carries the probe's real reason, not a generic message");
        Check(selector.Duplex is null, "no duplex session is left constructed after a failed probe");
        Check(selector.TurnBased is not null, "the turn-based session is live");
    }

    private static void CheckFallsBackWhenNoMoshiInstalled()
    {
        // duplexFactory: null is the shape of this machine — Moshi is not installed.
        using var selector = new VoiceBackendSelector(() => new VoiceSession(new FakeEngine()));

        var chosen = selector.StartAsync().GetAwaiter().GetResult();

        Check(chosen == VoiceBackend.WhisperKokoro, "with no Moshi backend installed, voice still starts");
        Check(selector.Status.IsFallback, "running without Moshi is reported as a fallback");
        Check(selector.Status.Detail?.Contains("not installed", StringComparison.OrdinalIgnoreCase) == true,
            "the reason says Moshi is not installed rather than inventing a failure");
    }

    private static void CheckRunsMoshiWhenAvailable()
    {
        var duplex = new FakeDuplex();
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));

        var chosen = selector.StartAsync().GetAwaiter().GetResult();

        Check(chosen == VoiceBackend.Moshi, "an available Moshi host is preferred by default");
        Check(selector.Status.Display.StartsWith("Moshi active", StringComparison.Ordinal),
            "the UI label reads \"Moshi active\"");
        Check(!selector.Status.IsFallback, "the preferred backend is not marked as a fallback");
        Check(duplex.IsRunning, "the duplex stream was actually started");
        Check(selector.TurnBased is null, "the turn-based session is NOT constructed while Moshi is live");
    }

    private static void CheckNeverTwoBackendsAtOnce()
    {
        var duplex = new FakeDuplex();
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));

        Check(selector.HoldsSingleBackendInvariant, "invariant holds before start");

        selector.StartAsync().GetAwaiter().GetResult();
        Check(selector.HoldsSingleBackendInvariant, "invariant holds with Moshi live");
        Check(selector.TurnBased is null && selector.Duplex is not null,
            "exactly one backend object exists with Moshi live");

        // Kill it and let the fallback land, then re-check.
        duplex.KillMidCall();
        selector.DrainPendingTransitionsAsync().GetAwaiter().GetResult();
        Check(selector.HoldsSingleBackendInvariant, "invariant holds across a fallback");
        Check(selector.TurnBased is not null && selector.Duplex is null,
            "exactly one backend object exists after the fallback");

        selector.StopAsync().GetAwaiter().GetResult();
        Check(selector.TurnBased is null && selector.Duplex is null, "stopping leaves no backend live");
        Check(selector.ActiveBackend == VoiceBackend.None, "stopped reports no active backend");
    }

    private static void CheckFallsBackWhenDuplexThrowsOnStart()
    {
        var duplex = new FakeDuplex { ThrowOnStart = "moshi-server refused the connection" };
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));

        var chosen = selector.StartAsync().GetAwaiter().GetResult();

        Check(chosen == VoiceBackend.WhisperKokoro,
            "a probe that passes but a session that throws still falls back");
        Check(duplex.WasDisposed, "the failed duplex session is disposed, not left dangling");
        Check(selector.Duplex is null, "a duplex session that failed to start is not exposed as live");
        Check(selector.Status.Detail?.Contains("refused", StringComparison.Ordinal) == true,
            "the real start failure reaches the status detail");
    }

    private static void CheckFallsBackOnMidCallDeath()
    {
        var duplex = new FakeDuplex();
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));

        Check(selector.StartAsync().GetAwaiter().GetResult() == VoiceBackend.Moshi,
            "Moshi is live before the simulated death");

        duplex.KillMidCall();
        selector.DrainPendingTransitionsAsync().GetAwaiter().GetResult();

        Check(selector.ActiveBackend == VoiceBackend.WhisperKokoro,
            "a mid-call Moshi death moves voice to Whisper+Kokoro");
        Check(selector.Status.IsFallback, "the recovered state is marked as a fallback");
        Check(selector.Status.Detail?.Contains("mid-call", StringComparison.OrdinalIgnoreCase) == true,
            "the status says the stream died mid-call");
        Check(selector.TurnBased is not null && selector.TurnBased!.IsVoiceModeActive,
            "the fallback microphone is actually listening, not merely selected");
    }

    private static void CheckDeliberateStopDoesNotFallBack()
    {
        // A requested stop also raises Ended. If the selector could not tell the
        // two apart it would "recover" into the stack the user just switched off.
        var duplex = new FakeDuplex();
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));

        selector.StartAsync().GetAwaiter().GetResult();
        selector.StopAsync().GetAwaiter().GetResult();
        selector.DrainPendingTransitionsAsync().GetAwaiter().GetResult();

        Check(selector.ActiveBackend == VoiceBackend.None,
            "a deliberate stop does not resurrect voice through the fallback path");
        Check(selector.Status.Display == "Voice off", "a deliberate stop reads as voice off");
        Check(selector.TurnBased is null, "no turn-based session is started by a deliberate stop");
    }

    private static void CheckErrorAloneDoesNotSwitchBackends()
    {
        var duplex = new FakeDuplex();
        var errors = new List<string>();
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));
        selector.Error += (_, message) => errors.Add(message);

        selector.StartAsync().GetAwaiter().GetResult();
        duplex.RaiseError("transient packet loss");
        selector.DrainPendingTransitionsAsync().GetAwaiter().GetResult();

        Check(selector.ActiveBackend == VoiceBackend.Moshi,
            "an informational error does not thrash the audio devices by switching backends");
        Check(errors.Contains("transient packet loss"),
            "the error is still surfaced to the console rather than swallowed");
    }

    private static void CheckDegradedWhenBothBackendsFail()
    {
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine { FailToStart = true }),
            () => new FakeDuplex { ThrowOnStart = "no moshi-server" },
            new StubProbe(MoshiAvailability.Available));

        var chosen = selector.StartAsync().GetAwaiter().GetResult();

        Check(chosen == VoiceBackend.None, "with both backends dead, no backend is reported live");
        Check(selector.Status.Display.StartsWith("Voice degraded", StringComparison.Ordinal),
            "the UI label reads \"Voice degraded\"");
        Check(selector.Status.State == VoiceState.Degraded, "health is Degraded, not Idle");
        Check(selector.Status.Detail?.Contains("no moshi-server", StringComparison.Ordinal) == true
            && selector.Status.Detail?.Contains("Fallback also failed", StringComparison.Ordinal) == true,
            "the degraded detail names BOTH failures, not just the last one");
        Check(selector.TurnBased is null && selector.Duplex is null,
            "a total failure leaves nothing constructed");
    }

    private static void CheckPreferringTurnBasedSkipsTheProbe()
    {
        var probe = new StubProbe(MoshiAvailability.Available);
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => new FakeDuplex(),
            probe,
            VoiceBackend.WhisperKokoro);

        var chosen = selector.StartAsync().GetAwaiter().GetResult();

        Check(chosen == VoiceBackend.WhisperKokoro, "an explicit turn-based preference is honoured");
        Check(probe.CallCount == 0, "preferring the turn-based stack does not pay for a Moshi probe");
        Check(!selector.Status.IsFallback,
            "a deliberately chosen turn-based stack is not mislabelled as a fallback");
    }

    private static void CheckStatusTransitionSequence()
    {
        var duplex = new FakeDuplex();
        var seen = new List<string>();
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));
        selector.StatusChanged += (_, status) => seen.Add(status.Display);

        selector.StartAsync().GetAwaiter().GetResult();
        duplex.KillMidCall();
        selector.DrainPendingTransitionsAsync().GetAwaiter().GetResult();
        selector.StopAsync().GetAwaiter().GetResult();

        Check(seen.Count == 3, $"three transitions are published, saw {seen.Count}: {string.Join(" -> ", seen)}");
        Check(seen[0].StartsWith("Moshi active", StringComparison.Ordinal), "first transition is Moshi active");
        Check(seen[1].StartsWith("Whisper+Kokoro active", StringComparison.Ordinal),
            "second transition is the Whisper+Kokoro fallback");
        Check(seen[2] == "Voice off", "final transition is voice off");
    }

    /// <summary>
    /// A Moshi host that accepts the connection and then drops the stream while
    /// the session is still being published. This is realistic — moshi-server
    /// accepting TCP proves nothing about the WebSocket surviving — and it is the
    /// window where a session could previously be published already dead, leaving
    /// the user in silence with a status pill that read "Moshi active".
    /// </summary>
    private static void CheckDuplexThatDiesWhileGoingLive()
    {
        var duplex = new FakeDuplex { DieAfterStart = true };
        using var selector = new VoiceBackendSelector(
            () => new VoiceSession(new FakeEngine()),
            () => duplex,
            new StubProbe(MoshiAvailability.Available));

        var chosen = selector.StartAsync().GetAwaiter().GetResult();
        selector.DrainPendingTransitionsAsync().GetAwaiter().GetResult();

        Check(chosen == VoiceBackend.WhisperKokoro,
            "a duplex stream that dies while going live falls back instead of publishing a dead backend");
        Check(selector.Duplex is null, "the dead duplex session is not left live");
        Check(selector.HoldsSingleBackendInvariant, "the invariant survives a death during startup");
        Check(selector.ActiveBackend == VoiceBackend.WhisperKokoro, "voice is actually running after the fallback");
    }

    /// <summary>
    /// Hammers start / kill / stop concurrently and asserts the single-backend
    /// invariant after every settle.
    /// </summary>
    /// <remarks>
    /// This exists because the invariant failed intermittently under load while
    /// passing in isolation: every individual assignment was correct and the
    /// interleaving still admitted a both-set window. A test that only runs the
    /// happy path in a quiet process cannot see that, so this one runs the
    /// transitions repeatedly and checks the pair atomically.
    /// </remarks>
    private static void CheckConcurrentStartStopKeepsInvariant()
    {
        for (var i = 0; i < 200; i++)
        {
            var duplex = new FakeDuplex();
            using var selector = new VoiceBackendSelector(
                () => new VoiceSession(new FakeEngine()),
                () => duplex,
                new StubProbe(MoshiAvailability.Available));

            var start = selector.StartAsync();

            // Race the death against the start rather than sequencing it.
            var killer = Task.Run(() => duplex.KillMidCall());

            start.GetAwaiter().GetResult();
            killer.GetAwaiter().GetResult();
            selector.DrainPendingTransitionsAsync().GetAwaiter().GetResult();

            if (!selector.HoldsSingleBackendInvariant)
            {
                Check(false, $"invariant holds when a death races the start (iteration {i})");
            }

            selector.StopAsync().GetAwaiter().GetResult();

            if (selector.TurnBased is not null || selector.Duplex is not null)
            {
                Check(false, $"stopping leaves nothing live even under a race (iteration {i})");
            }
        }

        _checks++;
        Console.WriteLine("  200 start/death/stop races held the single-backend invariant.");
    }

    /// <summary>
    /// Exercises the real probe against real sockets in both directions. A probe
    /// that only ever answers "unavailable" would pass every fallback test above
    /// while being useless, so the positive case has to be proven too.
    /// </summary>
    private static void CheckRealProbeBothDirections()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        try
        {
            var probe = new MoshiAvailabilityProbe("127.0.0.1", port, TimeSpan.FromSeconds(2));
            var live = probe.ProbeAsync().GetAwaiter().GetResult();
            Check(live.IsAvailable, $"the real probe finds a listener on 127.0.0.1:{port}");
            Check(live.Reason is null, "an available host reports no failure reason");
        }
        finally
        {
            listener.Stop();
        }

        // Same port, now closed: the probe must flip to unavailable.
        var deadProbe = new MoshiAvailabilityProbe("127.0.0.1", port, TimeSpan.FromSeconds(2));
        var dead = deadProbe.ProbeAsync().GetAwaiter().GetResult();
        Check(!dead.IsAvailable, $"the real probe reports 127.0.0.1:{port} unavailable once the listener stops");
        Check(dead.Reason?.Contains(port.ToString(), StringComparison.Ordinal) == true,
            "the unavailable reason names the endpoint it actually tried");
    }

    private static void Check(bool condition, string description)
    {
        if (!condition)
        {
            Console.Error.WriteLine($"VOICE BACKEND SMOKE FAILED: {description}");
            Environment.Exit(1);
        }

        _checks++;
    }

    private sealed class StubProbe : IMoshiAvailabilityProbe
    {
        private readonly MoshiAvailability _answer;

        public StubProbe(MoshiAvailability answer) => _answer = answer;

        public int CallCount { get; private set; }

        public Task<MoshiAvailability> ProbeAsync(CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(_answer);
        }
    }

    /// <summary>
    /// A controllable duplex backend. This is NOT a Moshi client and does not
    /// pretend to be one — it produces no audio and contacts nothing. It exists
    /// to drive the selector's start / death / stop paths.
    /// </summary>
    private sealed class FakeDuplex : IDuplexVoiceSession
    {
        public event EventHandler<DuplexTranscript>? TranscriptReceived;
        public event EventHandler? Interrupted;
        public event EventHandler<string>? Error;
        public event EventHandler<VoiceState>? StateChanged;
        public event EventHandler? Ended;

        public string? ThrowOnStart { get; init; }

        /// <summary>Report a started stream, then drop it immediately.</summary>
        public bool DieAfterStart { get; init; }

        public VoiceState State { get; private set; } = VoiceState.Idle;

        public bool IsRunning { get; private set; }

        public bool WasDisposed { get; private set; }

        public Task StartAsync(CancellationToken cancellationToken = default)
        {
            if (ThrowOnStart is not null)
            {
                throw new InvalidOperationException(ThrowOnStart);
            }

            IsRunning = true;
            State = VoiceState.Listening;
            StateChanged?.Invoke(this, State);

            if (DieAfterStart)
            {
                // IsRunning goes false after the selector's post-start check, in
                // the window before the session is published.
                KillMidCall();
            }

            return Task.CompletedTask;
        }

        public Task StopAsync()
        {
            IsRunning = false;
            State = VoiceState.Idle;
            return Task.CompletedTask;
        }

        /// <summary>The stream drops without anyone asking it to.</summary>
        public void KillMidCall()
        {
            IsRunning = false;
            State = VoiceState.Degraded;
            Ended?.Invoke(this, EventArgs.Empty);
        }

        public void RaiseError(string message) => Error?.Invoke(this, message);

        public void RaiseTranscript(DuplexSpeaker speaker, string text) =>
            TranscriptReceived?.Invoke(this, new DuplexTranscript(speaker, text));

        public void RaiseInterrupted() => Interrupted?.Invoke(this, EventArgs.Empty);

        public void Dispose()
        {
            WasDisposed = true;
            IsRunning = false;
        }
    }

    /// <summary>
    /// Minimal ISpeechEngine so a real <see cref="VoiceSession"/> can run with no
    /// microphone and no speaker. <see cref="FailToStart"/> reproduces a machine
    /// where the capture device cannot be opened.
    /// </summary>
    private sealed class FakeEngine : ISpeechEngine
    {
        public event EventHandler<string>? SpeechRecognized;
        public event EventHandler? SpeechDetected;
        public event EventHandler<string>? Error;
        public event EventHandler? DictationStopped;
        public event EventHandler<VoiceState>? StateChanged;

        public bool FailToStart { get; init; }

        public VoiceState State { get; private set; } = VoiceState.Idle;

        public bool IsDictationRunning { get; private set; }

        public bool IsSpeaking { get; private set; }

        public void StartDictation()
        {
            if (FailToStart)
            {
                State = VoiceState.Degraded;
                StateChanged?.Invoke(this, State);
                Error?.Invoke(this, "[Voice warning] fake engine has no capture device");
                return;
            }

            IsDictationRunning = true;
            State = VoiceState.Listening;
            StateChanged?.Invoke(this, State);
        }

        public void StopDictation()
        {
            IsDictationRunning = false;
            State = VoiceState.Idle;
        }

        public void PauseDictation() => IsDictationRunning = false;

        public void Speak(string text, CancellationToken cancellationToken = default)
        {
            IsSpeaking = true;
            IsSpeaking = false;
        }

        public void CancelSpeak() => IsSpeaking = false;

        public AudioEndpointStatus ProbeAudioEndpoints() =>
            FailToStart
                ? new AudioEndpointStatus(false, 0, 0, null, false, "fake engine has no output device")
                : new AudioEndpointStatus(true, 1, 1, "fake", true, null);

        public void RaiseSpeechRecognized(string text) => SpeechRecognized?.Invoke(this, text);

        public void RaiseSpeechDetected() => SpeechDetected?.Invoke(this, EventArgs.Empty);

        public void RaiseStopped() => DictationStopped?.Invoke(this, EventArgs.Empty);

        public void Dispose()
        {
            IsDictationRunning = false;
            IsSpeaking = false;
        }
    }
}
