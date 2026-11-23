// The jump confirmation (STORAGE_DESIGN.md s.17.5.2; C41; contract 3 of RISK_POLICY.md): a +50%
// rise within an hour is held in the day state until the verification routine confirms it from a
// fresh, fully valued read (never the held observation). In one locked step: the clock read once, the
// stored day state and the paper policy, risk/daystate.ts confirmEquityJump (the lower of the verified
// and the held level is the reference, at most 5 minutes after the hold, never before it), and the one
// day-state write. It reads no flag, halt or KILL, so it works while halted (C41). A refusal writes
// nothing and sets no halt: the hold keeps blocking entries, which fails closed. Any other failure but
// busy is the day-state-error halt, as in the observation. Only cli/ may import this file (the
// architecture test): no strategy, Telegram or AI path can clear a hold (contract 3); Phase 3 adds the
// verification routine by name.
import { lamports, type Lamports } from '../core/units.ts';
import { confirmEquityJump } from '../risk/daystate.ts';
import { RiskError } from '../risk/reserve.ts';
import { readAccount } from '../storage/repo-book.ts';
import { readDayState, writeDayState } from '../storage/repo-day.ts';
import { alertSafely, persistHaltTx } from './approve-tx.ts';
import { dayPolicyOf } from './caps.ts';
import { DAY_STATE_ERROR_HALT, type DayDeps } from './day-tx.ts';
import { classify, type FaultScope } from './faults.ts';
import { readActiveConfig } from './snapshot.ts';

export type ConfirmOutcome =
  | { readonly kind: 'confirmed'; readonly at: number; readonly ackEquity: Lamports }
  /** confirmEquityJump refused (no hold, outside its window, above the sanity limits): the hold stays. */
  | { readonly kind: 'refused'; readonly code: 'error:risk' }
  | { readonly kind: 'not-run'; readonly code: 'clock-untrusted' }
  | { readonly kind: 'error'; readonly code: string; readonly scope: FaultScope; readonly halt: 'set' | 'already' | 'failed' | 'not-tried' };

const NOT_RUN: ConfirmOutcome = Object.freeze({ kind: 'not-run', code: 'clock-untrusted' });
const REFUSED: ConfirmOutcome = Object.freeze({ kind: 'refused', code: 'error:risk' });

/** Contract 3: the verification routine's fresh, fully valued read clears a held jump. Never throws. */
export function confirmJumpTx(deps: DayDeps, verifiedEquity: Lamports): ConfirmOutcome {
  let outcome: ConfirmOutcome;
  try {
    const level = lamports(verifiedEquity); // before BEGIN: a value that is not lamports is error:amount
    outcome = deps.db.transaction((tx) => {
      const at = deps.clock.now();
      if (!deps.time.trusted(at)) {
        return NOT_RUN;
      }
      const state = readDayState(tx, 'paper');
      const { tunables } = readActiveConfig(tx);
      const next = confirmEquityJump(state, level, at, dayPolicyOf('paper', tunables, readAccount(tx, 'paper')));
      writeDayState(tx, 'paper', next, at); // its guard accepts exactly this move (repo-day.ts)
      // confirmEquityJump always sets the reference it returns
      return Object.freeze({ kind: 'confirmed', at, ackEquity: (next.jumpAck as { readonly equity: Lamports }).equity });
    });
  } catch (e) {
    if (e instanceof RiskError) {
      alertSafely(deps.alerts, deps.latch, { code: 'jump-confirm-refused', severity: 'warn' });
      return REFUSED; // a refusal, not a fault: the hold keeps blocking entries
    }
    const f = classify(e);
    deps.faults.report('jump', f);
    if (f.busy) {
      return Object.freeze({ kind: 'error', code: f.code, scope: f.scope, halt: 'not-tried' });
    }
    const halt = persistHaltTx(deps, DAY_STATE_ERROR_HALT);
    alertSafely(deps.alerts, deps.latch, { code: 'day-state-error', severity: 'bug', codes: [f.code] });
    return Object.freeze({ kind: 'error', code: f.code, scope: f.scope, halt });
  }
  if (outcome.kind === 'confirmed') {
    alertSafely(deps.alerts, deps.latch, { code: 'equity-jump-confirmed', severity: 'info' });
  }
  return outcome;
}
