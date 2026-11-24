// Lossless JSON for the chain clients (docs/CHAIN_DESIGN.md s.3; VERIFIED_FACTS s.9): Solana's answers
// carry u64 integers (lamports, rentEpoch, slots, fees) that a plain JSON.parse rounds above 2^53, so
// every number whose source text is plain digits becomes an exact bigint, through JSON.parse's
// source-text reviver (Node 26.13.0, verified in the research). Any other spelling of a number (1e3,
// 1.50, -0) stays a JS number, which no integer field of a decoder accepts: never a guess. Nesting
// deeper than JSON_MAX_DEPTH is refused before the parse. Everything parsed is frozen. Pure.

export type Json = null | boolean | string | number | bigint | readonly Json[] | { readonly [key: string]: Json };

/** The deepest nesting either function takes: an RPC answer nests about ten deep. */
export const JSON_MAX_DEPTH = 64;

/** Plain digits: what becomes a bigint ("-0" is excluded separately: it is a float's sign). */
const CANONICAL_INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPENERS = new Set([0x5b, 0x7b]); // [ {
const CLOSERS = new Set([0x5d, 0x7d]); // ] }

/** True when the text's arrays and objects nest deeper than JSON_MAX_DEPTH (brackets inside strings are text). */
function nestsTooDeep(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === BACKSLASH) {
        i += 1; // the escaped character is text
      } else if (c === QUOTE) {
        inString = false;
      }
    } else if (c === QUOTE) {
      inString = true;
    } else if (OPENERS.has(c)) {
      depth += 1;
      if (depth > JSON_MAX_DEPTH) {
        return true;
      }
    } else if (CLOSERS.has(c)) {
      depth -= 1;
    }
  }
  return false;
}

/** What JSON.parse hands a reviver for a primitive value: its source text. */
interface ReviverContext {
  readonly source?: string;
}

function revive(this: unknown, _key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value === 'number') {
    const source = context?.source;
    return typeof source === 'string' && source !== '-0' && CANONICAL_INTEGER.test(source) ? BigInt(source) : value;
  }
  // children are revived before their holder, so freezing the holder here never blocks a child's write
  return value !== null && typeof value === 'object' ? Object.freeze(value) : value;
}

/** JSON.parse, with plain-digit numbers as exact bigints and every array and object frozen. */
export function parseLossless(text: string): Json {
  if (typeof text !== 'string') {
    throw new TypeError('parseLossless takes a string');
  }
  // checked before the parse, so the reviver's walk (recursive in V8) never nests deeper than 64
  if (nestsTooDeep(text)) {
    throw new SyntaxError(`JSON nested deeper than ${JSON_MAX_DEPTH}`);
  }
  return JSON.parse(text, revive) as Json;
}

function write(v: unknown, depth: number): string {
  if (v === null) {
    return 'null';
  }
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return v.toString();
    case 'number':
      if (!Number.isFinite(v)) {
        throw new TypeError('JSON has no NaN or infinity (JSON.stringify would write null)');
      }
      return JSON.stringify(v);
    case 'string':
      return JSON.stringify(v);
    case 'object': {
      if (depth >= JSON_MAX_DEPTH) {
        throw new TypeError(`JSON nested deeper than ${JSON_MAX_DEPTH}`);
      }
      if (Array.isArray(v)) {
        return `[${Array.from(v, (x: unknown) => write(x, depth + 1)).join(',')}]`; // a hole is undefined: refused
      }
      const proto: unknown = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('JSON objects are plain objects');
      }
      const o = v as Readonly<Record<string, unknown>>;
      return `{${Object.keys(o).map((k) => `${JSON.stringify(k)}:${write(o[k], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JSON has no ${typeof v}`);
  }
}

/** JSON text with bigints as plain digits; refuses what JSON.stringify would drop or rewrite. */
export function stringifyLossless(v: Json): string {
  return write(v, 0);
}
