function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

export default function handler(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { code: 'method_not_allowed' });
    return;
  }
  // The handoff is intentionally inert until a reviewed server-side Stripe
  // integration exists. Never accept a price, amount, redirect, or secret from
  // the browser, and never expose an EXE/download entitlement here.
  sendJson(response, 503, { code: 'checkout_not_configured', product: 'helmion-guard', paymentStarted: false, entitlementCreated: false });
}
