// The fault-injection handle (STORAGE_DESIGN.md s.16.9 and s.17.8): a test handle whose FIRST
// transaction hands the callback a Tx that throws a chosen StorageError at its k-th get, all or run,
// before the statement runs; later transactions and the plain reads pass through. k = 0 throws
// nothing: it counts the statements of a successful call.
import { StorageError, type Db, type StorageErrorCode, type Tx } from '../../../src/storage/sqlite.ts';

export const FAULT_CODES: readonly StorageErrorCode[] = Object.freeze(['full', 'io', 'constraint', 'bad-param', 'busy']);

export function faulty(real: Db, k: number, code: StorageErrorCode): { readonly db: Db; readonly statements: () => number } {
  let n = 0;
  let first = true;
  const db = {
    file: real.file,
    readOnly: false,
    get: (sql: string, ...p: never[]) => real.get(sql, ...p),
    all: (sql: string, ...p: never[]) => real.all(sql, ...p),
    close: () => real.close(),
    transaction: (fn: (tx: Tx) => unknown) => {
      const armed = first;
      first = false;
      return real.transaction((tx) => {
        const hit = (): void => {
          if (armed) {
            n += 1;
            if (n === k) {
              throw new StorageError(code, 'injected by the test');
            }
          }
        };
        const wrapped: Tx = {
          get: (sql, ...p) => {
            hit();
            return tx.get(sql, ...p);
          },
          all: (sql, ...p) => {
            hit();
            return tx.all(sql, ...p);
          },
          run: (sql, ...p) => {
            hit();
            return tx.run(sql, ...p);
          },
          script: (sql) => tx.script(sql),
        };
        return fn(wrapped) as never;
      });
    },
  } as unknown as Db;
  return { db, statements: () => n };
}
