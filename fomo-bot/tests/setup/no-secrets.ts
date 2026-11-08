// Loaded with `node --import` before every test file, and inherited by child processes.
// Marks the process so that the secrets loader (src/config/secrets.ts) refuses to run: no test
// and no command Claude runs can load the owner's secret files (THREAT_MODEL.md s.4, like the
// root project's no_side_effects fixture).
export const SECRETS_FORBIDDEN = Symbol.for('fomo-bot.secrets-forbidden');

(globalThis as Record<symbol, unknown>)[SECRETS_FORBIDDEN] = true;
