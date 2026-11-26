// The fetch transport (docs/CHAIN_DESIGN.md s.4 and s.9): the only file in src/ that names fetch (the
// architecture test), so every request to a provider goes through these rules:
// - the provider URL is checked once: https only, no user name or password, no fragment, and every
//   query value one of its secret parts, each registered as the bot's own secret (so a key can never
//   pass the secret filter in any encoding);
// - one POST of JSON text at most 48 KiB, `redirect: 'error'`, no credentials, a timeout from the
//   injected timers joined with the shutdown signal; nothing is sent once the bot is stopping;
// - a 200 must say application/json; its decoded bytes (after gzip) are counted as they arrive and
//   reading stops past the method's cap; a content-length over the cap is refused unread; the text
//   must be valid UTF-8. Any other status comes back with its headers, its body read at most 4 KiB and
//   dropped. Every body is read to the end or cancelled, so the connection is released.
// - an abort is `shutdown` when the bot stopped, else `timeout`; any other failure is `transport`. The
//   error object is dropped unread: fetch's messages can name the URL, and with it a key.
// It never rejects for what the network does; a call that cannot be right is a TypeError at once.
// Production passes no fetchImpl (the global fetch); the tests point it at a local server.
import type { Timers } from '../core/clock.ts';
import { registerOwnSecret } from '../core/redact.ts';
import type { RateHeaders } from './budget.ts';
import type { ProviderEndpoint } from './providers.ts';

/** Under the public endpoint's 50 KiB request cap (VERIFIED_FACTS s.9). */
export const MAX_REQUEST_BYTES = 49_152;
/** The most of an error body ever read (it is dropped). */
const ERROR_BODY_MAX_BYTES = 4_096;

export type HttpOutcome =
  /** bodyText: the text of a 200 with a JSON type; null for any other status. */
  | { readonly kind: 'response'; readonly status: number; readonly rate: RateHeaders; readonly bodyText: string | null; readonly bytes: number }
  | { readonly kind: 'timeout' | 'shutdown' | 'transport' | 'too-large' | 'content-type' | 'utf8' | 'request-too-large'; readonly bytes: number };

export interface HttpRequest {
  readonly bodyText: string;
  readonly timeoutMs: number;
  /** The most decoded bytes the answer may have (the method's cap). */
  readonly maxBytes: number;
}

export interface HttpTransport {
  post(r: HttpRequest): Promise<HttpOutcome>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const JSON_TYPE = /^application\/json\s*(?:;.*)?$/i;
const DIGITS = /^[0-9]{1,9}$/;
const SIGNED_DIGITS = /^-?[0-9]{1,9}$/;
const LENGTH = /^[0-9]{1,15}$/;
const ENCODER = new TextEncoder();

/** The provider's URL, checked; the refusals never echo the URL (it may hold a key). */
function checkedUrl(e: ProviderEndpoint): string {
  let u: URL;
  try {
    u = new URL(e.httpUrl);
  } catch {
    throw new TypeError("the provider's URL is not a URL");
  }
  if (u.protocol !== 'https:') {
    throw new TypeError("the provider's URL must be https");
  }
  if (u.username !== '' || u.password !== '' || u.hash !== '') {
    throw new TypeError("the provider's URL has no user name, password or fragment");
  }
  for (const [, value] of u.searchParams) {
    if (!e.secretParts.includes(value)) {
      throw new TypeError("every query value of the provider's URL is listed as a secret part");
    }
  }
  for (const part of e.secretParts) {
    registerOwnSecret(part); // a TypeError for one too short to recognise
  }
  return u.href;
}

function rateOf(h: Headers): RateHeaders {
  const read = (name: string, form: RegExp): number | null => {
    const v = h.get(name);
    return v !== null && form.test(v) ? Number(v) : null;
  };
  return Object.freeze({
    methodLimit: read('x-ratelimit-method-limit', DIGITS),
    methodRemaining: read('x-ratelimit-method-remaining', SIGNED_DIGITS),
    retryAfterSec: read('retry-after', DIGITS), // delta-seconds only, never a date
  });
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // the body is already gone: nothing left to release
  }
}

export function createHttpTransport(o: { readonly endpoint: ProviderEndpoint; readonly timers: Timers; readonly shutdown: AbortSignal; readonly fetchImpl?: FetchLike }): HttpTransport {
  const url = checkedUrl(o.endpoint);
  const send: FetchLike = o.fetchImpl ?? ((u, init) => fetch(u, init));

  const run = async (r: HttpRequest): Promise<HttpOutcome> => {
    if (ENCODER.encode(r.bodyText).byteLength > MAX_REQUEST_BYTES) {
      return Object.freeze({ kind: 'request-too-large', bytes: 0 });
    }
    if (o.shutdown.aborted) {
      return Object.freeze({ kind: 'shutdown', bytes: 0 });
    }
    const timeout = o.timers.timeoutSignal(r.timeoutMs);
    let bytes = 0;
    const failed = (): HttpOutcome => Object.freeze({ kind: o.shutdown.aborted ? 'shutdown' : timeout.aborted ? 'timeout' : 'transport', bytes });
    let res: Response;
    try {
      res = await send(url, {
        method: 'POST',
        body: r.bodyText,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.any([timeout, o.shutdown]),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      });
    } catch {
      return failed();
    }
    const status = res.status;
    const ok = status === 200;
    const rate = rateOf(res.headers);
    const dropped = (): HttpOutcome => Object.freeze({ kind: 'response', status, rate, bodyText: null, bytes });
    if (ok && !JSON_TYPE.test(res.headers.get('content-type') ?? '')) {
      await discard(res);
      return Object.freeze({ kind: 'content-type', bytes: 0 });
    }
    const limit = ok ? r.maxBytes : Math.min(ERROR_BODY_MAX_BYTES, r.maxBytes);
    const declared = res.headers.get('content-length');
    if (declared !== null && LENGTH.test(declared) && Number(declared) > limit) {
      await discard(res);
      return ok ? Object.freeze({ kind: 'too-large', bytes: 0 }) : dropped();
    }
    const chunks: Uint8Array[] = [];
    if (res.body !== null) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          bytes += value.byteLength;
          if (bytes > limit) {
            await discard(res);
            return ok ? Object.freeze({ kind: 'too-large', bytes }) : dropped();
          }
          if (ok) {
            chunks.push(value);
          }
        }
      } catch {
        return failed();
      }
    }
    if (!ok) {
      return dropped();
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    try {
      for (const c of chunks) {
        text += decoder.decode(c, { stream: true });
      }
      text += decoder.decode();
    } catch {
      return Object.freeze({ kind: 'utf8', bytes });
    }
    return Object.freeze({ kind: 'response', status, rate, bodyText: text, bytes });
  };

  const post = (r: HttpRequest): Promise<HttpOutcome> => {
    if (typeof r.bodyText !== 'string') {
      throw new TypeError('the request body is JSON text');
    }
    if (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1) {
      throw new TypeError('a timeout is whole milliseconds from 1');
    }
    if (!Number.isInteger(r.maxBytes) || r.maxBytes < 1) {
      throw new TypeError('a byte cap is a whole number from 1');
    }
    return run(r);
  };

  return Object.freeze({ post });
}
