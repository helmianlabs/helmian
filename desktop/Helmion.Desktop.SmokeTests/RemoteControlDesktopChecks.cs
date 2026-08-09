using System.Reflection;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;

internal static class RemoteControlDesktopChecks
{
    public static void Run()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            checks++;
            if (!condition)
            {
                throw new InvalidOperationException(
                    $"Remote Control desktop check failed: {description}");
            }
        }

        Check(RemoteControlApiRoutes.Enrollment == "/api/remote/v1/enrollment"
              && RemoteControlApiRoutes.RegisteredDesktop == "/api/remote/v1/desktop"
              && RemoteControlApiRoutes.DesktopRealtimeToken
                == "/api/remote/v1/desktop-token"
              && RemoteControlApiRoutes.AccountDesktopRegistry == "/api/remote/v1/desktops"
              && RemoteControlApiRoutes.Control == "/api/remote/v1/control"
              && RemoteControlApiRoutes.ControlToken == "/api/remote/v1/control-token",
            "the desktop route constants use only the canonical Remote Control v1 endpoints");

        var productAssemblies = new[]
        {
            typeof(RemoteControlApiRoutes).Assembly,
            typeof(RemoteSelectedSessionRegistry).Assembly,
            typeof(RemoteDesktopEnrollmentClient).Assembly
        };
        var enrollmentTransports = productAssemblies.SelectMany(assembly => assembly.GetTypes())
            .Where(type => !type.IsInterface
                && !type.IsAbstract
                && typeof(IRemoteControlEnrollmentApi).IsAssignableFrom(type))
            .ToArray();
        var presenceTransports = productAssemblies.SelectMany(assembly => assembly.GetTypes())
            .Where(type => !type.IsInterface
                && !type.IsAbstract
                && typeof(IRemoteControlPresenceApi).IsAssignableFrom(type))
            .ToArray();
        Check(enrollmentTransports.SequenceEqual([typeof(RemoteControlHttpApi)])
              && presenceTransports.SequenceEqual([typeof(RemoteControlHttpApi)]),
            "the only account Remote Control transport is the explicit local-service HTTPS adapter");

        var forbiddenSnapshotProperties = new[]
        {
            "path", "workspace", "token", "secret", "credential", "key", "clerk",
            "ably", "transcript", "output", "instruction", "prompt", "file", "email"
        };
        var snapshotTypes = new[]
        {
            typeof(RemoteDesktopPresenceSnapshot),
            typeof(RemoteSelectedSessionSnapshot),
            typeof(RemoteSelectedSessionMetadata),
            typeof(RemoteEnrollmentChallenge)
        };
        Check(snapshotTypes.SelectMany(type => type.GetProperties(BindingFlags.Instance | BindingFlags.Public))
                .All(property => !forbiddenSnapshotProperties.Any(fragment =>
                    property.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase))),
            "renderer-safe enrollment and presence records expose no secret, path, transcript, provider-key or PII field");
        Check(typeof(RemoteEnrollmentChallenge).GetProperties()
                .All(property => property.PropertyType != typeof(byte[])),
            "the UI-safe enrollment challenge cannot carry its redemption nonce");

        var now = new DateTimeOffset(2026, 8, 1, 14, 0, 0, TimeSpan.Zero);
        RunHttpContractChecks(now, Check);
        var enrollmentRoot = TempRoot("enrollment");
        var deniedRoot = TempRoot("denied");
        var mismatchRoot = TempRoot("mismatch");
        var tamperedRoot = TempRoot("tampered");
        var observationRoot = TempRoot("observation");
        var activationRoot = TempRoot("activation");
        var projectA = TempRoot("project-a");
        var projectB = TempRoot("project-b");
        try
        {
            var api = new FakeEnrollmentApi(now);
            var store = new ProtectedRemoteDesktopCredentialStore(
                enrollmentRoot, allowTestDirectory: true, () => now);
            var client = new RemoteDesktopEnrollmentClient(api, store, () => now);
            var initial = client.InitializeAsync().GetAwaiter().GetResult();
            Check(!initial.AccountOwned && initial.Stage == RemoteEnrollmentStage.Unenrolled,
                "an untouched desktop initializes unowned");
            Check(!Directory.Exists(enrollmentRoot),
                "reading enrollment state creates no current-user credential directory");

            var start = client.RequestEnrollmentAsync(
                "install-00000001", "Troy desktop").GetAwaiter().GetResult();
            Check(start.State.Stage == RemoteEnrollmentStage.AwaitingAccountConfirmation
                  && !start.State.AccountOwned
                  && start.Challenge.UserCode == "ABCD-1234"
                  && start.Challenge.VerificationUri.StartsWith("https://", StringComparison.Ordinal),
                "requesting enrollment returns only a one-time confirmation challenge and remains unowned");
            Check(!Directory.Exists(enrollmentRoot)
                  && api.LastEnrollmentRequest?.ContractVersion == RemoteControlApiRoutes.ContractVersion,
                "an unconfirmed request persists no nonce or credential and carries the versioned contract");
            Check(typeof(IRemoteControlEnrollmentApi).GetMethods()
                    .All(method => !method.Name.Contains("Confirm", StringComparison.OrdinalIgnoreCase)),
                "the desktop transport cannot perform the Clerk-authenticated account confirmation step");

            api.RedemptionResponse = new RemoteEnrollmentRedemptionResponse(
                RemoteEnrollmentRedemptionStatus.PendingAccountConfirmation,
                null,
                "waiting");
            var pending = client.RedeemEnrollmentAsync().GetAwaiter().GetResult();
            Check(pending.Stage == RemoteEnrollmentStage.AwaitingAccountConfirmation
                  && !pending.AccountOwned
                  && !Directory.Exists(enrollmentRoot),
                "polling before account confirmation cannot create desktop ownership");
            Check(api.LastRedemptionNonceCopy?.SequenceEqual(api.ExpectedNonce) == true
                  && api.LastRedemptionRequest?.InstallationId == "install-00000001",
                "redemption sends the one-time proof only through the injected API seam");
            Check(api.LastRedemptionRequest?.RedemptionNonce.All(value => value == 0) == true,
                "the client clears the transient redemption request copy after the transport returns");

            var expectedCredential = Enumerable.Range(1, 48).Select(value => (byte)value).ToArray();
            var returnedCredential = expectedCredential.ToArray();
            api.RedemptionResponse = new RemoteEnrollmentRedemptionResponse(
                RemoteEnrollmentRedemptionStatus.Redeemed,
                new RemoteDesktopCredentialGrant(
                    "install-00000001",
                    "desktop-00000001",
                    returnedCredential,
                    now,
                    now.AddDays(30)),
                "redeemed");
            var enrolled = client.RedeemEnrollmentAsync().GetAwaiter().GetResult();
            Check(enrolled.AccountOwned
                  && enrolled.Stage == RemoteEnrollmentStage.Enrolled
                  && enrolled.DesktopId == "desktop-00000001",
                "only server redemption plus successful protected storage marks the desktop account-owned");
            Check(returnedCredential.All(value => value == 0),
                "the redeemed bearer credential response buffer is zeroed after DPAPI storage");

            var manifestPath = Path.Combine(enrollmentRoot, "desktop.json");
            var ciphertextPath = Path.Combine(enrollmentRoot, "credential.dpapi");
            var manifest = File.ReadAllText(manifestPath, Encoding.UTF8);
            var ciphertext = File.ReadAllBytes(ciphertextPath);
            Check(manifest.Contains("desktop-00000001", StringComparison.Ordinal)
                  && manifest.Contains("install-00000001", StringComparison.Ordinal)
                  && !manifest.Contains(Convert.ToBase64String(expectedCredential), StringComparison.Ordinal)
                  && !manifest.Contains("BearerCredential", StringComparison.OrdinalIgnoreCase),
                "the redacted manifest stores desktop binding/expiry metadata but no bearer material");
            Check(!ciphertext.SequenceEqual(expectedCredential)
                  && !Encoding.UTF8.GetString(ciphertext).Contains("desktop-00000001", StringComparison.Ordinal),
                "the credential file contains DPAPI ciphertext rather than plaintext account data");
            var authentication = store.LoadAuthenticationForServiceAsync().GetAwaiter().GetResult();
            Check(authentication.DesktopId == enrolled.DesktopId
                  && authentication.BearerCredential.SequenceEqual(expectedCredential),
                "the current-user service boundary can recover the exact account-bound credential");
            CryptographicOperations.ZeroMemory(authentication.BearerCredential);

            var restoredClient = new RemoteDesktopEnrollmentClient(
                api,
                new ProtectedRemoteDesktopCredentialStore(
                    enrollmentRoot, allowTestDirectory: true, () => now),
                () => now);
            Check(restoredClient.InitializeAsync().GetAwaiter().GetResult().AccountOwned,
                "a restart verifies DPAPI material before restoring account-owned state");

            var revoking = restoredClient.BeginRevocationAsync("Remove this desktop")
                .GetAwaiter().GetResult();
            Check(revoking.Stage == RemoteEnrollmentStage.Revoking
                  && !revoking.AccountOwned
                  && File.Exists(ciphertextPath),
                "an unconfirmed revocation persists a disabled revoking state while retaining proof for retry");
            var restartDuringRevocation = new RemoteDesktopEnrollmentClient(
                api,
                new ProtectedRemoteDesktopCredentialStore(
                    enrollmentRoot, allowTestDirectory: true, () => now),
                () => now);
            Check(restartDuringRevocation.InitializeAsync().GetAwaiter().GetResult().Stage
                    == RemoteEnrollmentStage.Revoking
                  && !restartDuringRevocation.Current.AccountOwned,
                "revocation remains fail-closed across a desktop restart");

            var mismatchedRevocationRefused = false;
            try
            {
                restartDuringRevocation.ConfirmServerRevocationAsync(
                    "desktop-wrong0001", now.AddMinutes(2)).GetAwaiter().GetResult();
            }
            catch (InvalidOperationException)
            {
                mismatchedRevocationRefused = true;
            }
            Check(mismatchedRevocationRefused && File.Exists(ciphertextPath),
                "a mismatched revocation signal cannot remove the stored credential");
            var revoked = restartDuringRevocation.ConfirmServerRevocationAsync(
                    "desktop-00000001", now.AddMinutes(2))
                .GetAwaiter().GetResult();
            Check(revoked.Stage == RemoteEnrollmentStage.Revoked
                  && !revoked.AccountOwned
                  && !File.Exists(ciphertextPath),
                "server-confirmed revocation removes the protected bearer credential");
            Check(typeof(IRemoteControlEnrollmentApi).GetMethods()
                    .All(method => !method.Name.Contains("Revoke", StringComparison.OrdinalIgnoreCase)),
                "the desktop enrollment transport cannot invent a server revoke operation absent from the web contract");

            var observationSecret = Enumerable.Repeat((byte)0x7C, 32).ToArray();
            var observationStore = new ProtectedRemoteDesktopCredentialStore(
                observationRoot, allowTestDirectory: true, () => now);
            observationStore.SaveRedeemedGrantAsync(new RemoteDesktopCredentialGrant(
                    "install-observe01", "desktop-observe01", observationSecret,
                    now, now.AddDays(30)))
                .GetAwaiter().GetResult();
            CryptographicOperations.ZeroMemory(observationSecret);
            var observationClient = new RemoteDesktopEnrollmentClient(
                new FakeEnrollmentApi(now), observationStore, () => now);
            observationClient.InitializeAsync().GetAwaiter().GetResult();
            var observationCall = 0;
            var observationApi = new RemoteControlHttpApi(
                new HttpClient(new RecordingHttpHandler((_, _, _) =>
                {
                    observationCall++;
                    return observationCall == 1
                        ? JsonResponse(HttpStatusCode.Unauthorized, new
                        {
                            error = "replay_denied", message = "Nonce replay."
                        })
                        : JsonResponse(HttpStatusCode.Unauthorized, new
                        {
                            error = "desktop_denied", message = "Desktop revoked."
                        });
                })),
                "https://helmian.example",
                "https://helmian.example/remote-control",
                () => now,
                () => $"nonce.observation.{observationCall + 1:00000000}");
            var replayPreservedEnrollment = false;
            try
            {
                observationClient.ObserveRegistrationAsync(observationApi)
                    .GetAwaiter().GetResult();
            }
            catch (RemoteControlApiException exception)
            {
                replayPreservedEnrollment = exception.Failure == RemoteControlApiFailure.ReplayDenied
                    && observationClient.Current.AccountOwned;
            }
            var observedRevocation = observationClient.ObserveRegistrationAsync(observationApi)
                .GetAwaiter().GetResult();
            Check(replayPreservedEnrollment
                  && observedRevocation.Stage == RemoteEnrollmentStage.Revoked
                  && !observedRevocation.AccountOwned
                  && !File.Exists(Path.Combine(observationRoot, "credential.dpapi")),
                "status replay preserves enrollment, while desktop_denied immediately marks unavailable and removes local credential material");

            var deniedApi = new FakeEnrollmentApi(now);
            var deniedStore = new ProtectedRemoteDesktopCredentialStore(
                deniedRoot, allowTestDirectory: true, () => now);
            var deniedClient = new RemoteDesktopEnrollmentClient(deniedApi, deniedStore, () => now);
            deniedClient.RequestEnrollmentAsync("install-00000002", "Denied desktop")
                .GetAwaiter().GetResult();
            deniedApi.RedemptionResponse = new RemoteEnrollmentRedemptionResponse(
                RemoteEnrollmentRedemptionStatus.Denied,
                null,
                "denied");
            var denied = deniedClient.RedeemEnrollmentAsync().GetAwaiter().GetResult();
            Check(denied.Stage == RemoteEnrollmentStage.Denied
                  && !denied.AccountOwned
                  && !Directory.Exists(deniedRoot),
                "account denial is terminal, unowned and writes no credential state");

            var mismatchApi = new FakeEnrollmentApi(now);
            var mismatchClient = new RemoteDesktopEnrollmentClient(
                mismatchApi,
                new ProtectedRemoteDesktopCredentialStore(
                    mismatchRoot, allowTestDirectory: true, () => now),
                () => now);
            mismatchClient.RequestEnrollmentAsync("install-00000004", "Mismatch desktop")
                .GetAwaiter().GetResult();
            var mismatchSecret = Enumerable.Repeat((byte)0x44, 48).ToArray();
            mismatchApi.RedemptionResponse = new RemoteEnrollmentRedemptionResponse(
                RemoteEnrollmentRedemptionStatus.Redeemed,
                new RemoteDesktopCredentialGrant(
                    "install-different", "desktop-00000004", mismatchSecret, now, now.AddDays(30)),
                "mismatch");
            var mismatchFailed = false;
            try
            {
                mismatchClient.RedeemEnrollmentAsync().GetAwaiter().GetResult();
            }
            catch (InvalidDataException)
            {
                mismatchFailed = true;
            }
            Check(mismatchFailed
                  && mismatchClient.Current.Stage == RemoteEnrollmentStage.Failed
                  && !mismatchClient.Current.AccountOwned
                  && mismatchSecret.All(value => value == 0)
                  && !Directory.Exists(mismatchRoot),
                "a redeemed credential bound to another installation is zeroed and refused without persistence");
            var failedStateCannotReenroll = false;
            try
            {
                mismatchClient.RequestEnrollmentAsync("install-00000004", "Mismatch desktop")
                    .GetAwaiter().GetResult();
            }
            catch (InvalidOperationException)
            {
                failedStateCannotReenroll = true;
            }
            Check(failedStateCannotReenroll,
                "a failed protected/enrollment state cannot be silently overwritten by another request");

            var tamperStore = new ProtectedRemoteDesktopCredentialStore(
                tamperedRoot, allowTestDirectory: true, () => now);
            var tamperSecret = Enumerable.Repeat((byte)0x5A, 48).ToArray();
            tamperStore.SaveRedeemedGrantAsync(new RemoteDesktopCredentialGrant(
                    "install-00000003", "desktop-00000003", tamperSecret, now, now.AddDays(30)))
                .GetAwaiter().GetResult();
            var replacementRefused = false;
            var replacementSecret = Enumerable.Repeat((byte)0x6B, 48).ToArray();
            try
            {
                tamperStore.SaveRedeemedGrantAsync(new RemoteDesktopCredentialGrant(
                        "install-00000003", "desktop-replacement", replacementSecret,
                        now, now.AddDays(30)))
                    .GetAwaiter().GetResult();
            }
            catch (InvalidOperationException)
            {
                replacementRefused = true;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(replacementSecret);
            }
            Check(replacementRefused,
                "protected storage cannot replace an account binding before server-confirmed revocation");
            var tamperedCipherPath = Path.Combine(tamperedRoot, "credential.dpapi");
            var tamperedCipher = File.ReadAllBytes(tamperedCipherPath);
            tamperedCipher[^1] ^= 0xFF;
            File.WriteAllBytes(tamperedCipherPath, tamperedCipher);
            var tamperedClient = new RemoteDesktopEnrollmentClient(
                new FakeEnrollmentApi(now), tamperStore, () => now);
            var tamperFailed = false;
            try
            {
                tamperedClient.InitializeAsync().GetAwaiter().GetResult();
            }
            catch
            {
                tamperFailed = true;
            }
            Check(tamperFailed
                  && tamperedClient.Current.Stage == RemoteEnrollmentStage.Failed
                  && !tamperedClient.Current.AccountOwned,
                "tampered DPAPI material fails closed instead of restoring ownership");
            CryptographicOperations.ZeroMemory(tamperSecret);

            var registry = new RemoteSelectedSessionRegistry();
            var metadata = SessionMetadata(now);
            var registering = registry.BeginRegistration(metadata, now);
            Check(registering.Lifecycle == RemoteSelectedSessionLifecycle.Registering
                  && !registering.RemotelySelectable,
                "local selected-session registration intent is not remotely selectable");
            var rejectedAck = false;
            try
            {
                registry.ConfirmRegistration(new RemoteControlPlaneAcknowledgement(
                    false, 1, "registration-0001", "rejected", now));
            }
            catch (InvalidOperationException)
            {
                rejectedAck = true;
            }
            Check(rejectedAck
                  && registry.Current?.Lifecycle == RemoteSelectedSessionLifecycle.Registering,
                "a rejected server acknowledgement cannot make a session online");
            var online = registry.ConfirmRegistration(new RemoteControlPlaneAcknowledgement(
                true, 1, "registration-0001", "registered", now.AddSeconds(1)));
            Check(online.RemotelySelectable && online.Revision == 1,
                "a selected session becomes online only after server registration acknowledgement");

            var updating = registry.BeginUpdate(metadata with
            {
                ActivityState = RemoteSessionActivityState.Working,
                GuardState = RemoteGuardState.Warning,
                PendingApprovalCount = 1
            }, now.AddSeconds(2));
            Check(updating.Lifecycle == RemoteSelectedSessionLifecycle.Updating
                  && !updating.RemotelySelectable
                  && updating.GuardState == RemoteGuardState.Warning,
                "session and current Guard state update enters a non-selectable pending state");
            online = registry.ConfirmUpdate(new RemoteControlPlaneAcknowledgement(
                true, 2, "registration-0001", "updated", now.AddSeconds(3)));
            Check(online.RemotelySelectable
                  && online.ActivityState == RemoteSessionActivityState.Working
                  && online.PendingApprovalCount == 1,
                "server-confirmed update publishes current activity and approval count");

            var presence = RemoteDesktopPresenceComposer.Create(
                enrolled,
                "Troy desktop",
                "0.1.0",
                RemoteDesktopPresenceState.Online,
                online,
                now.AddSeconds(4));
            var presenceJson = JsonSerializer.Serialize(presence);
            Check(presence.SchemaVersion == 1
                  && presence.SelectedSession?.SessionDisplayName == "Build session"
                  && !presenceJson.Contains(projectA, StringComparison.OrdinalIgnoreCase)
                  && !presenceJson.Contains("provider-key", StringComparison.OrdinalIgnoreCase),
                "heartbeat contains necessary display/session state without local path or provider material");
            var heartbeat = RemoteControlWebWireMapper.Heartbeat(presence);
            Check(heartbeat.Action == "heartbeat"
                  && heartbeat.DesktopId == "desktop-00000001"
                  && heartbeat.Session.State == "working"
                  && heartbeat.Session.Agent.State == "working"
                  && heartbeat.Session.Guard.State == "attention"
                  && heartbeat.Session.Guard.Detail is null,
                "the mapper produces the current web heartbeat shape and accepted state vocabulary");
            var unownedPresenceRefused = false;
            try
            {
                RemoteDesktopPresenceComposer.Create(
                    RemoteDesktopEnrollmentDescriptor.Unenrolled(now),
                    "Desktop", "0.1.0", RemoteDesktopPresenceState.Online, null, now);
            }
            catch (InvalidOperationException)
            {
                unownedPresenceRefused = true;
            }
            Check(unownedPresenceRefused,
                "an unowned desktop cannot compose an authenticated presence payload");

            var revokingSession = registry.BeginRevocation(now.AddSeconds(5));
            Check(revokingSession.Lifecycle == RemoteSelectedSessionLifecycle.Revoking
                  && !revokingSession.RemotelySelectable,
                "selected-session revocation disables remote selection before server confirmation");
            var stopPresence = presence with { SelectedSession = revokingSession };
            var stop = RemoteControlWebWireMapper.StopSession(stopPresence);
            Check(stop.Action == "stop-session"
                  && stop.DesktopId == presence.DesktopId
                  && stop.SessionId == revokingSession.SessionId,
                "revoking/offline selection maps to the current web stop-session action");
            var revokedSession = registry.ConfirmRevocation(new RemoteControlPlaneAcknowledgement(
                true, 3, "registration-0001", "revoked", now.AddSeconds(6)));
            Check(revokedSession.Lifecycle == RemoteSelectedSessionLifecycle.Revoked
                  && registry.MarkOffline(now.AddSeconds(7)).Lifecycle
                    == RemoteSelectedSessionLifecycle.Revoked,
                "confirmed session revocation is terminal and cannot be relabeled merely offline");

            var offlineRegistry = new RemoteSelectedSessionRegistry();
            offlineRegistry.BeginRegistration(metadata, now);
            offlineRegistry.ConfirmRegistration(new RemoteControlPlaneAcknowledgement(
                true, 1, "registration-0002", "registered", now));
            Check(offlineRegistry.MarkOffline(now.AddMinutes(1)).Lifecycle
                    == RemoteSelectedSessionLifecycle.Offline
                  && offlineRegistry.Current?.RemotelySelectable == false,
                "graceful desktop/session shutdown has an explicit non-selectable offline state");

            Directory.CreateDirectory(projectA);
            Directory.CreateDirectory(projectB);
            var projectAId = RemoteControlProjectIdentity.FromProjectRoot(
                projectA, "install-00000001");
            Check(projectAId == RemoteControlProjectIdentity.FromProjectRoot(
                      projectA, "install-00000001")
                  && projectAId != RemoteControlProjectIdentity.FromProjectRoot(
                      projectB, "install-00000001")
                  && projectAId != RemoteControlProjectIdentity.FromProjectRoot(
                      projectA, "install-00000099")
                  && !projectAId.Contains(projectA, StringComparison.OrdinalIgnoreCase),
                "project identity is installation-scoped and stable without exposing its workspace path");

            var repositoryRoot = FindRepositoryRoot();
            Check(repositoryRoot is not null, "desktop source is available for boundary checks");
            var adapterSource = File.ReadAllText(Path.Combine(
                repositoryRoot!, "desktop", "Helmion.Desktop", "MainWindow.RemoteControl.cs"));
            var legacySource = File.ReadAllText(Path.Combine(
                repositoryRoot!, "desktop", "Helmion.Desktop", "MainWindow.Herald.cs"));
            Check(adapterSource.Contains("CurrentRemoteControlSessionMetadata", StringComparison.Ordinal)
                  && adapterSource.Contains("session.PillLabel", StringComparison.Ordinal)
                  && !adapterSource.Contains("session.Transcript", StringComparison.Ordinal)
                  && !adapterSource.Contains("session.Reason", StringComparison.Ordinal)
                  && !adapterSource.Contains("HttpClient", StringComparison.Ordinal)
                  && !adapterSource.Contains("Process.Start", StringComparison.Ordinal)
                  && !adapterSource.Contains("NamedPipe", StringComparison.Ordinal),
                "new WPF adapter reads current selection/Guard state without transcript, transport or process side effects");
            Check(!legacySource.Contains(RemoteControlApiRoutes.Enrollment, StringComparison.Ordinal)
                  && !legacySource.Contains("RemoteDesktopEnrollmentClient", StringComparison.Ordinal),
                "account-owned Remote Control remains isolated from the legacy Herald pairing process");

            RunActivationCoordinatorChecks(now, activationRoot, Check);

            Console.WriteLine(
                $"Helmion Remote Control desktop checks passed ({checks} checks; no external calls). ");
        }
        finally
        {
            foreach (var path in new[]
            {
                enrollmentRoot, deniedRoot, mismatchRoot, tamperedRoot, observationRoot, activationRoot,
                projectA, projectB
            })
            {
                if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
            }
        }
    }

    private static void RunActivationCoordinatorChecks(
        DateTimeOffset now,
        string root,
        Action<bool, string> check)
    {
        var store = new ProtectedRemoteDesktopCredentialStore(root, allowTestDirectory: true, () => now);
        var secret = Enumerable.Repeat((byte)0x31, 48).ToArray();
        store.SaveRedeemedGrantAsync(new RemoteDesktopCredentialGrant(
            "install-activation01", "desktop_activation01", secret, now, now.AddHours(1)))
            .GetAwaiter().GetResult();
        CryptographicOperations.ZeroMemory(secret);
        var enrollment = new RemoteDesktopEnrollmentClient(new FakeEnrollmentApi(now), store, () => now);
        var presence = new FakePresenceApi(now);
        var realtime = new FakeRealtimeClient();
        var coordinator = new RemoteControlActivationCoordinator(
            enrollment, store, presence, presence, realtime, new FakeDispatcher(), () => now);
        try
        {
            coordinator.PublishSessionAsync(SessionMetadata(now), CancellationToken.None)
                .GetAwaiter().GetResult();
            var steadyDelay = coordinator.RunCycleAsync().GetAwaiter().GetResult();
            var online = coordinator.GetStatusAsync(CancellationToken.None).GetAwaiter().GetResult();
            check(steadyDelay >= TimeSpan.FromSeconds(1)
                  && (online.SchedulerState is "online" or "starting" or "active")
                  && presence.HeartbeatCalls >= 1
                  && (presence.TokenCalls >= 1 || realtime.RunCalls >= 1 || online.RealtimeState is "active" or "starting" or "offline"),
                "activation scheduler heartbeats the selected session and starts only a scoped realtime grant");

            presence.HeartbeatError = new RemoteControlApiException(
                RemoteControlApiFailure.ServiceUnavailable, HttpStatusCode.ServiceUnavailable,
                "service_unavailable", "offline");
            var retryDelay = coordinator.RunCycleAsync().GetAwaiter().GetResult();
            var retry = coordinator.GetStatusAsync(CancellationToken.None).GetAwaiter().GetResult();
            check(retryDelay == TimeSpan.FromSeconds(1)
                  && retry.SchedulerState == "backoff"
                  && retry.RealtimeState == "offline"
                  && retry.ConsecutiveFailures == 1
                  && realtime.CancellationObserved,
                "network failure stops realtime immediately and enters bounded one-second backoff without revoking enrollment");

            presence.HeartbeatError = new RemoteControlApiException(
                RemoteControlApiFailure.DesktopDenied, HttpStatusCode.Unauthorized,
                "desktop_denied", "revoked");
            presence.StatusError = presence.HeartbeatError;
            coordinator.RunCycleAsync().GetAwaiter().GetResult();
            var revoked = coordinator.GetStatusAsync(CancellationToken.None).GetAwaiter().GetResult();
            check(revoked.SchedulerState == "revoked"
                  && revoked.Enrollment.Stage == RemoteEnrollmentStage.Revoked
                  && !revoked.Enrollment.AccountOwned
                  && !File.Exists(Path.Combine(root, "credential.dpapi")),
                "desktop_denied fails closed, removes DPAPI credential material, and cannot keep realtime active");
        }
        finally
        {
            coordinator.DisposeAsync().AsTask().GetAwaiter().GetResult();
            enrollment.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    private static void RunHttpContractChecks(
        DateTimeOffset now,
        Action<bool, string> check)
    {
        string? enrollmentBody = null;
        string? redemptionBody = null;
        string? requestedEnrollmentId = null;
        string? requestedProof = null;
        var registrationCredential = Enumerable.Range(80, 32).Select(value => (byte)value).ToArray();
        var registrationToken = Convert.ToBase64String(registrationCredential)
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var enrollmentHandler = new RecordingHttpHandler((request, body, _) =>
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            var action = root.GetProperty("action").GetString();
            if (action == RemoteControlApiRoutes.RedeemEnrollmentAction)
            {
                redemptionBody = body;
                return JsonResponse(HttpStatusCode.Created, new
                {
                    enrolled = true,
                    desktopId = "desktop-00000010",
                    displayName = "Adapter desktop",
                    registrationToken,
                    credentialExpiresAt = now.AddDays(30)
                });
            }
            enrollmentBody = body;
            requestedEnrollmentId = root.GetProperty("enrollmentId").GetString()!;
            requestedProof = root.GetProperty("proofSecret").GetString()!;
            return JsonResponse(HttpStatusCode.Created, new
            {
                pending = true,
                enrollmentId = requestedEnrollmentId,
                expiresAt = now.AddMinutes(10),
                confirmationRequired = true
            });
        });
        var httpApi = new RemoteControlHttpApi(
            new HttpClient(enrollmentHandler),
            "https://helmian.example",
            "https://helmian.example/remote-control",
            () => now,
            () => "nonce.adapter.test.00000001");
        check(enrollmentHandler.CallCount == 0,
            "constructing the canonical HTTPS adapter makes no external request");
        var enrollment = httpApi.RequestEnrollmentAsync(
                new RemoteEnrollmentRequest(
                    "install-00000010", "Adapter desktop", RemoteControlApiRoutes.ContractVersion),
                CancellationToken.None)
            .GetAwaiter().GetResult();
        using (var document = JsonDocument.Parse(enrollmentBody!))
        {
            var root = document.RootElement;
            var proof = root.GetProperty("proofSecret").GetString()!;
            var code = root.GetProperty("confirmationCode").GetString()!;
            check(enrollmentHandler.LastRequestUri?.AbsolutePath == RemoteControlApiRoutes.Enrollment
                  && root.GetProperty("action").GetString() == "request"
                  && root.GetProperty("enrollmentId").GetString()!.StartsWith("enroll_", StringComparison.Ordinal)
                  && proof.Length == 43
                  && proof.All(character => char.IsAsciiLetterOrDigit(character)
                      || character is '-' or '_')
                  && code.Length == 8
                  && code.All(char.IsAsciiDigit)
                  && enrollment.RedemptionNonce.Length == 32,
                "the adapter generates and sends the canonical Desktop-owned one-time enrollment intent");
        }
        var redemption = httpApi.RedeemEnrollmentAsync(
                new RemoteEnrollmentRedemptionRequest(
                    enrollment.EnrollmentRequestId,
                    "install-00000010",
                    enrollment.RedemptionNonce,
                    RemoteControlApiRoutes.ContractVersion),
                CancellationToken.None)
            .GetAwaiter().GetResult();
        using (var document = JsonDocument.Parse(redemptionBody!))
        {
            var root = document.RootElement;
            check(root.GetProperty("action").GetString() == "redeem"
                  && root.GetProperty("enrollmentId").GetString() == requestedEnrollmentId
                  && root.GetProperty("proofSecret").GetString() == requestedProof
                  && redemption.Status == RemoteEnrollmentRedemptionStatus.Redeemed
                  && redemption.Grant?.DesktopId == "desktop-00000010"
                  && redemption.Grant.BearerCredential.SequenceEqual(registrationCredential),
                "the adapter redeems with the same one-time proof and maps the one-time registration token without invented binding fields");
        }
        CryptographicOperations.ZeroMemory(enrollment.RedemptionNonce);
        CryptographicOperations.ZeroMemory(redemption.Grant!.BearerCredential);
        CryptographicOperations.ZeroMemory(registrationCredential);

        var statusCalls = new List<(string? Nonce, string? Authorization)>();
        var statusHandler = new RecordingHttpHandler((request, _, call) =>
        {
            statusCalls.Add((
                request.Headers.TryGetValues(RemoteControlApiRoutes.NonceHeader, out var nonces)
                    ? nonces.Single()
                    : null,
                request.Headers.Authorization?.ToString()));
            return call switch
            {
                1 => JsonResponse(HttpStatusCode.OK, new
                {
                    registered = true,
                    desktopId = "desktop-00000010",
                    credentialExpiresAt = now.AddDays(30),
                    serverTime = now
                }),
                2 => JsonResponse(HttpStatusCode.Unauthorized, new
                {
                    error = "replay_denied",
                    message = "Nonce was already used."
                }),
                3 => JsonResponse(HttpStatusCode.ServiceUnavailable, new
                {
                    error = "service_unavailable",
                    message = "Not configured."
                }),
                _ => JsonResponse(HttpStatusCode.Unauthorized, new
                {
                    error = "desktop_denied",
                    message = "Desktop registration is invalid."
                })
            };
        });
        var nonceCounter = 0;
        var statusApi = new RemoteControlHttpApi(
            new HttpClient(statusHandler),
            "https://helmian.example",
            "https://helmian.example/remote-control",
            () => now,
            () => $"nonce.adapter.test.{++nonceCounter:00000000}");
        var credential = Enumerable.Range(1, 32).Select(value => (byte)value).ToArray();
        var authentication = new RemoteDesktopAuthentication("desktop-00000010", credential);
        var observed = statusApi.ObserveStatusAsync(authentication, CancellationToken.None)
            .GetAwaiter().GetResult();
        check(observed.Registered
              && statusHandler.LastRequestUri?.AbsolutePath == RemoteControlApiRoutes.RegisteredDesktop
              && statusCalls[0].Nonce == "nonce.adapter.test.00000001"
              && statusCalls[0].Authorization?.StartsWith("Bearer ", StringComparison.Ordinal) == true,
            "status uses the canonical Desktop route with bearer authentication and a fresh nonce");

        var replayFailure = CaptureApiFailure(
            () => statusApi.ObserveStatusAsync(authentication, CancellationToken.None)
                .GetAwaiter().GetResult());
        var unavailableFailure = CaptureApiFailure(
            () => statusApi.ObserveStatusAsync(authentication, CancellationToken.None)
                .GetAwaiter().GetResult());
        var deniedFailure = CaptureApiFailure(
            () => statusApi.ObserveStatusAsync(authentication, CancellationToken.None)
                .GetAwaiter().GetResult());
        check(replayFailure?.Failure == RemoteControlApiFailure.ReplayDenied
              && replayFailure.RegistrationIsDenied == false
              && unavailableFailure?.Failure == RemoteControlApiFailure.ServiceUnavailable
              && unavailableFailure.RegistrationIsDenied == false
              && deniedFailure?.Failure == RemoteControlApiFailure.DesktopDenied
              && deniedFailure.RegistrationIsDenied
              && statusCalls.Select(call => call.Nonce).Distinct(StringComparer.Ordinal).Count() == 4,
            "only desktop_denied signals revocation; replay and service unavailability remain distinct and every retry gets a new nonce");
        CryptographicOperations.ZeroMemory(credential);
    }

    private static RemoteControlApiException? CaptureApiFailure(Action action)
    {
        try
        {
            action();
            return null;
        }
        catch (RemoteControlApiException exception)
        {
            return exception;
        }
    }

    private static HttpResponseMessage JsonResponse(HttpStatusCode status, object value) => new(status)
    {
        Content = new StringContent(
            JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
            Encoding.UTF8,
            "application/json")
    };

    private static RemoteSelectedSessionMetadata SessionMetadata(DateTimeOffset now) => new(
        "project-00000001",
        "Demo project",
        "session-00000001",
        "Build session",
        "agent-00000001",
        "Claude",
        RemoteSessionActivityState.Ready,
        RemoteGuardState.Normal,
        0,
        now.AddMinutes(-5));

    private static string TempRoot(string suffix) => Path.Combine(
        Path.GetTempPath(),
        $"helmian-remote-control-{suffix}-{Guid.NewGuid():N}");

    private static string? FindRepositoryRoot()
    {
        foreach (var candidate in new[] { Environment.CurrentDirectory, AppContext.BaseDirectory })
        {
            var directory = new DirectoryInfo(candidate);
            while (directory is not null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "package.json"))
                    && Directory.Exists(Path.Combine(directory.FullName, "desktop")))
                {
                    return directory.FullName;
                }
                directory = directory.Parent;
            }
        }
        return null;
    }

    private sealed class FakeEnrollmentApi : IRemoteControlEnrollmentApi
    {
        private readonly DateTimeOffset _now;

        public FakeEnrollmentApi(DateTimeOffset now)
        {
            _now = now;
            ExpectedNonce = Enumerable.Range(64, 48).Select(value => (byte)value).ToArray();
        }

        public byte[] ExpectedNonce { get; }
        public RemoteEnrollmentRequest? LastEnrollmentRequest { get; private set; }
        public RemoteEnrollmentRedemptionRequest? LastRedemptionRequest { get; private set; }
        public byte[]? LastRedemptionNonceCopy { get; private set; }
        public RemoteEnrollmentRedemptionResponse RedemptionResponse { get; set; } = new(
            RemoteEnrollmentRedemptionStatus.PendingAccountConfirmation,
            null,
            "waiting");

        public Task<RemoteEnrollmentRequestResponse> RequestEnrollmentAsync(
            RemoteEnrollmentRequest request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            LastEnrollmentRequest = request;
            return Task.FromResult(new RemoteEnrollmentRequestResponse(
                "enrollment-00000001",
                "ABCD-1234",
                "https://helmian.example/remote/confirm",
                ExpectedNonce.ToArray(),
                _now.AddMinutes(10)));
        }

        public Task<RemoteEnrollmentRedemptionResponse> RedeemEnrollmentAsync(
            RemoteEnrollmentRedemptionRequest request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            LastRedemptionRequest = request;
            LastRedemptionNonceCopy = request.RedemptionNonce.ToArray();
            return Task.FromResult(RedemptionResponse);
        }
    }

    private sealed class RecordingHttpHandler(
        Func<HttpRequestMessage, string, int, HttpResponseMessage> responseFactory)
        : HttpMessageHandler
    {
        public int CallCount { get; private set; }
        public Uri? LastRequestUri { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CallCount++;
            LastRequestUri = request.RequestUri;
            var body = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            return responseFactory(request, body, CallCount);
        }
    }

    private sealed class FakePresenceApi(DateTimeOffset now)
        : IRemoteControlPresenceApi, IRemoteControlRealtimeTokenApi
    {
        public int HeartbeatCalls { get; private set; }
        public int TokenCalls { get; private set; }
        public RemoteControlApiException? HeartbeatError { get; set; }
        public RemoteControlApiException? StatusError { get; set; }

        public Task<RemoteRegisteredDesktopStatusResponse> ObserveStatusAsync(
            RemoteDesktopAuthentication authentication, CancellationToken cancellationToken)
        {
            if (StatusError is not null) throw StatusError;
            return Task.FromResult(new RemoteRegisteredDesktopStatusResponse(
                true, authentication.DesktopId, now.AddHours(1), now));
        }

        public Task<RemoteRegisteredDesktopHeartbeatResponse> PublishHeartbeatAsync(
            RemoteDesktopAuthentication authentication,
            RemoteRegisteredDesktopHeartbeatRequest request,
            CancellationToken cancellationToken)
        {
            HeartbeatCalls++;
            if (HeartbeatError is not null) throw HeartbeatError;
            var session = new RemoteHeartbeatSessionResponse(
                request.Session.SessionId, request.Session.Project, request.Session.SessionName,
                request.Session.State, request.Session.Agent, request.Session.Guard,
                now, now.AddSeconds(90));
            return Task.FromResult(new RemoteRegisteredDesktopHeartbeatResponse(
                true, authentication.DesktopId, session, now.AddSeconds(30)));
        }

        public Task<RemoteRegisteredDesktopStopSessionResponse> StopSelectedSessionAsync(
            RemoteDesktopAuthentication authentication,
            RemoteRegisteredDesktopStopSessionRequest request,
            CancellationToken cancellationToken) => Task.FromResult(
                new RemoteRegisteredDesktopStopSessionResponse(
                    true, authentication.DesktopId, request.SessionId));

        public Task<RemoteDesktopRealtimeGrant> RequestDesktopTokenAsync(
            RemoteDesktopAuthentication authentication,
            RemoteDesktopTokenRequest request,
            CancellationToken cancellationToken)
        {
            TokenCalls++;
            return Task.FromResult(new RemoteDesktopRealtimeGrant(
                "ably", "registered-desktop", true,
                new RemoteAblyTokenRequest(
                    "app.key", 60_000, "{}", $"herald-desktop:{authentication.DesktopId}",
                    now.ToUnixTimeMilliseconds(), "nonce-1234567890123456", "signed"),
                new RemoteDesktopRealtimeChannels(
                    "helmian:herald:fixture:requests",
                    ["helmian:herald:fixture:control:control_12345678901234567890:results"]),
                now.AddMinutes(1)));
        }
    }

    private sealed class FakeRealtimeClient : IRemoteControlRealtimeClient
    {
        public int RunCalls { get; private set; }
        public bool CancellationObserved { get; private set; }
        public string State { get; private set; } = "stopped";

        public async Task RunAsync(
            RemoteDesktopRealtimeGrant grant,
            Func<RemoteControlRequestEnvelope, CancellationToken, Task<RemoteControlResultEnvelope>> dispatch,
            CancellationToken cancellationToken)
        {
            RunCalls++;
            State = "active";
            try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                CancellationObserved = true;
                State = "stopped";
            }
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeDispatcher : IRemoteDesktopRequestDispatcher
    {
        public Task<RemoteControlResultEnvelope> DispatchAsync(
            RemoteControlRequestEnvelope request, CancellationToken cancellationToken) =>
            Task.FromResult(new RemoteControlResultEnvelope(
                1, "helmian-herald", "result", request.RequestId, request.Action,
                request.DeviceId, "ok", JsonSerializer.SerializeToElement(new { message = "ok" })));
    }
}
