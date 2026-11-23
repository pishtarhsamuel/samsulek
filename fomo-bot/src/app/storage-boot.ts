// The boot (STORAGE_DESIGN.md s.16.6; conditions C7, C12, C14, C15, C17, C19, C26, C35, C36, C48 and
// review T's conditions for 6d-3). Before the bot trades, every step below passes or the start is
// refused with a BootError: the database is closed, and the owner is alerted with the refusal's code.
// 0. the built-ins are frozen (the start flags), and the run lock is held;
// 1. the data folder: an absolute, real path (no link on the way), on a local file system (Linux), not
//    a network share or OneDrive (Windows), the folders and files owned by the bot's user and made
//    private (0700, 0600), and the database, its -wal and its -shm without a second name (hard link);
// 2. the database opens (never created here), 3. passes quick_check and the foreign-key check,
// 4. is at the code's schema (never made fresh here), 5. has every required row and a config that
//    decodes;
// 6. the audit chain holds; the anchor of the last run names a row that is still there, with its hash
//    (s.16.11 Q1: a log cut short or an older copy refuses); a clock behind the newest row only warns;
// 7. KILL and every halt name the engine's own audit row of their source or reason;
// 8. each book conserves its SOL; paper has its one deposit and no withdrawal (D7); live holds nothing
//    (no SOL, deposit, withdrawal or position) until Phase 8;
// 9. an opening with no buy order is abandoned without a slot (an old buy token cannot be used any more:
//    its key died with the old process, the run lock keeps a second one out, and if one were still
//    alive, the database refuses its token once the position is closed); one with an order stays
//    counted;
// 10. the KILL file stores KILL; 11. the anchor moves to the newest row.
// Only app/engine.ts may import this file (the architecture test): the boot runs once, before the
// authority exists.
import path from 'node:path';
import { HARD_CAPS } from '../config/caps.ts';
import { checkConservation } from '../portfolio/ledger.ts';
import { migrate } from '../storage/migrations.ts';
import { readAuditRow, verifyAuditChain, type AuditRow } from '../storage/repo-audit.ts';
import { abandonOpening, readAccount, readActivePositions, readBook, readPosition } from '../storage/repo-book.ts';
import { readDayState } from '../storage/repo-day.ts';
import { readFlags, readHalts, readModes } from '../storage/repo-flags.ts';
import { buyOrderOf } from '../storage/repo-orders.ts';
import { openDb, type Db } from '../storage/sqlite.ts';
import { persistKillTx, type StoreDeps } from './approve-tx.ts';
import { createEntryLatch, createFaultSink, type Alert, type AlertSink, type EntryLatch, type KillSentinel } from './faults.ts';
import type { AnchorStore, FsProbe } from './run-files.ts';
import type { Clock } from './slots.ts';
import { ledgerOf, readActiveConfig } from './snapshot.ts';

export const BOOT_REFUSALS = Object.freeze([
  'runtime-not-frozen',
  'run-lock',
  'path',
  'open',
  'health',
  'migrations',
  'required-rows',
  'config',
  'audit-chain',
  'audit-anchor',
  'kill-link',
  'halt-link',
  'book',
  'conservation',
  'paper-account',
  'live-account',
  'abandon',
  'sentinel',
] as const);
export type BootRefusal = (typeof BOOT_REFUSALS)[number];

/** The start is refused; `code` is what the owner is alerted with (never the cause's text). */
export class BootError extends Error {
  readonly refusal: BootRefusal;
  readonly code: string;

  constructor(refusal: BootRefusal, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'BootError';
    this.refusal = refusal;
    this.code = `boot:${refusal}`;
  }
}

/** Local Linux file systems by statfs type (the kernel's linux/magic.h; VERIFIED_FACTS V1). ext4's number covers ext2 and ext3. */
export const LOCAL_FILE_SYSTEMS: ReadonlyMap<number, string> = new Map([
  [0xef53, 'ext4'],
  [0x58465342, 'xfs'],
  [0x9123683e, 'btrfs'],
  [0x01021994, 'tmpfs'],
  [0x794c7630, 'overlay'],
]);

