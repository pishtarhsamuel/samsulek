// The real clocks and timers (docs/CHAIN_DESIGN.md s.2 and s.3; RISK_POLICY contract 8): the one file
// that reads the wall clock and the monotonic clock and starts timers. Only cli/ may import it at
// runtime (the architecture test), and it hands these in, so every other file takes the interfaces and
// its tests stay deterministic. The engine's clock for decisions is the guarded one (app/time-guard.ts,
// step 7g), never systemWall directly.

/** UTC milliseconds since the epoch: the shape of app/slots.ts's Clock. */
export interface WallClock {
  now(): number;
}

/** Monotonic milliseconds: never goes back, unrelated to the date. For timeouts and rates. */
export interface MonoClock {
  nowMs(): number;
}

export interface Timers {
  /** A signal that aborts after `ms` with a TimeoutError. */
  timeoutSignal(ms: number): AbortSignal;
  /** Runs `fn` once after `ms`; the returned function cancels it (a second cancel does nothing). */
  after(ms: number, fn: () => void): () => void;
}

/** Node's timers take at most 2^31 - 1 ms; a longer one would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function timerMs(ms: number): number {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIMER_MS) {
    throw new TypeError(`a timer takes whole milliseconds from 0 to ${MAX_TIMER_MS}`);
  }
  return ms;
}

export const systemWall: WallClock = Object.freeze({ now: (): number => Date.now() });

export const systemMono: MonoClock = Object.freeze({ nowMs: (): number => performance.now() });

export const systemTimers: Timers = Object.freeze({
  timeoutSignal: (ms: number): AbortSignal => AbortSignal.timeout(timerMs(ms)),
  after: (ms: number, fn: () => void): (() => void) => {
    const timer = setTimeout(fn, timerMs(ms));
    return (): void => {
      clearTimeout(timer);
    };
  },
});
