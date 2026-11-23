// The paper engine's start (STORAGE_DESIGN.md s.16.6; conditions C1, C7, C13, C21, C64, C65 and review
// T's conditions for 6d-3), the process's composition root for storage and approvals:
// 1. the inputs are checked (a TypeError) and the slot feed is made, before anything touches a file;
// 2. bootStorage (app/storage-boot.ts) runs every start-up check, with the KILL file and the audit
//    anchor of the run folder; its refusal (a BootError, the database already closed) comes through;
// 3. on the boot's latch (KILL already marked when it is on): the fault sink, whose disk trouble
//    stores the disk-db halt and whose first fatal fault calls the caller's onFatal; exactly one paper
//    authority, bound to the database and the one slot feed, its mode asserted (C64); the deps the
//    app/ transactions need; and the redeemer, the only thing the executor gets (C65).
// Any throw after the boot closes the database and alerts. Paper only: there is no live start here,
// and Phase 8 adds one with its own review. Only cli/ may import this file (the architecture test),
// and nothing in cli/ starts it yet (a later step, with the run lock of the ops step).
import path from 'node:path';
import type { Rng } from '../core/rng.ts';
import type { ApprovalRedeemer } from '../risk/approval.ts';
import { persistHaltTx, type BreakerSource, type EngineDeps, type MarkReader, type PaperIdentity, type RentSource, type StoreDeps } from './approve-tx.ts';
import { createEngineAuthority } from './authority.ts';
import { createExitWatch } from './exit-watch.ts';
import { createFaultSink, type AlertSink } from './faults.ts';
import { createAnchorFile, createKillSentinel } from './run-files.ts';
import { createSlotFeed, type Clock, type SlotFeed, type SlotFeedOptions } from './slots.ts';
import { bootStorage, type BootOptions, type BootReport } from './storage-boot.ts';

export interface PaperEngineOptions {
  /** The boot's options but the four the engine makes or shares: the clock, the alerts, the KILL file and the anchor. */
  readonly boot: Omit<BootOptions, 'clock' | 'alerts' | 'sentinel' | 'anchors'>;
  readonly clock: Clock;
  /** systemRng from cli/; tests pass their own. */
  readonly rng: Rng;
  readonly alerts: AlertSink;
  readonly marks: MarkReader;
  readonly rent: RentSource;
  readonly breakers: BreakerSource;
  readonly identity: PaperIdentity;
  readonly slotOptions: Omit<SlotFeedOptions, 'clock' | 'alerts'>;
  /** The run loop's exit (a later step): called once, for the first fatal fault. */
  readonly onFatal: (code: string) => void;
}

export interface PaperEngine {
  /** For the app/ transactions (T1, the small writes). */
  readonly deps: EngineDeps;
  /** For the executor: redeem only, never the issuer or the verifier (review N security 2, C65). */
  readonly redeemer: ApprovalRedeemer;
  /** The chain clients report the slot here (a later step); the deps and the authority read it. */
  readonly slotFeed: SlotFeed;
  readonly ids: { positionId(): string; orderId(): string };
  readonly report: BootReport;
  /** Closes the database; a second call does nothing. */
  close(): void;
}

const hasFns = (v: unknown, ...members: readonly string[]): boolean =>
  typeof v === 'object' && v !== null && members.every((m) => typeof (v as Record<string, unknown>)[m] === 'function');
const isText = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

/**
 * C64: the authority the engine made serves paper and can issue. createEngineAuthority writes the mode
 * as a literal, so this only fails if that file changes; it is exported so its refusals are tested.
 */
export function assertPaperAuthority(a: { readonly issuer: unknown; readonly redeemer: unknown }): void {
  const { issuer, redeemer } = a;
  if (!hasFns(issuer, 'issue') || !hasFns(redeemer, 'redeem') || (redeemer as { readonly mode?: unknown }).mode !== 'paper') {
    throw new TypeError('the paper engine needs one paper authority with an issuer and a redeemer');
  }
}

export function startPaperEngine(o: PaperEngineOptions): PaperEngine {
  const { clock, rng, alerts, marks, rent, breakers, identity, slotOptions, onFatal } = o; // each read once
  const boot = typeof o.boot === 'object' && o.boot !== null ? { ...o.boot } : null;
  if (
    typeof onFatal !== 'function' ||
    !hasFns(rng, 'approvalKey', 'tokenId', 'positionId', 'orderId') ||
    !hasFns(clock, 'now') ||
    !hasFns(alerts, 'alert') ||
    !hasFns(marks, 'marks') ||
    !hasFns(rent, 'wsolHelperRent') ||
    !hasFns(breakers, 'breakers') ||
    !hasFns(identity, 'tokenAccountOf') ||
    !isText(identity.wallet) ||
    !isText(identity.wsolMint) ||
    boot === null ||
    typeof boot.dataDir !== 'string' ||
    typeof boot.runDir !== 'string'
  ) {
    throw new TypeError('the paper engine needs onFatal, an Rng, a clock, the alerts, the marks, the rent, the breakers, the paper identity and the boot options');
  }
  const slotFeed = createSlotFeed({ ...slotOptions, clock, alerts }); // bad slot options throw here, before the boot
  // the boot checks that runDir is a plain name inside the data folder before either file is touched
  const runDir = path.join(boot.dataDir, boot.runDir);
  const sentinel = createKillSentinel(runDir);
  const anchors = createAnchorFile(runDir);
  const booted = bootStorage({ ...boot, clock, alerts, sentinel, anchors });
  const { db, latch } = booted;
  try {
    // a disk fault or a busy storm stores the disk-db halt; persistHaltTx never reports its own
    // failure back here (review T), so a full disk asks for the halt once per fault, not without end
    const faults = createFaultSink({ latch, alerts, clock, onFatal, onDiskTrouble: () => void persistHaltTx(store, 'disk-db') });
    const store: StoreDeps = Object.freeze({ db, clock, slots: slotFeed, latch, faults, alerts, anchors });
    const authority = createEngineAuthority({ db, clock, slots: slotFeed, rng, faults, latch, sentinel });
    assertPaperAuthority(authority);
    const deps: EngineDeps = Object.freeze({
      mode: 'paper',
      db,
      clock,
      slots: slotFeed,
      issuer: authority.issuer,
      marks,
      rent,
      breakers,
      identity,
      sentinel,
      latch,
      faults,
      alerts,
      exitWatch: createExitWatch({ alerts, clock, latch }),
      anchors,
    });
    const ids = Object.freeze({ positionId: (): string => rng.positionId(), orderId: (): string => rng.orderId() });
    return Object.freeze({ deps, redeemer: authority.redeemer, slotFeed, ids, report: booted.report, close: (): void => db.close() });
  } catch (e) {
    db.close();
    try {
      alerts.alert(Object.freeze({ code: 'engine-start-failed', severity: 'fatal' }));
    } catch {
      // the start is refused below either way
    }
    throw e;
  }
}
