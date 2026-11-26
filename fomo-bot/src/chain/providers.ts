// The providers chain/ reads from (docs/CHAIN_DESIGN.md s.3, s.8 and s.9): today only the public
// mainnet endpoint, with no key (owner decision D3: no Helius until it confirms in writing), and the
// mainnet-beta genesis hash the client checks before any other read (VERIFIED_FACTS s.9: from a live
// call and from ClusterType::MainnetBeta in solana-cluster-type 3.2.1). A provider with a key lists every
// secret part of its URL in `secretParts`; the transport registers each as the bot's own secret and
// refuses a URL with any other query value. Pure.
import type { ProviderId } from './limits.ts';

export interface ProviderEndpoint {
  readonly id: ProviderId;
  /** https only, no user name or password, no fragment (checked by chain/http.ts). */
  readonly httpUrl: string;
  /** wss only (checked by chain/ws-socket.ts, step 7f). */
  readonly wsUrl: string;
  /** Every query value of the URLs: each registered as an own secret (16 to 1,024 characters). */
  readonly secretParts: readonly string[];
}

export const PUBLIC_MAINNET: ProviderEndpoint = Object.freeze({
  id: 'public-mainnet',
  httpUrl: 'https://api.mainnet-beta.solana.com',
  wsUrl: 'wss://api.mainnet-beta.solana.com/',
  secretParts: Object.freeze([]),
});

/** Mainnet-beta's genesis hash: a different one is another cluster (s.8), never a reason to read on. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
