const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function createAccountRemoteControlApi({
  fetchImpl = globalThis.fetch,
  token = async () => null,
  nonce = defaultNonce,
} = {}) {
  async function request(path, options = {}) {
    const sessionToken = await token();
    const response = await fetchImpl(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        'x-helmian-nonce': nonce(),
        ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.message || 'Remote Control request failed.'), {
        status: response.status, code: body.error, body,
      });
    }
    return body;
  }

  return Object.freeze({
    config: () => request('/api/herald-config'),
    list: () => request('/api/remote/v1/desktops'),
    confirmEnrollment: (confirmationCode) => request('/api/remote/v1/enrollment', {
      method: 'POST', body: JSON.stringify({ action: 'confirm', confirmationCode }),
    }),
    select: (desktopId, sessionId) => request('/api/remote/v1/desktops', {
      method: 'POST', body: JSON.stringify({ action: 'select', desktopId, sessionId }),
    }),
    control: () => request('/api/remote/v1/control'),
    token: () => request('/api/remote/v1/control-token', { method: 'POST' }),
    clear: () => request('/api/remote/v1/control', { method: 'DELETE' }),
  });
}

export async function createAblyAccountControl({
  Ably,
  tokenProvider,
  onResult = () => {},
  onState = () => {},
} = {}) {
  if (!Ably?.Realtime || typeof tokenProvider !== 'function') {
    throw new TypeError('The Ably realtime client is unavailable.');
  }
  const initial = await tokenProvider();
  validateGrant(initial);
  let firstTokenAvailable = true;
  let closed = false;
  const client = new Ably.Realtime({
    autoConnect: true,
    echoMessages: false,
    // The result-channel subscription is created while the signed connection
    // is establishing. Let the SDK finish that attachment; send() still
    // refuses every instruction until the connection is explicitly connected.
    queueMessages: true,
    authCallback: async (_params, callback) => {
      try {
        const current = firstTokenAvailable ? initial : await tokenProvider();
        firstTokenAvailable = false;
        validateGrant(current);
        callback(null, current.tokenRequest);
      } catch (error) { callback(error); }
    },
  });
  const requestChannel = client.channels.get(initial.channels.requests);
  const actualResultChannel = client.channels.get(initial.channels.results);

  const resultHandler = (message) => {
    const result = normalizeResult(message?.data);
    if (result) onResult(result);
  };
  // Attaching a result channel can wait on the realtime connection.  Do not
  // make session selection wait on that attach: the caller must be able to
  // retain the selected Desktop and show a truthful "connecting" state while
  // Ably finishes authentication in the background.
  void Promise.resolve(actualResultChannel.subscribe('remote-result', resultHandler)).catch((error) => {
    onState({
      state: 'failed',
      reason: error instanceof Error ? error.message : 'The result channel could not attach.',
    });
  });
  client.connection.on((change) => {
    const state = String(change?.current ?? client.connection.state ?? 'unknown').toLowerCase();
    onState({ state, reason: change?.reason?.message ?? null });
  });

  return Object.freeze({
    async send(action, payload) {
      if (closed) throw new Error('Remote Control transport is closed.');
      if (!['instruction.submit', 'approval.decide'].includes(action)) {
        throw new TypeError('Remote Control action is not available.');
      }
      if (String(client.connection.state ?? '').toLowerCase() !== 'connected') {
        throw new Error('Remote Control is offline. Nothing was sent.');
      }
      const requestId = globalThis.crypto?.randomUUID?.() ?? defaultNonce();
      const clientId = initial.tokenRequest.clientId;
      await requestChannel.publish('remote-request', {
        v: 1, product: 'helmian-herald', kind: 'request', requestId,
        action, deviceId: clientId, payload,
      });
      return Object.freeze({ requestId, accepted: true });
    },
    close() {
      if (closed) return;
      closed = true;
      actualResultChannel.unsubscribe('remote-result', resultHandler);
      client.close();
      onState({ state: 'closed', reason: null });
    },
  });
}

export async function loadClerkBrowser(publishableKey, {
  documentImpl = globalThis.document,
  windowImpl = globalThis,
} = {}) {
  if (!/^pk_(?:test|live)_[A-Za-z0-9_-]{8,}\$?$/.test(String(publishableKey ?? ''))) {
    throw new Error('Helmian account sign-in configuration is unavailable.');
  }
  const encoded = publishableKey.split('_')[2];
  const domain = windowImpl.atob(encoded).slice(0, -1);
  if (!/^[A-Za-z0-9.-]+\.clerk\.accounts\.(?:dev|com)$/.test(domain)) {
    throw new Error('Helmian account frontend domain is invalid.');
  }
  await loadScript(documentImpl, `https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await loadScript(documentImpl, `https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
    'data-clerk-publishable-key': publishableKey,
  });
  const clerk = windowImpl.Clerk;
  if (!clerk) throw new Error('Helmian account sign-in did not load.');
  await clerk.load({ ui: { ClerkUI: windowImpl.__internal_ClerkUICtor } });
  return clerk;
}

export async function loadAblyBrowser({
  documentImpl = globalThis.document,
  windowImpl = globalThis,
} = {}) {
  if (!windowImpl.Ably?.Realtime) {
    await loadScript(documentImpl, 'https://cdn.ably.com/lib/ably.min-2.js');
  }
  if (!windowImpl.Ably?.Realtime) throw new Error('Realtime client could not load.');
  return windowImpl.Ably;
}

function loadScript(documentImpl, src, attributes = {}) {
  return new Promise((resolve, reject) => {
    const script = documentImpl.createElement('script');
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.onload = resolve;
    script.onerror = () => reject(new Error('Account sign-in script could not load.'));
    documentImpl.head.appendChild(script);
  });
}

function validateGrant(value) {
  if (value?.provider !== 'ably' || value?.role !== 'account-control' || value?.realtime !== true
    || typeof value?.tokenRequest?.mac !== 'string'
    || typeof value?.tokenRequest?.clientId !== 'string'
    || typeof value?.channels?.requests !== 'string'
    || typeof value?.channels?.results !== 'string') {
    throw new Error('The scoped Remote Control token response is invalid.');
  }
}

function normalizeResult(input) {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { return null; }
  }
  // Desktop Ably.NET historically published PascalCase records; accept both
  // casings so a result is never dropped after Desktop already acknowledged.
  if (value && (value.v == null || value.product == null) && (value.V != null || value.Product != null)) {
    const payload = value.payload ?? value.Payload ?? null;
    value = {
      v: value.v ?? value.V,
      product: value.product ?? value.Product,
      kind: value.kind ?? value.Kind,
      requestId: value.requestId ?? value.RequestId,
      action: value.action ?? value.Action,
      deviceId: value.deviceId ?? value.DeviceId,
      state: value.state ?? value.State,
      payload: payload && typeof payload === 'object'
        ? {
            message: payload.message ?? payload.Message ?? null,
            ...payload,
          }
        : payload,
    };
  }
  if (value?.v !== 1 || value?.product !== 'helmian-herald' || value?.kind !== 'result'
    || !ID.test(String(value?.requestId ?? ''))
    || !['ok', 'refused', 'error'].includes(value?.state)) return null;
  return Object.freeze(value);
}

function defaultNonce() {
  const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${id}-${Date.now()}`;
}
