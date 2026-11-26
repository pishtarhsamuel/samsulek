// The read client (docs/CHAIN_DESIGN.md s.3, s.4, s.5 and s.8, step 7e): the paper bot's only way to read
// the chain, and it has no way to send: no send or sign member, no generic rpc(method), and the encoder
// takes only read methods. Each call:
// - waits for the genesis lock: until getGenesisHash has said mainnet-beta, every call is `unverified`;
//   any other hash latches `wrong-cluster` until a restart (one event);
// - writes its request through the call builders (commitment `confirmed`, encoding `base64`, the
//   minContextSlot mark) and refuses one over the size cap as our bug before the budget is asked;
// - asks the budget, posts, and settles in `finally` (a body 429 is settled as status 429, so the method
//   closes as it does for the status);
// - reads the envelope, decodes strictly, and refuses an answer whose slot is below the minContextSlot
//   sent (`went-back`) or more than 150 slots behind the feed (`stale`); only then is the slot reported
//   to the feed, on 'http' (never 'http-2', R4).
// The minContextSlot mark rises only with slots the feed accepts: by at most feed.currentSlot(), never
// by a raw answer alone, so one wild answer cannot make every honest node look behind (review X, risk 1).
// chain/ never retries (R5). Events carry codes only, and a failing sink never stops a read.
import type { MonoClock } from '../core/clock.ts';
import type { Json } from '../core/json.ts';
import type { Address, BlockHeight, Slot } from '../core/solana.ts';
import type { Lamports } from '../core/units.ts';
import type { BudgetGovernor, Settlement } from './budget.ts';
import { decodeAccounts, decodeBlockHeight, decodeGenesisHash, decodePriorityFees, decodeRent, decodeSlot, rentFormula, type Account, type Decoded, type FeeEntry, type RpcContext } from './decode.ts';
import type { ChainEvent, ChainEventCode, ChainEvents } from './events.ts';
import { MAX_REQUEST_BYTES, type HttpOutcome, type HttpTransport } from './http.ts';
import { METHOD_TABLE, PRIORITIES, type Priority, type ProviderId, type ReadMethod } from './limits.ts';
import { MAINNET_GENESIS_HASH, type ProviderEndpoint } from './providers.ts';
import { calls, encodeRequest, readEnvelope, type ChainFailure, type ChainResult, type DataSlice, type Envelope, type RpcCall } from './rpc.ts';

/** A context this many slots behind the feed is stale (ARCHITECTURE s.12; plans keep their own 25). */
export const STALE_SLOTS = 150n;
/** The cluster check is due again after this long (s.8). */
const CLUSTER_RECHECK_MS = 3_600_000;
/** apiVersion goes into an event only in this form (s.3; review Y, security 8). */
const PLAIN_VERSION = /^[0-9]{1,4}(\.[0-9]{1,4}){2}$/;
const ENCODER = new TextEncoder();

/** What a read is for: the budget's reports and the logs (s.3). */
export const FEATURES = Object.freeze([
  'boot',
  'exit-marks',
  'plan-reread',
  'slot',
  'expiry',
  'clock',
  'fees',
  'rent',
  'safety',
  'anchors',
  'audit',
  'launch',
  'crowdflow',
  'momentum',
  'twins',
] as const);
export type Feature = (typeof FEATURES)[number];

export interface CallOpts {
  readonly priority: Priority;
  readonly feature: Feature;
}

/** app/slots.ts's feed fits both (chain/ cannot import app/). */
export interface SlotReporter {
  report(channel: 'stream' | 'http' | 'http-2', slot: unknown): void;
}
export interface SlotView {
  currentSlot(): bigint | null;
}

/**
 * What the app does with each failure kind (review Y, risk 8): a breaker of RISK_POLICY s.8 or a named
 * latch, so no kind can be added without one. RPC_ERRORS (errors over 20% in 2 min, all entries off)
 * counts a denial only for P0, as s.8 says; DATA_STALE stops all entries; PROVIDER_BLOCKED stops all
 * entries until the block lifts; CLUSTER keeps entries off until the lock opens (a wrong cluster stays
 * latched, with its alert); BUG is the entry latch 'bug' until a restart; STOPPING is the bot shutting down.
 */
