// The JSON-RPC layer (docs/CHAIN_DESIGN.md s.3, s.4 and s.5): what a request says and what an answer's
// outer layer means. Pure.
// - Requests: only read methods (never a refused or unknown one), a positive id, params as a list, written
//   losslessly (bigints as digits). getTransaction always carries maxSupportedTransactionVersion 1,
//   written here whatever the caller passed. The call builders fix the commitment (`confirmed`, R6) and
//   the encoding (`base64`) and refuse what a node would refuse: 0 or more than 100 keys, a key twice, a
//   data slice or a size outside an account's 10 MiB.
// - Answers: every transport outcome, status and node error maps to exactly one failure kind (s.4's
//   table), never to a default value. The envelope is exact: `jsonrpc` "2.0", our id, and exactly one of
//   `result` and `error`. No failure carries the node's message: it may echo our parameters.
// chain/ never retries (R5): a failure goes back with the time to retry at, where known.
import { parseLossless, stringifyLossless, type Json } from '../core/json.ts';
import { address, slot, type Address, type Slot } from '../core/solana.ts';
import type { DenyReason, RateHeaders } from './budget.ts';
import type { HttpOutcome } from './http.ts';
import { BUDGET_RULES, METHOD_TABLE, REFUSED_METHODS, type ReadMethod } from './limits.ts';

/** Every read is `confirmed` (R6): at least as fresh as the stream, and no caller chooses. */
export const COMMITMENT = 'confirmed';
/** The most keys getMultipleAccounts takes (the node's setting, VERIFIED_FACTS s.9). */
export const MAX_KEYS = 100;
/** The largest account (MAX_PERMITTED_DATA_LENGTH): every size and slice bound. */
export const MAX_ACCOUNT_BYTES = 10 * 1024 * 1024;
/** The longest error message read (it is never logged; a longer one is not an answer). */
const MAX_MESSAGE_LENGTH = 1_024;
const I32_MIN = -(2n ** 31n);
const I32_MAX = 2n ** 31n - 1n;
const I63_MAX = (1n << 63n) - 1n;

export type BadResponseCode = 'content-type' | 'utf8' | 'json' | 'envelope' | 'id' | 'shape' | 'count' | 'went-back';
export type NotReadableCode = -32001 | -32004 | -32007 | -32009 | -32011 | -32014 | -32019;

export type ChainFailure =
  | { readonly kind: 'unverified' | 'wrong-cluster' | 'blocked' | 'shutdown' | 'timeout' | 'transport' | 'too-large' }
  | { readonly kind: 'denied'; readonly reason: DenyReason; readonly retryAtMs: number }
  /** retryAtMs on the monotonic clock, as the governor's. */
  | { readonly kind: 'rate-limited'; readonly retryAtMs: number }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'bad-response'; readonly code: BadResponseCode }
  /** A JSON-RPC code of s.4's table, or the HTTP status 400, 405, 413 or 415. */
  | { readonly kind: 'our-bug'; readonly code: number }
  | { readonly kind: 'node-behind'; readonly code: -32016 | -32005; readonly nodeSlot: Slot | null }
  | { readonly kind: 'not-readable'; readonly code: NotReadableCode; readonly permanent: boolean }
  | { readonly kind: 'stale'; readonly contextSlot: Slot }
  | { readonly kind: 'rpc'; readonly code: number };

export type ChainResult<T> =
  | { readonly ok: true; readonly value: T; readonly contextSlot: Slot | null; readonly latencyMs: number }
  | { readonly ok: false; readonly failure: ChainFailure };

/** An answer's outer layer: the result exactly as parsed (frozen, integers as bigints), or a failure. */
export type Envelope = { readonly ok: true; readonly result: Json } | { readonly ok: false; readonly failure: ChainFailure };

/** A method with its params, as the builders below write them. */
export interface RpcCall {
  readonly method: ReadMethod;
  readonly params: readonly Json[];
}

export interface DataSlice {
  readonly offset: number;
  readonly length: number;
}

