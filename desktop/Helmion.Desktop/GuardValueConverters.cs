using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace Helmion.Desktop;

/// <summary>
/// True → Visible, false → Collapsed.
///
/// Deliberately NOT WPF's built-in BooleanToVisibilityConverter behaviour for a
/// non-boolean input: anything that is not a real <see cref="bool"/> collapses,
/// because a guard panel must not reveal a block of UI on the strength of a
/// binding it could not evaluate.
/// </summary>
public sealed class GuardTrueToVisibleConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true ? Visibility.Visible : Visibility.Collapsed;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException("GuardTrueToVisibleConverter is one-way.");
}

/// <summary>
/// A count greater than zero → Visible, otherwise Collapsed. Used by the tab strip
/// so a zero count is absent rather than rendered as a reassuring "0".
/// </summary>
public sealed class GuardNonZeroToVisibleConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is int count && count > 0 ? Visibility.Visible : Visibility.Collapsed;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException("GuardNonZeroToVisibleConverter is one-way.");
}

/// <summary>
/// Boolean negation. A non-boolean returns false, so a failed binding leaves an
/// Acknowledge button DISABLED rather than enabling an action nobody asked for.
/// </summary>
public sealed class GuardInvertBooleanConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is bool flag && !flag;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException("GuardInvertBooleanConverter is one-way.");
}

/// <summary>
/// A + menu row's state key → the colour that state is drawn in.
///
/// The row already says its state IN WORDS ("Connecting…", "Added", "Failed",
/// "Removed") — this is the redundant second channel, never the only one. Same
/// discipline as the guard panel, where a red card sitting over healthy text
/// taught nobody anything.
///
/// An unrecognised key is grey, not green. A state this converter cannot read is
/// not a success.
/// </summary>
public sealed class PlusStateBrushConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        (value as string) switch
        {
            "Busy" => new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(0x7F, 0xE3, 0xFF)),   // cyan — working
            "Ok" => new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(0x4C, 0xC3, 0x8A)),   // green — added
            "Failed" => new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(0xE0, 0x6C, 0x60)),   // red — failed
            "Removed" => new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(0x7A, 0x82, 0x90)),   // grey — removed
            _ => new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(0x7A, 0x82, 0x90)),
        };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
