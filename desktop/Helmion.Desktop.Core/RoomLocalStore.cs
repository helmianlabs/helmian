using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Free, offline message log for Helmian Room demos.
/// No Neon. No paid server. Lives under LocalApplicationData.
/// Discord/GitHub bridges can write into the same shape later.
/// </summary>
public sealed class RoomLocalStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly string _path;
    private readonly object _gate = new();

    public RoomLocalStore(string? rootDirectory = null)
    {
        var root = rootDirectory
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Helmion",
                "room");
        Directory.CreateDirectory(root);
        _path = Path.Combine(root, "messages.jsonl");
    }

    public string StorePath => _path;

    public void Append(RoomLocalMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);
        var line = JsonSerializer.Serialize(message, JsonOptions);
        lock (_gate)
        {
            File.AppendAllText(_path, line + Environment.NewLine);
        }
    }

    public IReadOnlyList<RoomLocalMessage> ReadRecent(string roomId, int take = 80)
    {
        if (string.IsNullOrWhiteSpace(roomId) || take < 1) return [];
        if (!File.Exists(_path)) return [];

        List<RoomLocalMessage> matched;
        lock (_gate)
        {
            matched = File.ReadLines(_path)
                .Select(TryParse)
                .Where(item => item is not null && item.RoomId == roomId)
                .Cast<RoomLocalMessage>()
                .ToList();
        }

        if (matched.Count <= take) return matched;
        return matched.Skip(matched.Count - take).ToArray();
    }

    public void SeedDemoIfEmpty(string roomId = "demo")
    {
        if (File.Exists(_path) && new FileInfo(_path).Length > 0) return;
        Append(new RoomLocalMessage(
            roomId,
            Guid.NewGuid().ToString("N"),
            "system",
            "Helmian",
            "Local room store is live. No cloud bill. Connect Discord or GitHub to pull real sources into this desk.",
            DateTimeOffset.UtcNow));
    }

    private static RoomLocalMessage? TryParse(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;
        try
        {
            return JsonSerializer.Deserialize<RoomLocalMessage>(line, JsonOptions);
        }
        catch
        {
            return null;
        }
    }
}

public sealed record RoomLocalMessage(
    string RoomId,
    string MessageId,
    string AuthorId,
    string AuthorLabel,
    string Body,
    DateTimeOffset SentAtUtc);
