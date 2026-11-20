// The engine's one approval authority (STORAGE_DESIGN.md s.16.6; ARCHITECTURE.md s.3; reviews K, N):
// the only call of risk's createApprovalAuthority. It binds the SQLite token store (T2) and the slot
// feed when it is made, so an executor can never hand redeem a store or a slot of its own. The key
// comes from the Rng, is registered as an own secret (no stored or alerted text can then hold it in
// any encoding) before the authority sees it, and the array handed in is wiped once the authority has
// its own copy. Paper only: a live authority is a Phase 8 change with its own review. It hands out
// the issuer (for T1) and the redeemer (for the executor, which never gets the verifier). Only
// app/engine.ts may import this file (the architecture test), so there is one authority per process.
import { HARD_CAPS } from '../config/caps.ts';
import { registerOwnSecret } from '../core/redact.ts';
import type { Rng } from '../core/rng.ts';
import { createApprovalAuthority, type ApprovalIssuer, type ApprovalRedeemer, type SlotSource } from '../risk/approval.ts';
import type { Db } from '../storage/sqlite.ts';
import type { EntryLatch, FaultSink, KillSentinel } from './faults.ts';
import type { Clock } from './slots.ts';
import { createSqliteTokenStore } from './token-store.ts';

export interface EngineAuthority {
  readonly issuer: ApprovalIssuer;
  readonly redeemer: ApprovalRedeemer;
  readonly mode: 'paper';
}

export interface EngineAuthorityOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly slots: SlotSource;
  readonly rng: Rng;
  readonly faults: FaultSink;
  readonly latch: EntryLatch;
  readonly sentinel: KillSentinel;
}

const hasFns = (v: unknown, ...members: string[]): boolean => typeof v === 'object' && v !== null && members.every((m) => typeof (v as Record<string, unknown>)[m] === 'function');

export function createEngineAuthority(o: EngineAuthorityOptions): EngineAuthority {
  const { db, clock, slots, rng, faults, latch, sentinel } = o;
  if (!hasFns(slots, 'currentSlot') || !hasFns(rng, 'approvalKey', 'tokenId')) {
    throw new TypeError('the engine authority needs the slot feed and the Rng');
  }
  const store = createSqliteTokenStore(db, clock, faults, latch, sentinel);
  const key = rng.approvalKey();
  if (!(key instanceof Uint8Array) || key.length < 32 || key.every((b) => b === 0)) {
    throw new TypeError('an approval key of at least 32 bytes, not all zero');
  }
  try {
    registerOwnSecret(key);
    // the one mode is written here as a literal: risk's tests pin that an authority serves its given mode
    const authority = createApprovalAuthority({ mode: 'paper', key, newTokenId: () => rng.tokenId(), planFreshSlots: HARD_CAPS.planFreshSlots, slots, store });
    return Object.freeze({ issuer: authority.issuer, redeemer: authority.redeemer, mode: 'paper' });
  } finally {
    key.fill(0);
  }
}