export type FailureRule = 'RPC_ERRORS' | 'DATA_STALE' | 'PROVIDER_BLOCKED' | 'CLUSTER' | 'BUG' | 'STOPPING';
export const FAILURE_RULES: Readonly<Record<ChainFailure['kind'], FailureRule>> = Object.freeze({
  unverified: 'CLUSTER',
  'wrong-cluster': 'CLUSTER',
  blocked: 'PROVIDER_BLOCKED',
  shutdown: 'STOPPING',
  timeout: 'RPC_ERRORS',
  transport: 'RPC_ERRORS',
  'too-large': 'RPC_ERRORS',
  denied: 'RPC_ERRORS',
  'rate-limited': 'RPC_ERRORS',
  http: 'RPC_ERRORS',
  'bad-response': 'RPC_ERRORS',
  'our-bug': 'BUG',
  'node-behind': 'DATA_STALE',
  'not-readable': 'RPC_ERRORS',
  stale: 'DATA_STALE',
  rpc: 'RPC_ERRORS',
});

/** The paper client: reads only. */
export interface ReadClient {
  readonly provider: ProviderId;
  /** getGenesisHash at P0; every other call waits for it. */
  verifyCluster(): Promise<ChainResult<'mainnet-beta'>>;
  /** True before the lock opens and an hour after the last good check; false once latched wrong. */
  needsClusterCheck(): boolean;
  /** confirmed; reported to the feed as 'http'. */
  slot(o: CallOpts): Promise<ChainResult<Slot>>;
  blockHeight(o: CallOpts): Promise<ChainResult<BlockHeight>>;
  /** 1 to 100 distinct keys, answered in their order; null is a missing account, never a zero one. */
  accounts(keys: readonly Address[], o: CallOpts & { readonly slice?: DataSlice }): Promise<ChainResult<readonly (Account | null)[]>>;
  /** By slot; an empty list is no reading, never a fee of 0. */
  priorityFees(writable: Address, o: CallOpts): Promise<ChainResult<readonly FeeEntry[]>>;
  /** The chain's value, even when it differs from the formula (then chain-rent-formula fires). */
  rentExemptMinimum(dataBytes: number, o: CallOpts): Promise<ChainResult<Lamports>>;
}

export interface ReadClientOptions {
  readonly endpoint: ProviderEndpoint;
  readonly transport: HttpTransport;
  readonly budget: BudgetGovernor;
  readonly mono: MonoClock;
  readonly slots: SlotReporter & SlotView;
  readonly events: ChainEvents;
  /** Only tighter than MAX_REQUEST_BYTES (a test reaches the size check with it); production passes none. */
  readonly tighten?: { readonly maxRequestBytes?: number };
}

type ClusterState = 'unverified' | 'verified' | 'wrong-cluster';

/** A decoder's refusal. */
type Refusal = Extract<Decoded<never>, { readonly ok: false }>;

/** What a decoded answer still has to pass: a slot the feed may judge and the client may report. */
interface Checked<T> {
  readonly value: T;
  /** The answer's slot (a context slot, or getSlot's result), or null when it has none. */
  readonly slot: Slot | null;
  readonly apiVersion: string | null;
}

