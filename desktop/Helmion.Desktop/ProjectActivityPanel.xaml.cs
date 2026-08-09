using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

public partial class ProjectActivityPanel : UserControl
{
    private bool _ready;

    public ProjectActivityPanel()
    {
        InitializeComponent();
        ActivityFilterBox.ItemsSource = ProjectActivityFilterCatalog.All;
        ActivityFilterBox.SelectedValue = "all";
        _ready = true;
    }

    internal void RefreshFromWindow()
    {
        if (_ready && IsVisible) RefreshCurrentProject();
    }

    private void ProjectActivityPanel_IsVisibleChanged(
        object sender,
        DependencyPropertyChangedEventArgs e)
    {
        if (IsVisible) RefreshCurrentProject();
    }

    private void ActivityFilterBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_ready && IsVisible) RefreshCurrentProject();
    }

    private void ActivityApplyButton_Click(object sender, RoutedEventArgs e) =>
        RefreshCurrentProject();

    private void ActivitySearchBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        RefreshCurrentProject();
        e.Handled = true;
    }

    private void ActivityClearButton_Click(object sender, RoutedEventArgs e)
    {
        _ready = false;
        try
        {
            ActivityFilterBox.SelectedValue = "all";
            ActivitySearchBox.Clear();
        }
        finally
        {
            _ready = true;
        }
        RefreshCurrentProject();
    }

    private void RefreshCurrentProject()
    {
        var project = (Window.GetWindow(this) as MainWindow)?.ActiveProjectRootForReview;
        if (string.IsNullOrWhiteSpace(project) || !Directory.Exists(project))
        {
            ActivityProjectText.Text = "Select a project to inspect its activity.";
            ActivityStatusText.Text = "No project record was read.";
            ActivityCountText.Text = "0 RECORDED";
            ActivityItems.ItemsSource = null;
            ActivityEmptyText.Text = "No project is selected.";
            ActivityEmptyText.Visibility = Visibility.Visible;
            return;
        }

        try
        {
            var filterId = ActivityFilterBox.SelectedValue as string ?? "all";
            var snapshot = ProjectActivityCenter.Load(project, filterId, ActivitySearchBox.Text);
            ActivityProjectText.Text = $"Active project · {Path.GetFileName(snapshot.ProjectRoot)}";
            ActivityCountText.Text = snapshot.CountLabel;
            ActivityStatusText.Text =
                $"{snapshot.FilterLabel}. Reading up to 500 recent project-local rows; no polling or provider stream is active.";
            ActivityItems.ItemsSource = snapshot.Items;
            ActivityEmptyText.Text = snapshot.EmptyMessage;
            ActivityEmptyText.Visibility = snapshot.Items.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            ActivityStatusText.Text = $"Project activity could not be read: {ex.Message}";
            ActivityCountText.Text = "READ FAILED";
            ActivityItems.ItemsSource = null;
            ActivityEmptyText.Text = "The recorded activity view is unavailable.";
            ActivityEmptyText.Visibility = Visibility.Visible;
        }
    }
}
