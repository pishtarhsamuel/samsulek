// T2 inside the token store bound into risk's verifier (STORAGE_DESIGN.md s.16.5.5 and s.15.7): the
// verifier has already checked the token's MAC, its plan and the slot from the bound feed, and hands
// this store only its validated snapshot. One transaction uses the token and records its order, from
// that snapshot and risk's own canonical text, never from the executor's objects (review K). A buy
// token is refused while new entries are stopped: before the database is touched when the entry
// latch is set, KILL was seen or the KILL file is present (which then marks KILL seen); and inside
// the transaction when the database holds KILL, any halt of either mode, the pause or the low-equity
// stop, which another process may have written since the last T1 (review T, risk 3 and security 2;
// RISK_POLICY s.8, invariant 21). An exit token always goes through, so no flag can keep a position
// from being sold. A storage throw is reported to the fault sink and re-thrown; risk's redeem answers
// store-error for any throw. Only app/authority.ts may import this file (the architecture test):
// nothing else can call consume with a slot of its own (review S, security 4).
import type { RedeemSnapshot, TokenStore } from '../risk/approval.ts';
import { canonicalPlan } from '../risk/plan.ts';
import { readFlags, readHalts } from '../storage/repo-flags.ts';
import { redeemApproval } from '../storage/repo-redeem.ts';
import type { Db } from '../storage/sqlite.ts';
import { AppError, classify, type EntryLatch, type FaultSink, type KillSentinel } from './faults.ts';
import type { Clock } from './slots.ts';

const hasFns = (v: unknown, ...members: string[]): boolean => typeof v === 'object' && v !== null && members.every((m) => typeof (v as Record<string, unknown>)[m] === 'function');

export function createSqliteTokenStore(db: Db, clock: Clock, faults: FaultSink, latch: EntryLatch, sentinel: KillSentinel): TokenStore {
  // the handle is only tested, never handed to a helper: it keeps its type (the architecture test)
  if (typeof db !== 'object' || db === null || !hasFns(clock, 'now') || !hasFns(faults, 'report') || !hasFns(latch, 'blocked', 'killSeen', 'markKill') || !hasFns(sentinel, 'present')) {
    throw new TypeError('the token store needs the database, the clock, the fault sink, the entry latch and the KILL sentinel');
  }
  return Object.freeze({
    consume(tokenId: string, snapshot: RedeemSnapshot): boolean {
      const buy = snapshot.kind === 'buy';
      if (buy) {
        const latched = latch.blocked().length > 0;
        const killed = latch.killSeen();
        const file = sentinel.present();
        if (file) {
          latch.markKill();
        }
        if (latched || killed || file) {
          throw new AppError('entries-latched', 'new entries are stopped: no buy token is used');
        }
      }
      const planText = canonicalPlan(snapshot.plan);
      let killStored = false;
      try {
        return db.transaction((tx) => {
          if (buy) {
            const flags = readFlags(tx);
            killStored = flags.kill !== null;
            if (killStored || flags.pausedAt !== null || flags.entriesStopped || readHalts(tx).length > 0) {
              throw new AppError('entries-latched', 'new entries are stopped in the database (KILL, a halt, the pause or the low-equity stop): no buy token is used');
            }
          }
          return redeemApproval(tx, tokenId, snapshot, planText, clock.now());
        });
      } catch (e) {
        if (killStored) {
          latch.markKill();
        }
        faults.report(buy ? 't2' : 't2-exit', classify(e));
        throw e;
      }
    },
  });
}
