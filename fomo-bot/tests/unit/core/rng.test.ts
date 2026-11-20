// Randomness in one place (STORAGE_DESIGN.md s.16.7.1): the per-boot approval key and the random ids
// of tokens, positions and orders. A key is 32 bytes, never all zero, a new array each time; an id is
// a prefix and 32 hex characters (35 in all, below the 64 the secret filter would refuse), drawn again
// while the filter refuses it (a registered own secret inside it), and at most 8 times. Ids are
// independent of the key and of every MAC: they come from their own random bytes. Written before
// src/core/rng.ts. This file registers own secrets: it runs in its own process (node:test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base58Of, base64UrlOf, hexOf } from '../../../src/core/encode.ts';
import { isIdText } from '../../../src/core/ids.ts';
import { registerOwnSecret } from '../../../src/core/redact.ts';
import * as rngFile from '../../../src/core/rng.ts';
import { RngError, drawId, drawKey, idFromBytes, keyFromBytes, newApprovalKey, newId, systemRng, type IdKind } from '../../../src/core/rng.ts';

const SHAPE: Readonly<Record<IdKind, RegExp>> = { token: /^tk_[0-9a-f]{32}$/, position: /^ps_[0-9a-f]{32}$/, order: /^or_[0-9a-f]{32}$/ };

function rngError(fn: () => unknown, code: RngError['code']): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RngError, `expected an RngError, got ${String(caught)}`);
  assert.equal(caught.code, code);
}

describe('the randomness file: only what it may do', () => {
  it('exports the key and id makers, their test doors and the error, and nothing else', () => {
    assert.deepEqual(Object.keys(rngFile).sort(), ['RngError', 'drawId', 'drawKey', 'idFromBytes', 'keyFromBytes', 'newApprovalKey', 'newId', 'systemRng']);
  });
});

describe('the approval key', () => {
  it('32 bytes, a plain array of its own, a new one each call, never all zero', () => {
    const a = newApprovalKey();
    const b = newApprovalKey();
    assert.equal(a.length, 32);
    assert.equal(Object.getPrototypeOf(a), Uint8Array.prototype); // not a pooled Buffer
    assert.notEqual(a, b);
    assert.notDeepEqual([...a], [...b]);
    assert.ok(a.some((x) => x !== 0));
    const c = systemRng.approvalKey();
    assert.equal(c.length, 32);
    assert.notDeepEqual([...c], [...a]);
  });

  it('keyFromBytes: exactly 32 bytes, not all zero, copied; anything else is null', () => {
    const raw = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
    const key = keyFromBytes(raw);
    assert.ok(key !== null);
    assert.notEqual(key, raw);
    assert.deepEqual([...key], [...raw]);
    for (const bad of [new Uint8Array(31).fill(1), new Uint8Array(33).fill(1), new Uint8Array(32), 'x'.repeat(32), null, [1, 2]]) {
      assert.equal(keyFromBytes(bad as unknown as Uint8Array), null);
    }
  });

  it('drawKey: an all-zero draw is drawn once more; two in a row throw rng-zero-key; each draw is wiped after its copy', () => {
    const draws: Uint8Array[] = [];
    const key = drawKey(() => {
      const next = draws.length === 0 ? new Uint8Array(32) : Uint8Array.from({ length: 32 }, (_v, i) => 200 - i);
      draws.push(next);
      return next;
    });
    assert.equal(draws.length, 2);
    assert.deepEqual([...key], Array.from({ length: 32 }, (_v, i) => 200 - i));
    assert.ok(draws.every((d) => d.every((x) => x === 0)), 'the source arrays are zeroed');
    let n = 0;
    rngError(
      () =>
        drawKey(() => {
          n += 1;
          return new Uint8Array(32);
        }),
      'rng-zero-key',
    );
    assert.equal(n, 2);
    rngError(() => drawKey(() => new Uint8Array(16).fill(3)), 'rng-zero-key'); // a short draw is no key either
  });
});

describe('ids: a prefix and 32 hex characters, independent of the key', () => {
  it('each kind has its shape, 35 characters, passes isIdText, and 1,000 draws are all different', () => {
    for (const kind of ['token', 'position', 'order'] as const) {
      const seen = new Set<string>();
      for (let i = 0; i < 1_000; i += 1) {
        const id = newId(kind);
        assert.match(id, SHAPE[kind]);
        assert.equal(id.length, 35);
        assert.ok(isIdText(id));
        seen.add(id);
      }
      assert.equal(seen.size, 1_000);
    }
    assert.match(systemRng.tokenId(), SHAPE.token);
    assert.match(systemRng.positionId(), SHAPE.position);
    assert.match(systemRng.orderId(), SHAPE.order);
    assert.ok(Object.isFrozen(systemRng));
  });

  it("no id ever holds the key's encodings (the key's forms are longer than an id, and ids come from their own bytes)", () => {
    const key = newApprovalKey();
    registerOwnSecret(key);
    const forms = [hexOf(key), base64UrlOf(key), base58Of(key)];
    for (let i = 0; i < 1_000; i += 1) {
      const id = systemRng.tokenId();
      assert.ok(forms.every((f) => !f.includes(id.slice(3)) && !id.includes(f)));
    }
  });

  it('idFromBytes: exactly 16 bytes; null when the secret filter refuses the id (a registered own secret inside it)', () => {
    const plain = Uint8Array.from({ length: 16 }, (_v, i) => i);
    assert.equal(idFromBytes('order', plain), `or_${hexOf(plain)}`);
    registerOwnSecret('deadbeefdeadbeef'); // a fake 16-character secret that hex can spell
    const spelled = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(idFromBytes('token', spelled), null);
    for (const bad of [new Uint8Array(15), new Uint8Array(17), 'x'.repeat(16), null]) {
      rngError(() => idFromBytes('token', bad as unknown as Uint8Array), 'rng-bad-bytes');
    }
    rngError(() => idFromBytes('wallet' as IdKind, plain), 'rng-bad-bytes');
  });

  it('drawId: the first draw the filter passes; 8 refused draws throw rng-filter (fail closed)', () => {
    registerOwnSecret('deadbeefdeadbeef'); // as above (registering it again adds nothing)
    const refused = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 9, 9, 9, 9, 9, 9, 9, 9]);
    const good = Uint8Array.from({ length: 16 }, (_v, i) => 100 + i);
    let n = 0;
    const id = drawId('position', () => {
      n += 1;
      return n < 3 ? refused : good;
    });
    assert.equal(n, 3);
    assert.equal(id, `ps_${hexOf(good)}`);
    let m = 0;
    rngError(
      () =>
        drawId('token', () => {
          m += 1;
          return refused;
        }),
      'rng-filter',
    );
    assert.equal(m, 8);
  });
});
