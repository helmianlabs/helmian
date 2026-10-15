// Classic (non-module) script: runs before the deferred account shell module.
// Relay pairing links from Helmian Desktop ("Start phone sharing") look like
//   https://helmian.cloud/herald/?channel=herald_…#pair=12345678
// (the trailing slash is 308-redirected to /herald?channel=… by Vercel, which
// keeps the query and the browser keeps the fragment). Send those to the relay
// pairing page so the #pair code auto-fills. Everything else stays on the
// account shell unchanged.
(function routeRelayPairing() {
  try {
    var channel = new URLSearchParams(location.search).get('channel');
    if (channel && /^herald_[A-Za-z0-9_-]{20,80}$/.test(channel) && !/\/herald\/pair(?:\.html)?$/.test(location.pathname)) {
      location.replace('/herald/pair' + location.search + location.hash);
    }
  } catch (_) { /* stay on the account shell */ }
})();
