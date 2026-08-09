using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Helmion.Desktop.Core;

internal static class BrowserReferenceChecks
{
    public static async Task RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            checks++;
            if (!condition)
            {
                throw new InvalidOperationException(
                    $"Browser reference check failed: {description}");
            }
        }

        foreach (var refused in new[]
                 {
                     "",
                     "not a url",
                     "http://example.com",
                     "file:///C:/Windows/win.ini",
                     "https://user:password@example.com",
                     "https://localhost/reference",
                     "https://127.0.0.1/reference",
                     "https://10.0.0.4/reference",
                     "https://[::1]/reference"
                 })
        {
            Check(!BrowserReferenceReader.ValidateAddress(refused).Allowed,
                $"{refused} is refused before any request");
        }

        Check(BrowserReferenceReader.ValidateAddress("https://example.com/reference").Allowed,
            "a public HTTPS address passes the syntax gate");
        Check(!BrowserReferenceReader.ValidateAddress(
                "https://example.com/" + new string('x', BrowserReferenceReader.MaxAddressCharacters)).Allowed,
            "an oversized address is refused before parsing or networking");
        Check(!BrowserReferenceReader.IsPublicAddress(IPAddress.Parse("192.168.1.5")),
            "private IPv4 is not a Browser destination");
        Check(!BrowserReferenceReader.IsPublicAddress(IPAddress.Parse("fc00::1")),
            "unique-local IPv6 is not a Browser destination");
        Check(BrowserReferenceReader.IsPublicAddress(IPAddress.Parse("8.8.8.8")),
            "a public IPv4 address remains usable");
        Check(BrowserReferenceReader.IsPublicAddress(IPAddress.Parse("2606:4700:4700::1111")),
            "a public IPv6 address remains usable");

        var html = """
                   <!doctype html>
                   <html>
                     <head>
                       <title>Example &amp; Reference</title>
                       <style>.hidden { display:none }</style>
                       <script>window.secret = "must not render";</script>
                     </head>
                     <body>
                       <h1>Hello</h1>
                       <p>Useful <strong>project</strong> reference.</p>
                       <noscript>not executable context</noscript>
                       <svg><text>vector payload</text></svg>
                     </body>
                   </html>
                   """;
        using var htmlHandler = new FakeBrowserHandler(
            _ => TextResponse(HttpStatusCode.OK, html, "text/html"));
        using var htmlReader = new BrowserReferenceReader(htmlHandler, ResolvePublicAsync);
        var page = await htmlReader.ReadAsync("https://example.com/reference?private=query#section");
        Check(page.Title == "Example & Reference", "the HTML title is decoded");
        Check(page.Text.Contains("Hello", StringComparison.Ordinal)
              && page.Text.Contains("Useful project reference.", StringComparison.Ordinal),
            "readable HTML content becomes plain text");
        Check(!page.Text.Contains("must not render", StringComparison.Ordinal)
              && !page.Text.Contains("display:none", StringComparison.Ordinal)
              && !page.Text.Contains("vector payload", StringComparison.Ordinal),
            "script, style and SVG blocks never reach the displayed text");
        Check(page.DisplayAddress == "https://example.com/reference",
            "stored/displayed evidence omits query and fragment data");
        Check(page.EvidenceHash.Length == 64,
            "a successful read carries a SHA-256 content identity");
        Check(htmlHandler.Requests.Count == 1
              && htmlHandler.Requests[0].Headers.UserAgent.Any()
              && htmlHandler.Requests[0].Headers.Authorization is null,
            "the read sends a named user agent and no authorization header");

        var longTitleHandler = new FakeBrowserHandler(_ => TextResponse(
            HttpStatusCode.OK,
            $"<html><title>{new string('t', BrowserReferenceReader.MaxTitleCharacters + 40)}</title><body>ok</body></html>",
            "text/html"));
        using (longTitleHandler)
        using (var longTitleReader = new BrowserReferenceReader(longTitleHandler, ResolvePublicAsync))
        {
            var longTitlePage = await longTitleReader.ReadAsync("https://example.com/long-title");
            Check(longTitlePage.Title.Length == BrowserReferenceReader.MaxTitleCharacters + 1
                  && longTitlePage.Title.EndsWith('…'),
                "an untrusted page title is visibly bounded before it reaches UI or activity");
        }

        var redirectHandler = new FakeBrowserHandler(request =>
            request.RequestUri?.AbsolutePath == "/start"
                ? RedirectResponse("https://docs.example.com/final")
                : TextResponse(HttpStatusCode.OK, "final reference", "text/plain"));
        using (redirectHandler)
        using (var redirectReader = new BrowserReferenceReader(redirectHandler, ResolvePublicAsync))
        {
            var redirected = await redirectReader.ReadAsync("https://example.com/start");
            Check(redirectHandler.Requests.Count == 2
                  && redirected.FinalAddress.Host == "docs.example.com",
                "an HTTPS redirect is followed only after its destination is revalidated");
            Check(redirected.Text == "final reference",
                "a redirected plain-text response is rendered");
        }

        var privateRedirectHandler = new FakeBrowserHandler(
            _ => RedirectResponse("https://127.0.0.1/private"));
        using (privateRedirectHandler)
        using (var privateRedirectReader = new BrowserReferenceReader(
                   privateRedirectHandler,
                   ResolvePublicAsync))
        {
            await ExpectFailureAsync(
                () => privateRedirectReader.ReadAsync("https://example.com/start"),
                "redirected to a refused address");
            Check(privateRedirectHandler.Requests.Count == 1,
                "a private redirect is refused before a second request is sent");
        }

        var mixedDnsHandler = new FakeBrowserHandler(
            _ => TextResponse(HttpStatusCode.OK, "should not be reached", "text/plain"));
        using (mixedDnsHandler)
        using (var mixedDnsReader = new BrowserReferenceReader(
                   mixedDnsHandler,
                   (_, _) => Task.FromResult(new[]
                   {
                       IPAddress.Parse("8.8.8.8"),
                       IPAddress.Parse("10.0.0.8")
                   })))
        {
            await ExpectFailureAsync(
                () => mixedDnsReader.ReadAsync("https://mixed.example/reference"),
                "resolves to a local, private");
            Check(mixedDnsHandler.Requests.Count == 0,
                "a hostname with any private DNS answer is refused before networking");
        }

        var binaryHandler = new FakeBrowserHandler(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent([0x89, 0x50, 0x4E, 0x47])
            };
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            return response;
        });
        using (binaryHandler)
        using (var binaryReader = new BrowserReferenceReader(binaryHandler, ResolvePublicAsync))
        {
            await ExpectFailureAsync(
                () => binaryReader.ReadAsync("https://example.com/picture.png"),
                "text pages only");
        }

        var downloadHandler = new FakeBrowserHandler(_ =>
        {
            var response = TextResponse(HttpStatusCode.OK, "download", "text/plain");
            response.Content.Headers.ContentDisposition =
                new ContentDispositionHeaderValue("attachment");
            return response;
        });
        using (downloadHandler)
        using (var downloadReader = new BrowserReferenceReader(downloadHandler, ResolvePublicAsync))
        {
            await ExpectFailureAsync(
                () => downloadReader.ReadAsync("https://example.com/file.txt"),
                "does not download files");
        }

        var oversizedHandler = new FakeBrowserHandler(_ =>
            TextResponse(
                HttpStatusCode.OK,
                new string('x', BrowserReferenceReader.MaxResponseBytes + 1),
                "text/plain"));
        using (oversizedHandler)
        using (var oversizedReader = new BrowserReferenceReader(oversizedHandler, ResolvePublicAsync))
        {
            await ExpectFailureAsync(
                () => oversizedReader.ReadAsync("https://example.com/huge"),
                "larger than");
        }

        var project = Path.Combine(
            Path.GetTempPath(),
            $"helmian-browser-reference-{Guid.NewGuid():N}");
        Directory.CreateDirectory(project);
        try
        {
            ProjectWorkbenchStore.RecordBrowserReference(
                project,
                page.DisplayAddress,
                page.Title,
                page.CharacterCount,
                page.EvidenceHash,
                new DateTimeOffset(2026, 8, 1, 9, 30, 0, TimeSpan.Zero));
            var activity = ProjectWorkbenchStore.ReadActivity(project);
            Check(activity.Count == 1
                  && activity[0].Kind == "browser"
                  && activity[0].Source == "Helmian Browser",
                "a successful read creates typed project activity evidence");
            Check(activity[0].EvidenceHash == page.EvidenceHash
                  && !activity[0].Detail.Contains("private=query", StringComparison.Ordinal),
                "project evidence retains the response hash without persisting URL query data");
        }
        finally
        {
            Directory.Delete(project, recursive: true);
        }

        Console.WriteLine($"Helmion Browser reference checks passed ({checks} checks).");
        await EmbeddedBrowserPolicyChecks.RunAsync();
    }

    private static Task<IPAddress[]> ResolvePublicAsync(
        string _,
        CancellationToken __) =>
        Task.FromResult(new[] { IPAddress.Parse("8.8.8.8") });

    private static HttpResponseMessage TextResponse(
        HttpStatusCode status,
        string text,
        string mediaType) =>
        new(status)
        {
            Content = new StringContent(text, Encoding.UTF8, mediaType)
        };

    private static HttpResponseMessage RedirectResponse(string location)
    {
        var response = new HttpResponseMessage(HttpStatusCode.Found);
        response.Headers.Location = new Uri(location);
        return response;
    }

    private static async Task ExpectFailureAsync(
        Func<Task> action,
        string expectedMessage)
    {
        try
        {
            await action();
        }
        catch (BrowserReferenceException exception) when (
            exception.Message.Contains(expectedMessage, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        throw new InvalidOperationException(
            $"Browser reference check failed: expected refusal containing '{expectedMessage}'.");
    }

    private sealed class FakeBrowserHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;

        public FakeBrowserHandler(Func<HttpRequestMessage, HttpResponseMessage> respond)
        {
            _respond = respond;
        }

        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var retained = new HttpRequestMessage(request.Method, request.RequestUri);
            foreach (var header in request.Headers)
            {
                retained.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            Requests.Add(retained);
            return Task.FromResult(_respond(request));
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                foreach (var request in Requests) request.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
