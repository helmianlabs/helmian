namespace Helmion.Voice.Host;

/// <summary>
/// One handle that goes green when the host should stop, whether the request
/// came from Ctrl+C, from Stop-HelmionDictation in another PowerShell session,
/// or from the user saying "stop dictation".
/// </summary>
/// <remarks>
/// The named event is reset on construction. A previous run that was killed
/// rather than stopped can leave it signalled, and inheriting that would make
/// the next host exit the instant it started — looking exactly like a broken
/// microphone.
/// </remarks>
internal sealed class ShutdownSignal : IDisposable
{
    private readonly ManualResetEvent _local = new(false);
    private readonly EventWaitHandle _named;
    private readonly RegisteredWaitHandle _registration;
    private readonly ConsoleCancelEventHandler _cancelHandler;

    public ShutdownSignal()
    {
        _named = new EventWaitHandle(
            false,
            EventResetMode.ManualReset,
            VoiceHostSignals.StopEventName,
            out _);
        _named.Reset();

        _registration = ThreadPool.RegisterWaitForSingleObject(
            _named,
            (_, _) => _local.Set(),
            state: null,
            millisecondsTimeOutInterval: Timeout.Infinite,
            executeOnlyOnce: true);

        _cancelHandler = (_, e) =>
        {
            // Handle it rather than letting the runtime tear the process down, so
            // the microphone is released and the pid file is removed.
            e.Cancel = true;
            _local.Set();
        };

        Console.CancelKeyPress += _cancelHandler;
    }

    public WaitHandle Handle => _local;

    /// <summary>Ask the host to stop from inside its own process.</summary>
    public void Request() => _local.Set();

    public void Wait() => _local.WaitOne();

    public void Dispose()
    {
        Console.CancelKeyPress -= _cancelHandler;
        _registration.Unregister(null);
        _named.Dispose();
        _local.Dispose();
    }
}

/// <summary>
/// Machine-wide lock proving only one host owns the microphone.
/// </summary>
internal sealed class SingleInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;

    private SingleInstanceGuard(Mutex mutex) => _mutex = mutex;

    /// <summary>
    /// Returns null when another host already holds the microphone, with a reason
    /// naming the process where it can be found.
    /// </summary>
    public static SingleInstanceGuard? TryAcquire(out string? reason)
    {
        var mutex = new Mutex(initiallyOwned: false, VoiceHostSignals.SingleInstanceMutexName);

        bool acquired;
        try
        {
            acquired = mutex.WaitOne(TimeSpan.Zero);
        }
        catch (AbandonedMutexException)
        {
            // The previous host was killed rather than stopped. The lock is ours.
            acquired = true;
        }

        if (!acquired)
        {
            mutex.Dispose();
            var running = VoiceHostSignals.DescribeRunningHost();
            reason = running is null
                ? "another helmion-voice host is already using the microphone. "
                  + "Run Stop-HelmionDictation first."
                : $"another helmion-voice host is already using the microphone ({running}). "
                  + "Run Stop-HelmionDictation first.";
            return null;
        }

        reason = null;
        return new SingleInstanceGuard(mutex);
    }

    public void Dispose()
    {
        try
        {
            _mutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
            // Not owned — nothing to release.
        }

        _mutex.Dispose();
    }
}