export interface BootOptions {
  /** Absolute. */
  readonly dataDir: string;
  /** Plain names inside dataDir, e.g. 'fomo.sqlite', 'db-copies' (pre-migration copies) and 'run'. */
  readonly dbFile: string;
  readonly copyDir: string;
  readonly runDir: string;
  /** process.platform */
  readonly platform: string;
  /** process.getuid?.() ?? null */
  readonly uid: number | null;
  readonly windows: { readonly userProfile: string | null; readonly oneDriveRoots: readonly string[] };
  readonly nodeVersion: string;
  /** 5,000 in the bot. */
  readonly busyTimeoutMs: number;
  readonly clock: Clock;
  readonly fs: FsProbe;
  /** The ops step's single-instance lock; the boot only requires that it is held (C13). */
  readonly runLock: { readonly held: true };
  readonly sentinel: KillSentinel;
  readonly anchors: AnchorStore;
  readonly alerts: AlertSink;
}

export interface BootReport {
  readonly schemaVersion: number;
  readonly auditNewestId: number;
  readonly auditNewestHash: string;
  readonly killOn: boolean;
  readonly halts: readonly string[];
  /** Position ids. */
  readonly abandoned: readonly string[];
  readonly openingsWithOrders: readonly string[];
  /** Codes: 'no-audit-anchor', 'clock-behind-audit', 'opening-with-order', 'anchor-write-failed'. */
  readonly warnings: readonly string[];
}

/** A plain file or folder name: no separator, no "." or "..", and no trailing dot (Windows drops it, so "run." is "run"). */
const PLAIN_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
/** Windows device names, which name no file whatever their extension: refused on every platform (the owner's config is one file). */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
/** The slot source of the boot's StoreDeps: the KILL write never reads it (and the boot's abandon needs no slot, step 9). */
const NO_SLOT = Object.freeze({ currentSlot: (): null => null });

/** Runs one step; any throw refuses the start with the step's refusal (its cause kept, never alerted). */
function step<T>(refusal: BootRefusal, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw e instanceof BootError ? e : new BootError(refusal, `the start is refused: ${refusal}`, e);
  }
}

/** Step 1 (C15): the data folder and the files in it; throws BootError('path'). Exported for the Windows cases. */
export function checkDataPath(o: Pick<BootOptions, 'dataDir' | 'dbFile' | 'copyDir' | 'runDir' | 'platform' | 'uid' | 'windows' | 'fs'>): void {
  step('path', () => {
    const { dataDir, dbFile, copyDir, runDir, platform, uid, windows, fs } = o; // each read once
    const win = platform === 'win32';
    const p = win ? path.win32 : path.posix;
    const refuse = (why: string): never => {
      throw new BootError('path', why);
    };
    /** The folder itself or one below it ("..fomo" is a name below it; "..\x" and another drive are not). */
    const inside = (child: string, parent: string): boolean => {
      const rel = p.relative(parent, child);
      return rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
    };
    if (typeof dataDir !== 'string' || !p.isAbsolute(dataDir)) {
      refuse('the data folder is an absolute path');
    }
    const names = [dbFile, copyDir, runDir];
    // three different names, also where case does not count (Windows, macOS)
    if (!names.every((n) => typeof n === 'string' && PLAIN_NAME.test(n) && !DEVICE_NAME.test(n)) || new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
      refuse('the database file and the two folders are three different plain names inside the data folder');
    }
    if (win) {
      if (/^[\\/]{2}/.test(dataDir)) {
        refuse('a UNC path (a network share) is refused');
      }
      if (windows.userProfile === null || !inside(dataDir, windows.userProfile)) {
        refuse('the data folder is under the user profile');
      }
      if (windows.oneDriveRoots.some((root) => inside(dataDir, root)) || dataDir.split(/[\\/]/).some((part) => /^onedrive/i.test(part))) {
        refuse('the data folder is not in OneDrive (D5.3)');
      }
    }
    if (fs.realpath(dataDir) !== dataDir) {
      refuse('no link (or junction) anywhere on the way to the data folder');
    }
    if (!win && typeof uid !== 'number') {
      refuse('the owner of the files can be checked (a uid)');
    }
    // each folder and file on its own: a share mounted inside the data folder is not a link
    const local = (target: string): void => {
      if (platform === 'linux') {
        const type = fs.fsType(target);
        if (type === null || !LOCAL_FILE_SYSTEMS.has(type)) {
          refuse('the data is on a local file system: not a network share, FUSE or a Docker Desktop bind mount');
        }
      }
    };
    const own = (target: string, s: { readonly uid: number }, mode: number): void => {
      if (!win) {
        if (s.uid !== uid) {
          refuse('the folders and files belong to the user that runs the bot');
        }
        fs.chmod(target, mode); // a chmod that fails refuses (step)
      }
    };
    for (const dir of [dataDir, p.join(dataDir, copyDir), p.join(dataDir, runDir)]) {
      const s = fs.lstat(dir);
      if (s === null || !s.isDirectory || s.isSymbolicLink) {
        refuse('the data, copy and run folders exist and are real folders');
      } else {
        local(dir);
        own(dir, s, 0o700);
      }
    }
    const file = p.join(dataDir, dbFile);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      const s = fs.lstat(f);
      if (s === null) {
        continue; // a missing database is refused when it opens; -wal and -shm come and go
      }
      if (s.isSymbolicLink || s.isDirectory || s.nlink !== 1) {
        refuse('the database and its -wal and -shm are plain files with one name (no link, no hard link)');
      }
      local(f); // a file can be a mount point too (a bind mount)
      own(f, s, 0o600);
    }
  });
}

