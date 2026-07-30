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
