// The canonical plan text as storage reads it (STORAGE_DESIGN.md s.15.3). Storage may not import
// risk at runtime, so app/ passes risk's own canonicalPlan(plan); storage checks that the text is
// exactly that canonical form (keys sorted as risk sorts them, no spaces, jsonParam's own form, the
// secret filter), reads the fields it binds, and hashes those exact bytes. A hash equal to the one
// sealed in the token then means the same text, so the stored plan is the plan risk approved.
// Written before src/storage/plan-text.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { secretKinds } from '../../../src/core/redact.ts';
import { U64_MAX } from '../../../src/core/units.ts';
import { PLAN_FIELDS, canonicalPlan, planHash } from '../../../src/risk/plan.ts';
import * as planTextFile from '../../../src/storage/plan-text.ts';
import { ORDER_KINDS, PLAN_FIELD_NAMES, planRecordOf } from '../../../src/storage/plan-text.ts';
import { SCHEMA_V1_COPIES } from '../../../src/storage/schema-v1.ts';
import { storageError } from './helpers.ts';
import { BUY, CLOSE, SELL, largestPlan } from './money-fixtures.ts';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The detail of a refusal never repeats the text, nor a value from it. */
function refused(text: string, why: RegExp = /./): void {
  const e = storageError(() => planRecordOf(text), 'bad-param');
  assert.match(e.detail, why);
  assert.ok(!e.detail.includes('MintA') && !e.detail.includes('order-1') && !e.detail.includes('{'), e.detail);
}

describe('the plan text file: only what it may do', () => {
  it('exports the plan record reader and its two lists, and nothing else: a new export here is a reviewed change', () => {
    assert.deepEqual(Object.keys(planTextFile).sort(), ['ORDER_KINDS', 'PLAN_FIELD_NAMES', 'planRecordOf']);
  });

  it('its field names are risk/plan.ts PLAN_FIELDS, and its order kinds the schema\'s (withdraw has its own path)', () => {
    assert.deepEqual([...PLAN_FIELD_NAMES], [...PLAN_FIELDS]);
    assert.deepEqual([...ORDER_KINDS], [...SCHEMA_V1_COPIES.orderKinds]);
    assert.ok(Object.isFrozen(PLAN_FIELD_NAMES) && Object.isFrozen(ORDER_KINDS));
  });
});

describe('a canonical plan text: the exact text risk hashed, the fields storage binds, and storage\'s own hash', () => {
  it('reads a buy, a sell and a close: the text unchanged, the hash planHash\'s, the bound fields the plan\'s', () => {
    for (const plan of [BUY, SELL, CLOSE]) {
      const text = canonicalPlan(plan);
      const rec = planRecordOf(text);
      assert.equal(rec.text, text);
      assert.equal(rec.hash, planHash(plan));
      assert.equal(rec.hash, sha256(text));
      assert.deepEqual(
        [rec.orderId, rec.intentId, rec.positionId, rec.mode, rec.kind, rec.mint, rec.inAmount, rec.minOut, rec.quoteSlot],
        [plan.orderId, plan.intentId, plan.positionId, plan.mode, plan.kind, plan.mint, plan.inAmount, plan.minOut, plan.quoteSlot],
      );
      assert.ok(Object.isFrozen(rec));
    }
  });

  it('the largest buy, sell and close plans pass, well inside the 8 KiB of a JSON column, and the secret filter finds nothing in them (s.12.1)', () => {
    for (const kind of ['buy', 'sell', 'close-account'] as const) {
      const plan = largestPlan(kind);
      const text = canonicalPlan(plan);
      assert.ok(text.length > 1_000 && text.length < 1_400, `the largest ${kind} plan is ${text.length} characters`);
      assert.deepEqual(secretKinds(text), []);
      const rec = planRecordOf(text);
      assert.equal(rec.hash, planHash(plan));
      assert.equal(rec.inAmount, U64_MAX);
    }
  });

  it('refuses anything but a string of one plan\'s canonical text, at most 8,192 characters, and never repeats it', () => {
    for (const bad of [5, null, undefined, {}, ['x']]) {
      storageError(() => planRecordOf(bad as unknown as string), 'bad-param');
    }
    refused('not json');
    refused('[]');
    refused('"plan"');
    refused('null');
    refused(`${canonicalPlan(BUY)} `);
    refused(' '.repeat(8_193));
  });

  it('refuses the same plan in any other text: spaces, unsorted keys, unsorted tip keys, an amount as a number', () => {
    const text = canonicalPlan(BUY);
    refused(text.replace(',"closeAccountAfter"', ', "closeAccountAfter"'), /canonical/);
    refused(JSON.stringify(BUY, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString(10) : v)), /canonical/); // the plan's own key order
    refused(text.replace('"tip":{"lamports":"1000","path":"jito"}', '"tip":{"path":"jito","lamports":"1000"}'), /canonical/);
    refused(text.replace('"inAmount":"55000000"', '"inAmount":55000000'), /amount/);
    refused(text.replace('"quoteSlot":"1000"', '"quoteSlot":"01000"'), /amount/);
  });

  it('refuses a missing, an extra or a renamed key, and a tip of any other shape', () => {
    const text = canonicalPlan(BUY);
    refused(text.replace('"attempts":3,', ''), /canonical/);
    refused(`${text.slice(0, -1)},"zzExtra":1}`, /canonical/); // still sorted, one key too many
    refused(text.replace('"wallet":"OurWallet"', '"walletX":"OurWallet"'), /canonical/);
    refused(text.replace('"tip":{"lamports":"1000","path":"jito"}', '"tip":"jito"'), /canonical/);
    refused(text.replace('"tip":{"lamports":"1000","path":"jito"}', '"tip":{"lamports":"1000"}'), /canonical/);
  });

  it('refuses a withdraw (it has its own path) and values the bound fields cannot take', () => {
    refused(canonicalPlan({ ...BUY, kind: 'withdraw' }), /kind/);
    const text = canonicalPlan(BUY);
    refused(text.replace('"mode":"paper"', '"mode":"demo"'), /mode/);
    refused(text.replace('"inAmount":"55000000"', `"inAmount":"${U64_MAX + 1n}"`), /amount/);
    refused(text.replace('"quoteSlot":"1000"', `"quoteSlot":"${2n ** 63n}"`), /slot/);
    refused(text.replace('"positionId":"p1"', '"positionId":"p 1"'), /canonical|id/);
  });

  it('refuses an id of 64 characters or one with a credential word in it: the secret filter reads every plan text', () => {
    refused(canonicalPlan({ ...BUY, orderId: 'o'.repeat(64) }));
    refused(canonicalPlan({ ...BUY, positionId: 'mysecretpos' }));
    assert.equal(planRecordOf(canonicalPlan({ ...BUY, orderId: 'o'.repeat(63) })).orderId, 'o'.repeat(63));
  });

  it('hashes exactly the text it was given: a plan the text does not encode cannot get its hash', () => {
    const text = canonicalPlan(BUY);
    const other = canonicalPlan({ ...BUY, minOut: BUY.minOut - 1n });
    assert.notEqual(planRecordOf(other).hash, planHash(BUY));
    assert.equal(planRecordOf(text).hash, planHash(BUY));
  });
});