export function createReadClient(o: ReadClientOptions): ReadClient {
  const maxRequestBytes = o.tighten?.maxRequestBytes ?? MAX_REQUEST_BYTES;
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > MAX_REQUEST_BYTES) {
    throw new TypeError(`the request cap may only be tightened: a whole number from 1 to ${MAX_REQUEST_BYTES}`);
  }
  const provider = o.endpoint.id;
  let cluster: ClusterState = 'unverified';
  let verifiedAtMs = Number.NEGATIVE_INFINITY;
  let nextId = 1n;
  let mark = 0n as Slot;
  let apiVersion: string | null = null;

  const emit = (code: ChainEventCode, method: ReadMethod, extra: { readonly apiVersion?: string } = {}): void => {
    const e: ChainEvent = Object.freeze({ code, provider, method, ...extra });
    try {
      o.events.event(e);
    } catch {
      // the sink's failure is the sink's: a read never stops for it
    }
  };

  const fail = <T>(failure: ChainFailure): ChainResult<T> => Object.freeze({ ok: false, failure: Object.freeze(failure) });

  const checkOpts = (opts: unknown): void => {
    const c = opts as Partial<CallOpts> | null;
    if (typeof c !== 'object' || c === null || !PRIORITIES.includes(c.priority as Priority) || !(FEATURES as readonly string[]).includes(c.feature as string)) {
      throw new TypeError('call options are a priority P0 to P4 and a known feature');
    }
  };

  const settlementOf = (out: HttpOutcome | null, env: Envelope | null): Settlement => {
    if (out === null) {
      return { decodedBytes: 0, status: null, rate: null };
    }
    if (out.kind !== 'response') {
      return { decodedBytes: out.bytes, status: null, rate: null };
    }
    // a body 429 is the limiter's answer, as the status is: the method closes the same way (s.20)
    const status = env !== null && !env.ok && env.failure.kind === 'rate-limited' ? 429 : out.status;
    return { decodedBytes: out.bytes, status, rate: out.rate };
  };

  /** The envelope's failures that the owner should hear of (went-back and stale are the client's own, below). */
  const eventFor = (f: ChainFailure, method: ReadMethod): void => {
    if (f.kind === 'our-bug') {
      emit('chain-our-bug', method);
    } else if (f.kind === 'bad-response') {
      emit('chain-shape', method);
    }
  };

  const noteApiVersion = (v: string | null, method: ReadMethod): void => {
    if (v === null || v === apiVersion) {
      return;
    }
    const first = apiVersion === null;
    apiVersion = v;
    if (!first) {
      emit('chain-api-version', method, PLAIN_VERSION.test(v) ? { apiVersion: v } : {});
    }
  };

  /** One request: the size check, the budget, the post, the settle, the envelope, the decoder, the slot checks. */
  const run = async <T>(call: RpcCall, opts: CallOpts, check: (result: Json) => Refusal | Checked<T>, minSent: Slot | null): Promise<ChainResult<T>> => {
    const method = call.method;
    const rule = METHOD_TABLE[method];
    const id = nextId;
    nextId += 1n;
    const bodyText = encodeRequest(id, method, call.params);
    if (ENCODER.encode(bodyText).byteLength > maxRequestBytes) {
      emit('chain-our-bug', method);
      return fail({ kind: 'our-bug', code: 413 }); // never sent, so the budget is never spent on it
    }
    const grant = o.budget.acquire(method, opts.priority);
    if (!grant.ok) {
      return fail({ kind: 'denied', reason: grant.reason, retryAtMs: grant.retryAtMs });
    }
    const startedMs = o.mono.nowMs();
    let out: HttpOutcome | null = null;
    let env: Envelope | null = null;
    try {
      out = await o.transport.post({ bodyText, timeoutMs: rule.timeoutMs, maxBytes: rule.maxResponseBytes });
      env = readEnvelope(out, id, o.mono.nowMs());
    } finally {
      o.budget.settle(grant.ticket, settlementOf(out, env));
    }
    const took = o.mono.nowMs() - startedMs;
    const latencyMs = Number.isFinite(took) && took > 0 ? took : 0;
    if (!env.ok) {
      eventFor(env.failure, method);
      return fail(env.failure);
    }
    const checked = check(env.result);
    if ('ok' in checked) {
      emit('chain-shape', method);
      return fail({ kind: 'bad-response', code: checked.code });
    }
    const s = checked.slot;
    if (s !== null) {
      if (minSent !== null && s < minSent) {
        emit('chain-stale', method);
        return fail({ kind: 'bad-response', code: 'went-back' }); // the node ignored our minContextSlot
      }
      const feed = o.slots.currentSlot();
      if (feed !== null && s + STALE_SLOTS < feed) {
        emit('chain-stale', method);
        return fail({ kind: 'stale', contextSlot: s });
      }
      o.slots.report('http', s);
      // the mark rises only as far as the feed has accepted (review X, risk 1)
      const accepted = o.slots.currentSlot();
      if (accepted !== null) {
        const bound = s < accepted ? s : accepted;
        if (bound > mark) {
          mark = bound as Slot;
        }
      }
    }
    noteApiVersion(checked.apiVersion, method);
    return Object.freeze({ ok: true, value: checked.value, contextSlot: s, latencyMs });
  };

  /** A decoded bare value: no slot to check, no apiVersion. */
  const bare = <T>(decoded: Decoded<T>): Refusal | Checked<T> => (decoded.ok ? { value: decoded.value, slot: null, apiVersion: null } : decoded);
  /** A decoded answer with a context: its slot and apiVersion are checked and noted. */
  const withContext = <T>(decoded: Decoded<T>): Refusal | Checked<T> => {
    if (!decoded.ok) {
      return decoded;
    }
    const c = decoded.context as RpcContext; // the decoders that take a context always return one
    return { value: decoded.value, slot: c.slot, apiVersion: c.apiVersion };
  };

  const gate = <T>(opts: unknown): ChainResult<T> | null => {
    checkOpts(opts);
    return cluster === 'verified' ? null : fail({ kind: cluster });
  };

  /** Read through a call, so the check after an await sees what another check may have set meanwhile. */
  const isWrongCluster = (): boolean => cluster === 'wrong-cluster';

  const verifyCluster = async (): Promise<ChainResult<'mainnet-beta'>> => {
    if (cluster === 'wrong-cluster') {
      return fail({ kind: 'wrong-cluster' }); // latched until a restart: nothing is asked again
    }
    const r = await run(calls.genesisHash(), { priority: 'P0', feature: 'boot' }, (x) => bare(decodeGenesisHash(x)), null);
    if (isWrongCluster()) {
      // another check latched while this one was in flight: its answer cannot undo the latch (review Z,
      // security 1; the real governor allows one check per 10 s, so this guards the code, not the timing)
      return fail({ kind: 'wrong-cluster' });
    }
    if (!r.ok) {
      return r;
    }
    if (r.value !== MAINNET_GENESIS_HASH) {
      cluster = 'wrong-cluster';
      emit('chain-wrong-cluster', 'getGenesisHash');
      return fail({ kind: 'wrong-cluster' });
    }
    cluster = 'verified';
    verifiedAtMs = o.mono.nowMs();
    return Object.freeze({ ok: true, value: 'mainnet-beta', contextSlot: null, latencyMs: r.latencyMs });
  };

  const needsClusterCheck = (): boolean => {
    if (cluster === 'wrong-cluster') {
      return false;
    }
    const since = o.mono.nowMs() - verifiedAtMs;
    return cluster === 'unverified' || !(since < CLUSTER_RECHECK_MS);
  };

  const client: ReadClient = {
    provider,
    verifyCluster,
    needsClusterCheck,
    slot: async (opts) => {
      const closed = gate<Slot>(opts);
      if (closed !== null) {
        return closed;
      }
      const sent = mark;
      return run(calls.slot(sent), opts, (x) => {
        const d = decodeSlot(x);
        return d.ok ? { value: d.value, slot: d.value, apiVersion: null } : d;
      }, sent);
    },
    blockHeight: async (opts) => gate<BlockHeight>(opts) ?? run(calls.blockHeight(mark), opts, (x) => bare(decodeBlockHeight(x)), null),
    accounts: async (keys, opts) => {
      const closed = gate<readonly (Account | null)[]>(opts);
      if (closed !== null) {
        return closed;
      }
      const slice = opts.slice ?? null;
      const sent = mark;
      return run(calls.accounts(keys, slice, sent), opts, (x) => withContext(decodeAccounts(x, keys.length, slice)), sent);
    },
    priorityFees: async (writable, opts) => gate<readonly FeeEntry[]>(opts) ?? run(calls.priorityFees(writable), opts, (x) => bare(decodePriorityFees(x)), null),
    rentExemptMinimum: async (dataBytes, opts) => {
      const closed = gate<Lamports>(opts);
      if (closed !== null) {
        return closed;
      }
      const r = await run(calls.rentExemptMinimum(dataBytes), opts, (x) => bare(decodeRent(x)), null);
      if (r.ok && r.value !== rentFormula(dataBytes)) {
        emit('chain-rent-formula', 'getMinimumBalanceForRentExemption'); // the chain is the truth (s.5)
      }
      return r;
    },
  };
  return Object.freeze(client);
}
