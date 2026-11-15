import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { applyEvents, createInMemoryEventLog, initialState, type GameEvent, type GameState } from '@tictactoe/core';
import { RUNS, eventArb } from '@tictactoe/core/testing';
import { createSqliteEventLog, openGameDb, listGameIds } from '../src/event-log-sqlite';

type OpenedDb = ReturnType<typeof openGameDb>;

// Every db opened in a test is closed after it, so an in-memory SQLite handle
// never leaks across tests (important: `:memory:` is per-connection).
const openDbs: OpenedDb[] = [];
// File-backed tests create throwaway dirs; remove them after closing handles.
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  openDbs.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeDb(): OpenedDb {
  const db = openGameDb(':memory:');
  openDbs.push(db);
  return db;
}

// Arbitraries (eventArb) and RUNS are shared with the core suite via
// @tictactoe/core/testing — one source of truth.

// ---------------------------------------------------------------------------
// SQLite EventLog as a faithful drop-in for the in-memory log
// ---------------------------------------------------------------------------

describe('SQLite event log (node:sqlite, in-memory)', () => {
  it('append yields gapless seqs 0..N-1 and latestSeq == N-1', () => {
    const log = createSqliteEventLog(makeDb(), 'g');

    // Empty log edge case.
    expect(log.latestSeq()).toBe(-1);
    expect(log.fetchAfter(-1)).toEqual([]);

    const events: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' },
      { type: 'Move', cell: 4, player: 'O' },
    ];
    const seqs = events.map((e) => log.append(e).seq);
    expect(seqs).toEqual([0, 1, 2, 3]); // gapless from 0
    expect(log.latestSeq()).toBe(3);
  });

  it('fetchAfter(k) returns exactly the events with seq > k, ascending', () => {
    const log = createSqliteEventLog(makeDb(), 'g');
    const events: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' },
      { type: 'Move', cell: 4, player: 'O' },
    ];
    events.forEach((e) => log.append(e));

    expect(log.fetchAfter(-1)).toEqual([
      { seq: 0, event: events[0] },
      { seq: 1, event: events[1] },
      { seq: 2, event: events[2] },
      { seq: 3, event: events[3] },
    ]);
    expect(log.fetchAfter(0)).toEqual([
      { seq: 1, event: events[1] },
      { seq: 2, event: events[2] },
      { seq: 3, event: events[3] },
    ]);
    expect(log.fetchAfter(2)).toEqual([{ seq: 3, event: events[3] }]);
    expect(log.fetchAfter(3)).toEqual([]); // at-latest -> none
    expect(log.fetchAfter(99)).toEqual([]); // beyond latest -> none
  });

  it('two gameIds in one db get independent zero-based seqs', () => {
    const db = makeDb();
    const logA = createSqliteEventLog(db, 'gameA');
    const logB = createSqliteEventLog(db, 'gameB');

    // gameA gets seqs 0,1,2; gameB gets seqs 0,1; both start at 0.
    logA.append({ type: 'Joined', seat: 'X', token: 'ta' });
    logA.append({ type: 'Joined', seat: 'O', token: 'tb' });
    logA.append({ type: 'Move', cell: 0, player: 'X' });
    logB.append({ type: 'Joined', seat: 'X', token: 'tc' });
    logB.append({ type: 'Joined', seat: 'O', token: 'td' });

    expect(logA.fetchAfter(-1).map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(logB.fetchAfter(-1).map((s) => s.seq)).toEqual([0, 1]);
    expect(logA.latestSeq()).toBe(2);
    expect(logB.latestSeq()).toBe(1);

    // Cross-isolation: B's append did NOT inflate A's seqs or vice-versa.
    expect(logA.fetchAfter(0).map((s) => s.seq)).toEqual([1, 2]);
    expect(logB.fetchAfter(0).map((s) => s.seq)).toEqual([1]);

    // And the games table lists both, independent of seq.
    expect(listGameIds(db).sort()).toEqual(['gameA', 'gameB']);
  });

  it('replays the SQLite log from any split point (replayConverges)', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 60 }),
        (events) => {
          // Fresh log per run: the db must reflect ONLY this run's events.
          const log = createSqliteEventLog(makeDb(), 'g');
          for (const e of events) log.append(e);

          const initial = initialState('g');
          const full = applyEvents(initial, events);

          // Full replay via fetchAfter(-1) reproduces the live fold.
          const fromLog = applyEvents(
            initial,
            log.fetchAfter(-1).map((s) => s.event),
          );
          expect(fromLog).toEqual(full);

          // Every split point: fetchAfter(k-1) == events.slice(k) (exact tail),
          // and prefix + tail converges back to the full state (no drift).
          for (let k = 0; k <= events.length; k++) {
            const tail = log.fetchAfter(k - 1).map((s) => s.event);
            expect(tail).toEqual(events.slice(k));
            const prefix = applyEvents(initial, events.slice(0, k));
            expect(applyEvents(prefix, tail)).toEqual(full);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('matches the in-memory log on an arbitrary scripted game', () => {
    // The SQLite log and the in-memory log are drop-ins: same appends, same
    // replay result.
    const db = makeDb();
    const sqliteLog = createSqliteEventLog(db, 'g');
    const memLog = createInMemoryEventLog();

    const events: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' },
      { type: 'Move', cell: 3, player: 'O' },
      { type: 'Move', cell: 1, player: 'X' },
      { type: 'Move', cell: 4, player: 'O' },
      { type: 'Move', cell: 2, player: 'X' },
    ];
    const expected = events.map((e, i) => ({ seq: i, event: e }));

    events.forEach((e) => {
      sqliteLog.append(e);
      memLog.append(e);
    });
    expect(sqliteLog.fetchAfter(-1)).toEqual(memLog.fetchAfter(-1));
    expect(sqliteLog.fetchAfter(-1)).toEqual(expected);
    expect(sqliteLog.latestSeq()).toBe(memLog.latestSeq());
  });
});

