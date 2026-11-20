// The bot's run folder (STORAGE_DESIGN.md s.16.3 and s.16.6; review T's conditions for 6d-3). Two
// small files, and the real file-system probe of the boot:
// - the KILL file: the owner creates `<run>/KILL` at the server, and its mere presence stops new
//   entries (C25). Any doubt reads as present: every error but "no such file" (fail closed);
// - the audit anchor `<run>/audit-anchor.json`: the newest audit row's id, hash and time, written
//   after the boot and after each KILL and halt the engine sets, so the next boot finds a log that was
//   cut short or an older copy of the database (C36). It is written 0600 to a temp file and renamed
//   over the old one (atomic on Linux: VERIFIED_FACTS V5; Windows UNVERIFIED), and read back strictly:
//   anything malformed throws, never a guess. It is a tripwire, not a lock: someone who can edit both
//   files can make them agree (s.16.11 D10);
// - nodeFsProbe: lstat (with the link count, for the hard-link check), realpath, the file-system
//   type (statfsSync on Linux; VERIFIED_FACTS V1) and chmod, for the boot's path checks.
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KillSentinel } from './faults.ts';

export const KILL_FILE = 'KILL';
export const ANCHOR_FILE = 'audit-anchor.json';

export interface AuditAnchor {
  readonly id: number;
  readonly hash: string;
  /** The row's own time (UTC ms). */
  readonly at: number;
}

export interface AnchorStore {
  /** null when there is no anchor file; a malformed one throws. */
  read(): AuditAnchor | null;
  write(a: AuditAnchor): void;
}

/** What the boot asks of the file system (node:fs in the bot; fakes in tests, for the Windows cases on Linux). */
export interface FsProbe {
  /** null when the path does not exist; any other error throws. */
  lstat(p: string): { readonly isSymbolicLink: boolean; readonly isDirectory: boolean; readonly mode: number; readonly uid: number; readonly nlink: number } | null;
  realpath(p: string): string;
  /** statfsSync(p).type on Linux; null elsewhere. */
  fsType(p: string): number | null;
  chmod(p: string, mode: number): void;
}

const MAX_ANCHOR_ID = Number.MAX_SAFE_INTEGER;
const HASH = /^[0-9a-f]{64}$/;
const MAX_TIME_MS = 7_258_118_400_000; // core/time.ts MAX_TIMESTAMP_MS: the year 2200

const errnoOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { readonly code?: unknown }).code : undefined);

function checked(v: unknown): AuditAnchor {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new TypeError('the audit anchor is an object of id, hash and at');
  }
  const keys = Object.keys(v).sort();
  const { id, hash, at } = v as { readonly id?: unknown; readonly hash?: unknown; readonly at?: unknown };
  if (keys.join(',') !== 'at,hash,id' || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > MAX_ANCHOR_ID) {
    throw new TypeError('the audit anchor has exactly an id (a whole number of at least 1), a hash and a time');
  }
  if (typeof hash !== 'string' || !HASH.test(hash) || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > MAX_TIME_MS) {
    throw new TypeError('the audit anchor has a 64-character lower-case hex hash and a UTC millisecond time');
  }
  return Object.freeze({ id, hash, at });
}

export function createKillSentinel(runDir: string): KillSentinel {
  const file = path.join(runDir, KILL_FILE);
  return Object.freeze({
    present(): boolean {
      try {
        lstatSync(file);
        return true;
      } catch (e) {
        return errnoOf(e) !== 'ENOENT';
      }
    },
  });
}

export function createAnchorFile(runDir: string): AnchorStore {
  const file = path.join(runDir, ANCHOR_FILE);
  const temp = `${file}.tmp`;
  return Object.freeze({
    read(): AuditAnchor | null {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (e) {
        if (errnoOf(e) === 'ENOENT') {
          return null;
        }
        throw e;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new TypeError('the audit anchor file is not JSON');
      }
      return checked(parsed);
    },
    write(a: AuditAnchor): void {
      const { id, hash, at } = checked(a);
      writeFileSync(temp, JSON.stringify({ id, hash, at }), { mode: 0o600 });
      if (process.platform !== 'win32') {
        chmodSync(temp, 0o600); // a temp file a crash left behind keeps its old mode otherwise
      }
      renameSync(temp, file);
    },
  });
}

export const nodeFsProbe: FsProbe = Object.freeze({
  lstat(p: string) {
    try {
      const s = lstatSync(p);
      return Object.freeze({ isSymbolicLink: s.isSymbolicLink(), isDirectory: s.isDirectory(), mode: s.mode & 0o777, uid: s.uid, nlink: s.nlink });
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') {
        return null;
      }
      throw e;
    }
  },
  realpath: (p: string): string => realpathSync(p),
  fsType: (p: string): number | null => (process.platform === 'linux' ? statfsSync(p).type : null),
  chmod: (p: string, mode: number): void => chmodSync(p, mode),
});
