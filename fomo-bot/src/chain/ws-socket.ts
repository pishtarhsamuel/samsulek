// The WebSocket door (docs/CHAIN_DESIGN.md s.7 and s.9, step 7f): with chain/http.ts, the only file in
// src/ that names WebSocket (the architecture test), so the stream's socket follows these rules:
// - the provider's URL is checked once: wss only, no user name or password, no fragment, and every
//   query value one of its secret parts, each registered as the bot's own secret (so a key can never
//   pass the secret filter in any encoding); the refusals never name the URL;
// - the factory opens only that checked URL, with binaryType 'arraybuffer' (binary ends the socket in
//   chain/ws.ts);
// - the error event is dropped unread (its message can name the URL, and with it a key);
// - terminate() detaches every handler first, then closes: after it nothing reaches the stream, even when
//   the server sent a close frame and never closed the TCP connection (then `close` never fires).
// Built on Node's own WebSocket (review X, security 3, decided in 7f): it buffers a whole frame before
// chain/ws.ts can look at its size, so a huge frame is a crash risk, guarded by the ops memory limit and
// the restart (Phase 7), not a drop; a hand-written frame reader would need its own network file and
// review. Production passes no `open`; the tests point it at a local server.
import { registerOwnSecret } from '../core/redact.ts';
import type { ProviderEndpoint } from './providers.ts';
import type { SocketFactory, SocketHandle } from './ws.ts';

/** Opens a socket for the checked URL; the tests open a local one instead. */
export type WebSocketOpener = (url: string) => WebSocket;

/** The provider's WebSocket URL, checked; the refusals never echo the URL (it may hold a key). */
function checkedWsUrl(e: ProviderEndpoint): string {
  let u: URL;
  try {
    u = new URL(e.wsUrl);
  } catch {
    throw new TypeError("the provider's WebSocket URL is not a URL");
  }
  if (u.protocol !== 'wss:') {
    throw new TypeError("the provider's WebSocket URL must be wss");
  }
  if (u.username !== '' || u.password !== '' || u.hash !== '') {
    throw new TypeError("the provider's WebSocket URL has no user name, password or fragment");
  }
  for (const [, value] of u.searchParams) {
    if (!e.secretParts.includes(value)) {
      throw new TypeError("every query value of the provider's WebSocket URL is listed as a secret part");
    }
  }
  for (const part of e.secretParts) {
    registerOwnSecret(part); // a TypeError for one too short to recognise
  }
  return u.href;
}

export function createWebSocketFactory(o: { readonly endpoint: ProviderEndpoint; readonly open?: WebSocketOpener }): SocketFactory {
  const url = checkedWsUrl(o.endpoint);
  const open: WebSocketOpener = o.open ?? ((u) => new WebSocket(u));
  const factory: SocketFactory = (asked, h) => {
    if (asked !== url) {
      throw new TypeError("the stream opens only its provider's checked URL");
    }
    const ws = open(url);
    ws.binaryType = 'arraybuffer';
    let attached = true;
    ws.onopen = () => {
      if (attached) {
        h.open();
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (attached) {
        h.message(ev.data);
      }
    };
    ws.onclose = () => {
      if (attached) {
        h.closed();
      }
    };
    ws.onerror = () => {
      // the event is dropped unread: its message can name the URL
      if (attached) {
        h.error();
      }
    };
    const handle: SocketHandle = {
      // only an open socket takes a message (close() makes it CLOSING at once, so after terminate() too)
      send: (text) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return false;
        }
        ws.send(text);
        return true;
      },
      // detach first: every handler above checks `attached`, so nothing reaches the stream after this
      terminate: () => {
        attached = false;
        ws.close();
      },
    };
    return Object.freeze(handle);
  };
  return factory;
}
