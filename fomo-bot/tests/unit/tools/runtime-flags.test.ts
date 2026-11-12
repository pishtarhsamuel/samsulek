// The test processes (and later the bot) run with --disallow-code-generation-from-strings, so
// eval and the Function constructor throw: text built at runtime can never become code. The
// architecture test bans "constructor", eval and Function by syntax, but syntax cannot catch a
// name assembled from pieces; this flag can (security-auditor, REVIEWS.md entry G).
// Run through `npm test` or `npm run test:coverage`, which set the flag.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('runtime flags', () => {
  it('CANARY: code generation from strings is disabled in test processes', () => {
    const key = ['constr', 'uctor'].join(''); // what a syntax check cannot see
    const functionFromText = (() => 0)[key as 'constructor'] as unknown as (code: string) => () => unknown;
    assert.throws(() => functionFromText('return 1'), EvalError);
    const indirectEval = eval;
    assert.throws(() => indirectEval('1 + 1'), EvalError);
  });

  it('CANARY: built-in prototypes are frozen, so code cannot patch Array, Object or JSON (--frozen-intrinsics)', () => {
    assert.equal(Object.isFrozen(Array.prototype), true);
    assert.equal(Object.isFrozen(Object.prototype), true);
    assert.equal(Object.isFrozen(JSON), true);
    assert.throws(() => {
      (Array.prototype as unknown as { every: unknown }).every = () => true;
    }, TypeError);
    assert.throws(() => {
      (JSON as unknown as { stringify: unknown }).stringify = () => '';
    }, TypeError);
  });
});
