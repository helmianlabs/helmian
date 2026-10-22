using System;
using System.Diagnostics;
using System.IO;
using System.Windows;
using Helmion.Desktop.Core.Herald;

namespace Helmion.Desktop;

// "Forget this pairing" (punch list A3). Two halves:
//  1. Local: delete the Herald owner enrollment (the QR fallback secret), so the next
//     "Connect phone" starts clean.
//  2. Account: the cloud registration is revoked from /app → Devices → Forget
//     (POST /api/remote/v1/desktops action=revoke). The Local Service already watches
//     for that (ObserveRegistrationAsync → desktop_denied) and wipes its credential, so
//     this PC shows "not connected" and can be paired again.
public partial class MainWindow
{
    internal const string ForgetPairingDevicesUrl = "https://helmian.cloud/app#devices";

    private void RemoteControlForgetButton_Click(object sender, RoutedEventArgs e)
    {
        var answer = MessageBox.Show(this,
            "Forget this PC's phone pairing?\n\n" +
            "• The local phone pairing on this PC is cleared now.\n" +
            "• helmian.cloud opens on Devices: tap Forget next to this PC to end Remote Control for it.\n\n" +
            "You can pair again any time with Connect phone.",
            "Forget pairing", MessageBoxButton.OKCancel, MessageBoxImage.Question);
        if (answer != MessageBoxResult.OK) return;

        var cleared = HeraldPairingReset.ClearOwnerEnrollment(HeraldOwnerSecretPath, out var error);
        ResetRemoteEnrollmentLabels();
        RemoteControlEnrollmentPanel.Visibility = Visibility.Collapsed;
        IntegrationConnectionStatusText.Text = cleared ? "Pairing cleared on this PC" : "Could not clear local pairing";
        RemoteControlDetailText.Text = cleared
            ? "Now tap Forget next to this PC on helmian.cloud → Devices. Then use Connect phone to pair again."
            : $"Local pairing file could not be removed: {error}";
        try
        {
            Process.Start(new ProcessStartInfo(ForgetPairingDevicesUrl) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            RemoteControlDetailText.Text += $" (Open {ForgetPairingDevicesUrl} yourself: {ex.Message})";
        }
    }
}