// ---------------------------------------------------------------------------
// File-backed DB: opening must create missing parent directories
// ---------------------------------------------------------------------------

describe('SQLite event log (file-backed)', () => {
  it('openGameDb creates missing parent dirs and the log survives a reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'ttt-sqlite-'));
    tempDirs.push(root);
    // The nested parent does NOT exist yet: the exact condition that produced
    // SQLITE_CANTOPEN (errcode 14) on a fresh `npm run dev:server` boot.
    const dbPath = join(root, 'nested', 'deeper', 'ttt.sqlite');

    const db = openGameDb(dbPath);
    openDbs.push(db);
    createSqliteEventLog(db, 'g').append({ type: 'Joined', seat: 'X', token: 'tx' });
    db.close();

    // Reopen from disk: proves a real file was written (no silent fallback).
    const reopened = openGameDb(dbPath);
    openDbs.push(reopened);
    expect(createSqliteEventLog(reopened, 'g').fetchAfter(-1)).toEqual([
      { seq: 0, event: { type: 'Joined', seat: 'X', token: 'tx' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Golden replay fixture: X wins the top row -> deterministic pin
// ---------------------------------------------------------------------------

describe('SQLite log golden replay fixture', () => {
  // Joined X, Joined O, then X plays 0/1/2 for the top row; O plays 3/4 in vain.
  const fixture: GameEvent[] = [
    { type: 'Joined', seat: 'X', token: 'tx' },
    { type: 'Joined', seat: 'O', token: 'to' },
    { type: 'Move', cell: 0, player: 'X' },
    { type: 'Move', cell: 3, player: 'O' },
    { type: 'Move', cell: 1, player: 'X' },
    { type: 'Move', cell: 4, player: 'O' },
    { type: 'Move', cell: 2, player: 'X' }, // completes row [0,1,2] -> X wins
  ];

  const expectedFinal: GameState = {
    id: 'g',
    board: ['X', 'X', 'X', 'O', 'O', null, null, null, null],
    turn: 'O',
    status: 'won',
    winner: 'X',
    seats: { X: 'tx', O: 'to' },
  };

  it('reducer folds the fixture to the exact expected final state', () => {
    expect(applyEvents(initialState('g'), fixture)).toEqual(expectedFinal);
  });

  it('SQLite log replays the fixture to the same final state', () => {
    const log = createSqliteEventLog(makeDb(), 'g');
    for (const e of fixture) log.append(e);
    const replayed = applyEvents(
      initialState('g'),
      log.fetchAfter(-1).map((s) => s.event),
    );
    expect(replayed).toEqual(expectedFinal);
  });

  it('replaying from every split point converges to the same final state', () => {
    const log = createSqliteEventLog(makeDb(), 'g');
    for (const e of fixture) log.append(e);
    const initial = initialState('g');

    // k=0 (cold start), k=1 (after first join), k=3 (after first move),
    // k=5 (late game, two moves left), k=7 (empty tail).
    for (const k of [0, 1, 3, 5, 7]) {
      const prefix = applyEvents(initial, fixture.slice(0, k));
      const tail = log.fetchAfter(k - 1).map((s) => s.event);
      expect(applyEvents(prefix, tail)).toEqual(expectedFinal);
    }
  });
});