function isObject(v: unknown): v is Readonly<Record<string, Json>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPlainObject(v: unknown): v is Readonly<Record<string, Json>> {
  if (!isObject(v)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isReadMethod(m: unknown): m is ReadMethod {
  return typeof m === 'string' && Object.hasOwn(METHOD_TABLE, m) && !REFUSED_METHODS.includes(m);
}

/** getTransaction's config with maxSupportedTransactionVersion 1, whatever was passed (s.5). */
function withVersion1(params: readonly Json[]): readonly Json[] {
  if (params.length < 1 || params.length > 2) {
    throw new TypeError('getTransaction takes a signature and an optional config');
  }
  const config = params.length === 2 ? params[1] : {};
  if (!isPlainObject(config)) {
    throw new TypeError("getTransaction's config is a plain object");
  }
  return [params[0] as Json, { ...config, maxSupportedTransactionVersion: 1n }];
}

/** The request text: a read method only, the id a bigint from 1 to 2^63 - 1, params a list. */
export function encodeRequest(id: bigint, method: ReadMethod, params: readonly Json[]): string {
  if (!isReadMethod(method)) {
    throw new TypeError('only the read methods of chain/limits.ts are encoded');
  }
  if (typeof id !== 'bigint' || id < 1n || id > I63_MAX) {
    throw new TypeError('a request id is a bigint from 1 to 2^63 - 1');
  }
  if (!Array.isArray(params)) {
    throw new TypeError('params are a list');
  }
  const sent = method === 'getTransaction' ? withVersion1(params) : params;
  return stringifyLossless({ jsonrpc: '2.0', id, method, params: sent });
}

const frozen = <T extends object>(o: T): T => Object.freeze(o);
const fail = (failure: ChainFailure): Envelope => frozen({ ok: false, failure: frozen(failure) });
const bad = (code: BadResponseCode): Envelope => fail({ kind: 'bad-response', code });

/** As the governor reads Retry-After (chain/budget.ts): missing gives 60 s, under 10 s gives 10 s, more than 600 s gives 600 s. */
function rateLimited(rate: RateHeaders, monoNowMs: number): ChainFailure {
  const after = rate.retryAfterSec;
  const waitMs =
    typeof after === 'number' && Number.isInteger(after) && after >= 0
      ? Math.min(Math.max(after * 1_000, BUDGET_RULES.retryAfterMinMs), BUDGET_RULES.retryAfterMaxMs)
      : BUDGET_RULES.retryAfterDefaultMs;
  return { kind: 'rate-limited', retryAtMs: monoNowMs + waitMs };
}

function statusFailure(status: number, rate: RateHeaders, monoNowMs: number): ChainFailure {
  switch (status) {
    case 429:
      return rateLimited(rate, monoNowMs);
    case 403:
      return { kind: 'blocked' };
    case 400:
    case 405:
    case 413:
    case 415:
      return { kind: 'our-bug', code: status };
    default:
      return { kind: 'http', status };
  }
}

interface NodeError {
  readonly code: number;
  readonly data: Json | undefined;
}

/** `{code, message, data?}` exactly; the code an integer in the 32-bit range, the message at most 1 KiB (then dropped). */
function readError(e: Json | undefined): NodeError | null {
  if (!isObject(e)) {
    return null;
  }
  const hasData = Object.hasOwn(e, 'data');
  if (Object.keys(e).length !== (hasData ? 3 : 2) || !Object.hasOwn(e, 'code') || !Object.hasOwn(e, 'message')) {
    return null;
  }
  const code = e['code'];
  const message = e['message'];
  if (typeof code !== 'bigint' || code < I32_MIN || code > I32_MAX || typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  return { code: Number(code), data: hasData ? e['data'] : undefined };
}

/** -32016's `data.contextSlot` when it is a slot, else none (it is reported, never used as data). */
function contextSlotOf(data: Json | undefined): Slot | null {
  if (!isObject(data)) {
    return null;
  }
  const s = data['contextSlot'];
  return typeof s === 'bigint' && s >= 0n && s <= I63_MAX ? slot(s) : null;
}

function notReadable(code: number): ChainFailure | null {
  switch (code) {
    case -32001:
    case -32004:
    case -32011:
    case -32014:
    case -32019:
      return { kind: 'not-readable', code, permanent: false };
    case -32007:
    case -32009:
      return { kind: 'not-readable', code, permanent: true };
    default:
      return null;
  }
}

/** s.4's table; a body code 429 is the limiter's answer, as the status is. */
function classify(e: NodeError, rate: RateHeaders, monoNowMs: number): ChainFailure {
  switch (e.code) {
    case 429:
      return rateLimited(rate, monoNowMs);
    case -32700:
    case -32600:
    case -32601:
    case -32602:
    case -32015:
      return { kind: 'our-bug', code: e.code };
    case -32016:
      return { kind: 'node-behind', code: -32016, nodeSlot: contextSlotOf(e.data) };
    case -32005:
      return { kind: 'node-behind', code: -32005, nodeSlot: null };
    default:
      return notReadable(e.code) ?? { kind: 'rpc', code: e.code };
  }
}

function readBody(text: string, id: bigint, rate: RateHeaders, monoNowMs: number): Envelope {
  let parsed: Json;
  try {
    parsed = parseLossless(text);
  } catch {
    return bad('json'); // the parser's message quotes the text
  }
  if (!isObject(parsed)) {
    return bad('envelope');
  }
  const hasResult = Object.hasOwn(parsed, 'result');
  if (Object.keys(parsed).length !== 3 || !Object.hasOwn(parsed, 'jsonrpc') || !Object.hasOwn(parsed, 'id') || hasResult === Object.hasOwn(parsed, 'error')) {
    return bad('envelope');
  }
  if (parsed['jsonrpc'] !== '2.0') {
    return bad('envelope');
  }
  if (hasResult) {
    return parsed['id'] === id ? frozen({ ok: true, result: parsed['result'] as Json }) : bad('id');
  }
  const e = readError(parsed['error']);
  if (e === null) {
    return bad('envelope');
  }
  // JSON-RPC 2.0: the id is null when the node could not read ours (a parse error or an invalid request)
  const idOk = parsed['id'] === id || (parsed['id'] === null && (e.code === -32700 || e.code === -32600));
  return idOk ? fail(classify(e, rate, monoNowMs)) : bad('id');
}

/** What an HTTP outcome says, for the request with this id; monoNowMs dates a Retry-After. */
export function readEnvelope(o: HttpOutcome, id: bigint, monoNowMs: number): Envelope {
  switch (o.kind) {
    case 'timeout':
    case 'shutdown':
    case 'transport':
    case 'too-large':
      return fail({ kind: o.kind });
    case 'content-type':
    case 'utf8':
      return bad(o.kind);
    case 'request-too-large':
      return fail({ kind: 'our-bug', code: 413 });
    case 'response':
      if (o.status !== 200) {
        return fail(statusFailure(o.status, o.rate, monoNowMs));
      }
      return o.bodyText === null ? bad('json') : readBody(o.bodyText, id, o.rate, monoNowMs);
  }
}

// ---- the call builders (s.5): commitment and encoding fixed here, never by a caller

function wholeBytes(what: string, n: unknown): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > MAX_ACCOUNT_BYTES) {
    throw new TypeError(`${what} is a whole number of bytes from 0 to ${MAX_ACCOUNT_BYTES}`);
  }
  return n;
}

const call = (method: ReadMethod, params: readonly Json[]): RpcCall => frozen({ method, params: frozen(params) });
const commitmentAndMin = (minContextSlot: Slot): Json => frozen({ commitment: COMMITMENT, minContextSlot: slot(minContextSlot) });

export const calls = Object.freeze({
  genesisHash: (): RpcCall => call('getGenesisHash', []),
  slot: (minContextSlot: Slot): RpcCall => call('getSlot', [commitmentAndMin(minContextSlot)]),
  blockHeight: (minContextSlot: Slot): RpcCall => call('getBlockHeight', [commitmentAndMin(minContextSlot)]),
  /** 1 to 100 distinct keys, in the order their answers come back. */
  accounts: (keys: readonly Address[], slice: DataSlice | null, minContextSlot: Slot): RpcCall => {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEYS) {
      throw new TypeError(`getMultipleAccounts takes 1 to ${MAX_KEYS} keys`);
    }
    const checked = keys.map((k: unknown) => address(k));
    if (new Set(checked).size !== checked.length) {
      throw new TypeError('getMultipleAccounts takes each key once');
    }
    const config: Record<string, Json> = { commitment: COMMITMENT, encoding: 'base64' };
    if (slice !== null) {
      if (!isObject(slice) || Object.keys(slice).length !== 2) {
        throw new TypeError('a data slice is {offset, length}');
      }
      config['dataSlice'] = frozen({ offset: wholeBytes('a slice offset', slice.offset), length: wholeBytes('a slice length', slice.length) });
    }
    config['minContextSlot'] = slot(minContextSlot);
    return call('getMultipleAccounts', [frozen(checked), frozen(config)]);
  },
  /** One writable account: the fee floor for transactions that lock it (VERIFIED_FACTS s.9). */
  priorityFees: (writable: Address): RpcCall => call('getRecentPrioritizationFees', [frozen([address(writable)])]),
  rentExemptMinimum: (dataBytes: number): RpcCall => call('getMinimumBalanceForRentExemption', [wholeBytes('an account size', dataBytes), frozen({ commitment: COMMITMENT })]),
});
