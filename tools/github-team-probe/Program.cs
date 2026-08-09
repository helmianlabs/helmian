using System;
using System.Linq;
using System.Threading.Tasks;
using Helmion.LocalService.Protocol;
class Program {
  static async Task Main() {
    var pack = @"E:\Helmion\artifacts\Helmion-Pilot-win-x64-self-contained-team-20260802\Helmion Local Service.exe";
    await using var client = await ReadOnlyPipeClient.ConnectAsync(pack, TimeSpan.FromSeconds(20));
    foreach (var repo in new[] { "troy83352/helmion", "troy83352/aimforge", "troy83352/dairyforge" }) {
      var conv = await client.ReadTeamConversationAsync("github", repo);
      Console.WriteLine(repo + " channels=" + conv.Channels.Count + " " + conv.Detail);
      foreach (var c in conv.Channels.Take(3)) Console.WriteLine("  " + c.DisplayLabel);
      if (conv.Channels.Count > 0) {
        var ch = conv.Channels[0];
        var msgs = await client.ReadTeamConversationAsync("github", repo, ch.Id);
        Console.WriteLine("  comments=" + msgs.Messages.Count + " " + msgs.Detail);
        break;
      }
    }
  }
}
