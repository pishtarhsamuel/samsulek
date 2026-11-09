// Shared identifiers (ARCHITECTURE.md s.3): the strategy list (decision D1: no copy-trading) and
// the text allowed in internal ids and addresses used as keys.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_IDS, isIdText, isStrategyId } from '../../../src/core/ids.ts';

describe('strategy ids', () => {
  it('knows exactly crowdflow, momentum and launch', () => {
    assert.deepEqual([...STRATEGY_IDS], ['crowdflow', 'momentum', 'launch']);
    assert.ok(Object.isFrozen(STRATEGY_IDS));
    for (const id of STRATEGY_IDS) {
      assert.equal(isStrategyId(id), true);
    }
  });

  it('rejects anything else, copy-trading included', () => {
    for (const bad of ['copy', 'Crowdflow', 'crowdflow ', '', 'toString', 1, null, undefined, {}]) {
      assert.equal(isStrategyId(bad), false, String(bad));
    }
  });
});

describe('id text', () => {
  it('accepts 1-128 characters of A-Z, a-z, 0-9, _ and -', () => {
    for (const ok of ['p1', 'o-1_x', 'So11111111111111111111111111111111111111112', 'a'.repeat(128)]) {
      assert.equal(isIdText(ok), true, ok);
    }
  });

  it('rejects empty, too long, spaces, control characters, path or SQL characters, and non-strings', () => {
    for (const bad of ['', 'a'.repeat(129), 'p 1', 'p1\n', '../x', "x';--", 'p.1', 'mint\u0000', 7, null]) {
      assert.equal(isIdText(bad), false, JSON.stringify(bad));
    }
  });
});
