// What chain/ tells the app (docs/CHAIN_DESIGN.md s.3): codes only, the provider's code, a method name
// and a priority, never a URL, a header, a node message or an error object. The app maps them to its
// alert sink, rate-limited (chain/ cannot import app/). Each producer wraps every call of `event` so a
// failing sink never stops a read. Types only.
import type { Priority, ProviderId, ReadMethod } from './limits.ts';

export type ChainEventCode =
  | 'chain-429'
  | 'chain-blocked'
  | 'chain-unblocked'
  | 'chain-shed-up'
  | 'chain-shed-down'
  | 'chain-budget-80'
  | 'chain-p0-denied'
  | 'chain-limit-learned'
  | 'chain-wrong-cluster'
  | 'chain-api-version'
  | 'chain-shape'
  | 'chain-our-bug'
  | 'chain-stale'
  | 'chain-rent-formula'
  | 'chain-ticket-bug'
  | 'chain-ws-up'
  | 'chain-ws-down'
  | 'chain-ws-stall'
  | 'chain-ws-flapping'
  | 'chain-ws-oversize'
  | 'chain-ws-unknown-sub'
  | 'chain-time-none';

export interface ChainEvent {
  readonly code: ChainEventCode;
  readonly provider: ProviderId;
  readonly method?: ReadMethod;
  readonly priority?: Priority;
  /** Only when it matches /^[0-9]{1,4}(\.[0-9]{1,4}){2}$/ (s.8). */
  readonly apiVersion?: string;
}

export interface ChainEvents {
  event(e: ChainEvent): void;
}