/** The engine's view of the boot: its database, its report, and its latch (KILL already marked when it is on). */
export interface Booted {
  readonly db: Db;
  readonly report: BootReport;
  readonly latch: EntryLatch;
}

export function bootStorage(o: BootOptions): Booted {
  const latch = createEntryLatch();
  const say = (a: Alert): void => {
    try {
      o.alerts.alert(Object.freeze(a));
    } catch {
      latch.set('bug');
    }
  };
  const warnings: string[] = [];
  const warn = (code: string, codes?: readonly string[]): void => {
    warnings.push(code);
    say(codes === undefined ? { code, severity: 'warn' } : { code, severity: 'warn', codes });
  };
  let db: Db | null = null;
  try {
    step('runtime-not-frozen', () => {
      if (!Object.isFrozen(Array.prototype)) {
        throw new Error('the built-ins can be changed: start with --frozen-intrinsics');
      }
    });
    step('run-lock', () => {
      if (o.runLock.held !== true) {
        throw new Error('the run lock is not held');
      }
    });
    checkDataPath(o);
    const handle = step('open', () => openDb(path.join(o.dataDir, o.dbFile), { busyTimeoutMs: o.busyTimeoutMs, create: false }));
    db = handle;
    step('health', () => {
      if (handle.quickCheck().length > 0 || handle.foreignKeyCheck().length > 0) {
        throw new Error('the database fails quick_check or its foreign keys');
      }
    });
    const migrated = step('migrations', () => migrate(handle, { now: () => o.clock.now(), backupDir: path.join(o.dataDir, o.copyDir), nodeVersion: o.nodeVersion, allowFresh: false }));
    const rows = step('required-rows', () => {
      readModes(handle);
      readDayState(handle, 'paper');
      readDayState(handle, 'live');
      readAccount(handle, 'paper');
      readAccount(handle, 'live');
      return { flags: readFlags(handle), halts: readHalts(handle) };
    });
    step('config', () => readActiveConfig(handle));

    const chain = step('audit-chain', () => {
      const c = verifyAuditChain(handle);
      if (c.newestId === 0) {
        throw new Error('the audit log is empty: the owner setup writes the first rows');
      }
      return c;
    });
    step('audit-anchor', () => {
      const a = o.anchors.read();
      if (a === null) {
        warn('no-audit-anchor'); // the first start, or the file was removed
      } else if (a.id > chain.newestId || (readAuditRow(handle, a.id) as AuditRow).hash !== a.hash) {
        // ids 1 to newestId are all there (verifyAuditChain checked them), so the read finds its row
        throw new Error('the audit log is shorter than when the bot last ran, or this is an older copy of the database');
      }
      // newestAt is the newest row's time (there is one); a clock behind it only warns (C26, s.16.11 D2)
      if (o.clock.now() < (chain.newestAt as number)) {
        warn('clock-behind-audit');
      }
    });
    const link = (id: number, action: string, detail: Readonly<Record<string, string>>): void => {
      const row = readAuditRow(handle, id);
      if (row === null || row.actor !== 'engine' || row.action !== action || JSON.stringify(row.detail) !== JSON.stringify(detail)) {
        throw new Error('a stop names an audit row that is not its own');
      }
    };
    step('kill-link', () => {
      const k = rows.flags.kill;
      if (k !== null) {
        link(k.auditId, 'engine:kill-set', { source: k.source });
      }
    });
    step('halt-link', () => {
      for (const h of rows.halts) {
        link(h.setAuditId, 'engine:halt-set', { reason: h.reason });
      }
    });

    const paperBook = step('book', () => readBook(handle, 'paper'));
    const liveBook = step('book', () => readBook(handle, 'live'));
    for (const book of [paperBook, liveBook]) {
      step('conservation', () => checkConservation(ledgerOf(book)));
    }
    step('paper-account', () => {
      const { totalDeposits, totalWithdrawals } = paperBook.account;
      if (totalWithdrawals !== 0n || totalDeposits < 1n || totalDeposits > HARD_CAPS.equitySanityLamports) {
        throw new Error("paper's bankroll is its one deposit, 1 lamport to 2 SOL, with nothing withdrawn");
      }
    });
    step('live-account', () => {
      // with conservation, any one of the four would do; each is kept so no single slip lets live money in
      const { sol, totalDeposits, totalWithdrawals } = liveBook.account;
      if (sol !== 0n || totalDeposits !== 0n || totalWithdrawals !== 0n || liveBook.positions.length > 0) {
        throw new Error('the live book holds nothing until Phase 8: no SOL, no deposit, no withdrawal, no position');
      }
    });

    const abandoned: string[] = [];
    const withOrders: string[] = [];
    const openings = step('book', () => readActivePositions(handle).filter((p) => p.status === 'opening'));
    for (const p of openings) {
      const closed = step('abandon', () =>
        handle.transaction((tx) => {
          const q = readPosition(tx, p.id);
          if (buyOrderOf(tx, q.id) !== null) {
            return false; // it may still land: counted at its held-back spend until T3 settles it (C67)
          }
          abandonOpening(tx, q.id, Math.max(o.clock.now(), q.openedAt));
          return true;
        }),
      );
      (closed ? abandoned : withOrders).push(p.id);
    }
    if (withOrders.length > 0) {
      warn('opening-with-order', Object.freeze([...withOrders]));
    }

    let killOn = rows.flags.kill !== null;
    step('sentinel', () => {
      if (o.sentinel.present()) {
        // the boot's own StoreDeps: its handle, clock, latch and alerts; a fault here refuses the start
        // below, so the sink's fatal and disk-trouble hooks have nothing more to do
        const sink: AlertSink = Object.freeze({ alert: say });
        const store: StoreDeps = Object.freeze({
          db: handle,
          clock: o.clock,
          slots: NO_SLOT,
          latch,
          faults: createFaultSink({ latch, alerts: sink, clock: o.clock, onFatal: () => undefined, onDiskTrouble: () => undefined }),
          alerts: sink,
          anchors: o.anchors,
        });
        if (persistKillTx(store, 'sentinel') === 'failed') {
          throw new Error('the KILL file is there, and KILL could not be stored');
        }
        killOn = true;
      }
    });
    if (killOn) {
      latch.markKill();
    }

    const tail = step('audit-chain', () => verifyAuditChain(handle));
    try {
      o.anchors.write({ id: tail.newestId, hash: tail.newestHash, at: tail.newestAt as number });
    } catch {
      warn('anchor-write-failed'); // an anchor behind still passes the next start: only the tripwire is weaker
    }
    const report: BootReport = Object.freeze({
      schemaVersion: migrated.to,
      auditNewestId: tail.newestId,
      auditNewestHash: tail.newestHash,
      killOn,
      halts: Object.freeze(rows.halts.map((h) => h.reason)),
      abandoned: Object.freeze(abandoned),
      openingsWithOrders: Object.freeze(withOrders),
      warnings: Object.freeze([...warnings]),
    });
    say({ code: 'boot-ok', severity: 'info', codes: Object.freeze([`audit:${tail.newestId}`, tail.newestHash]) });
    return Object.freeze({ db: handle, report, latch });
  } catch (e) {
    db?.close();
    const refused = e as BootError; // every step turns its throw into a BootError
    say({ code: refused.code, severity: 'fatal' });
    throw refused;
  }
}
