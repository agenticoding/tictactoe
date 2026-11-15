import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  initialState,
  applyEvents,
  reduce,
  join,
  createInMemoryEventLog,
  type EventLog,
  type GameEvent,
  type GameState,
  type Player,
  type Reducer,
  type StampedEvent,
} from '@tictactoe/core';
import { RUNS, eventArb } from '../src/testing';

// Arbitraries (eventArb) and RUNS are shared with the
// server suite via @tictactoe/core/testing — one source of truth.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append every event to a log built by `makeLog` (defaults to the real log). */
function appendAll(
  events: GameEvent[],
  makeLog: () => EventLog = createInMemoryEventLog,
): EventLog {
  const log = makeLog();
  for (const event of events) log.append(event);
  return log;
}

/** Fold events with an arbitrary reducer (applyEvents is bound to the real one). */
const fold = (
  reducer: Reducer,
  initial: GameState,
  events: GameEvent[],
): GameState => events.reduce(reducer, initial);

/** Order-sensitive deep equality for the plain data here. */
const sameData = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * monotonicGapless property body. Parameterised by the log factory so the SAME
 * predicate proves the real log and FAILS a deliberately mis-sequenced one.
 */
function sequencesAreGapless(events: GameEvent[], makeLog: () => EventLog): boolean {
  const log = makeLog();
  const seqs = events.map((event) => log.append(event).seq);
  // gapless from 0: seq i equals its position i; latestSeq is the last position.
  return seqs.every((seq, i) => seq === i) && log.latestSeq() === seqs.length - 1;
}

/**
 * replayConverges property body: for EVERY split point k, prefix + the
 * fetchAfter window must reproduce the full fold. Parameterised so a broken
 * window/reducer can be shown to fail it.
 */
function replayConverges(events: GameEvent[], makeLog: () => EventLog): boolean {
  const full = applyEvents(initialState('g'), events);
  const log = appendAll(events, makeLog);
  for (let k = 0; k <= events.length; k++) {
    const prefix = applyEvents(initialState('g'), events.slice(0, k));
    // fetchAfter(k - 1) == every event with seq > k-1 == events[k..].
    const window = log.fetchAfter(k - 1).map((s) => s.event);
    if (!sameData(window, events.slice(k))) return false;
    if (!sameData(applyEvents(prefix, window), full)) return false;
  }
  return true;
}

/**
 * finalStateIsLog property body: identical ordered log -> identical state, and
 * folding never mutates the input state. Parameterised by the reducer so hidden
 * mutable state can be shown to fail it.
 */
function finalStateIsLog(events: GameEvent[], reducer: Reducer): boolean {
  const id = 'g';
  if (!sameData(fold(reducer, initialState(id), events), fold(reducer, initialState(id), events))) {
    return false;
  }
  // Two independent logs holding the same ordered events converge too.
  const reconstructed = (): GameState =>
    fold(reducer, initialState(id), appendAll(events).fetchAfter(-1).map((s) => s.event));
  if (!sameData(reconstructed(), reconstructed())) return false;
  // Purity: folding must not mutate the state passed in.
  const fresh = initialState(id);
  const snapshot = structuredClone(fresh);
  fold(reducer, fresh, events);
  return sameData(fresh, snapshot);
}

/**
 * In-memory log with deliberately wrong sequencing/window semantics, used to
 * prove the log invariants detect breakage. `startSeq` shifts the first seq so
 * the log is no longer gapless from 0; `inclusive` makes fetchAfter return
 * seq >= lastSeq (an off-by-one replay window).
 */
function makeBrokenLog(opts: { startSeq?: number; inclusive?: boolean } = {}): EventLog {
  const { startSeq = 0, inclusive = false } = opts;
  const events: StampedEvent[] = [];
  return {
    append(event) {
      const stamped: StampedEvent = { seq: startSeq + events.length, event };
      events.push(stamped);
      return stamped;
    },
    fetchAfter(lastSeq) {
      return events.filter((s) => (inclusive ? s.seq >= lastSeq : s.seq > lastSeq));
    },
    latestSeq() {
      const last = events[events.length - 1];
      return last === undefined ? -1 : last.seq;
    },
  };
}

/**
 * Broken reducer: stamps a hidden, ever-incrementing counter into the game id.
 * The counter lives outside (state, event), so folding the SAME log twice yields
 * different final states — the inverse of determinism. It never mutates the
 * input state, so only the determinism clause (not purity) is violated.
 */
function makeNondeterministicReducer(): Reducer {
  let calls = 0;
  return (state, event) => ({ ...reduce(state, event), id: String(++calls) });
}

/**
 * The move-legality invariant checked against an arbitrary reducer.
 *
 * For every Move event the reducer sees (in stream order) we assert the two
 * external rules that make tic-tac-toe legal:
 *   1. A move is applied ONLY when the mover is on turn, the game is active,
 *      and the target cell is empty.
 *   2. Otherwise the move is a silent no-op (cell and status unchanged).
 *
 * It is intentionally parameterised by a Reducer so the SAME predicate can be
 * run against the real reducer (must hold) and against a deliberately broken
 * one (must fail — an "impossible-to-imagine-failing" property is a smell).
 */
function movesAreLegal(
  initial: GameState,
  events: GameEvent[],
  reducer: Reducer,
): boolean {
  let state = initial;
  for (const event of events) {
    const next = reducer(state, event);
    if (event.type === 'Move') {
      const priorTurn = state.turn;
      // An out-of-range cell is illegal by definition: treating it as an empty
      // cell would falsely fail the predicate if eventArb ever widens.
      const inRange = event.cell >= 0 && event.cell <= 8;
      const priorCell = inRange ? state.board[event.cell] : undefined;
      const legal =
        inRange &&
        state.status === 'active' &&
        event.player === priorTurn &&
        priorCell == null;

      if (legal) {
        // A legal move lands this player's mark in the (previously empty) cell.
        if (next.board[event.cell] !== event.player) return false;
      } else {
        // An illegal move must be a FULL no-op — identical state — not merely
        // leave board/status unchanged (a buggy reducer could still pass that).
        if (JSON.stringify(next) !== JSON.stringify(state)) return false;
      }
    }
    state = next;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The invariants that ARE the mechanism, as fast-check properties
// ---------------------------------------------------------------------------

describe('core invariants (fast-check)', () => {
  it('monotonicGapless: sequences are monotonic and gapless from 0', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 50 }),
        (events) => {
          expect(sequencesAreGapless(events, createInMemoryEventLog)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('replayConverges: replaying from any sequence reproduces the live state', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 60 }),
        (events) => {
          expect(replayConverges(events, createInMemoryEventLog)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('finalStateIsLog: the same ordered log always yields the same final state', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 60 }),
        (events) => {
          expect(finalStateIsLog(events, reduce)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('moveLegality: a move applies only on turn into an empty cell; terminal is terminal', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 40 }),
        (events) => movesAreLegal(initialState('g'), events, reduce),
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// SABOTAGE VERIFICATION
//
// A property you cannot imagine failing is a smell. This fixture bakes in a
// deliberately-broken reducer and asserts the moveLegality property FAILS on it,
// so a future weakening of the property (or a regression) is caught by code.
// ---------------------------------------------------------------------------

/**
 * Broken reducer: writes a mark to the cell IGNORING turn and occupancy, and
 * flips turn unconditionally. It is the inverse of the legal-move rule.
 */
const brokenReduce: Reducer = (state, event) => {
  if (event.type === 'Move') {
    const board = state.board.slice();
    board[event.cell] = event.player; // overwrites an existing mark, out of turn
    return { ...state, board, turn: state.turn === 'X' ? 'O' : 'X' };
  }
  return reduce(state, event);
};

describe('sabotage verification', () => {
  it('moveLegality is strong: it FAILS on a reducer that ignores turn/occupancy', () => {
    // A stream with one out-of-turn move and one move onto an occupied cell.
    const stream: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' }, // legal
      { type: 'Move', cell: 0, player: 'O' }, // occupied cell
      { type: 'Move', cell: 5, player: 'X' }, // not X's turn
    ];

    // The real reducer honours legality.
    expect(movesAreLegal(initialState('g1'), stream, reduce)).toBe(true);
    // The broken reducer is caught by the same predicate.
    expect(movesAreLegal(initialState('g1'), stream, brokenReduce)).toBe(false);

    // And over arbitrary streams the property FAILS against the broken reducer.
    const result = fc.check(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 30 }),
        (events) => movesAreLegal(initialState('g'), events, brokenReduce),
      ),
      { numRuns: RUNS },
    );
    expect(result.failed).toBe(true);
    expect(result.counterexample).toBeTruthy();
  });

  it('monotonicGapless is strong: it FAILS on a log that is not gapless from 0', () => {
    const stream: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
    ];
    // The real log satisfies the predicate; the seq-shifted log must not.
    expect(sequencesAreGapless(stream, createInMemoryEventLog)).toBe(true);
    expect(sequencesAreGapless(stream, () => makeBrokenLog({ startSeq: 1 }))).toBe(false);

    const result = fc.check(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 50 }),
        (events) => sequencesAreGapless(events, () => makeBrokenLog({ startSeq: 1 })),
      ),
      { numRuns: RUNS },
    );
    expect(result.failed).toBe(true);
    expect(result.counterexample).toBeTruthy();
  });

  it('replayConverges is strong: it FAILS on an off-by-one fetchAfter window', () => {
    const stream: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' },
    ];
    expect(replayConverges(stream, createInMemoryEventLog)).toBe(true);
    expect(replayConverges(stream, () => makeBrokenLog({ inclusive: true }))).toBe(false);

    const result = fc.check(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 60 }),
        (events) => replayConverges(events, () => makeBrokenLog({ inclusive: true })),
      ),
      { numRuns: RUNS },
    );
    expect(result.failed).toBe(true);
    expect(result.counterexample).toBeTruthy();
  });

  it('finalStateIsLog is strong: it FAILS on a reducer with hidden mutable state', () => {
    const stream: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Move', cell: 0, player: 'X' },
    ];
    expect(finalStateIsLog(stream, reduce)).toBe(true);
    expect(finalStateIsLog(stream, makeNondeterministicReducer())).toBe(false);

    const result = fc.check(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 60 }),
        (events) => finalStateIsLog(events, makeNondeterministicReducer()),
      ),
      { numRuns: RUNS },
    );
    expect(result.failed).toBe(true);
    expect(result.counterexample).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: crisp, deterministic contracts
// ---------------------------------------------------------------------------

describe('seat assignment contract', () => {
  it('first join is X and the game stays waiting', () => {
    const result = join(initialState('g1'), 'tokX');
    expect(result.kind).toBe('joined');
    if (result.kind === 'joined') {
      expect(result.seat).toBe('X');
      expect(result.state.status).toBe('waiting');
      expect(result.state.seats.X).toBe('tokX');
      expect(result.state.seats.O).toBeUndefined();
    }
  });

  it('second join is O, flips waiting -> active, and binds both seats', () => {
    const first = join(initialState('g1'), 'tokX');
    const second = join(first.kind === 'joined' ? first.state : initialState('g1'), 'tokO');
    expect(second.kind).toBe('joined');
    if (second.kind === 'joined') {
      expect(second.seat).toBe('O');
      expect(second.state.status).toBe('active');
      expect(second.state.seats.X).toBe('tokX');
      expect(second.state.seats.O).toBe('tokO');
    }
  });

  it('third join (new token) returns { kind: full }', () => {
    const first = join(initialState('g1'), 'tokX');
    const second = join(first.kind === 'joined' ? first.state : initialState('g1'), 'tokO');
    const active = second.kind === 'joined' ? second.state : initialState('g1');
    expect(join(active, 'tokThird')).toEqual({ kind: 'full' });
  });

  it('a token re-join returns { kind: rejoined } with the same seat and consumes nothing', () => {
    const first = join(initialState('g1'), 'tokX');
    const second = join(first.kind === 'joined' ? first.state : initialState('g1'), 'tokO');
    const active = second.kind === 'joined' ? second.state : initialState('g1');

    const rejoined = join(active, 'tokX');
    expect(rejoined).toMatchObject({ kind: 'rejoined', seat: 'X' });
    if (rejoined.kind === 'rejoined') {
      // No new seat consumed and no event folded: state is the very same object.
      expect(rejoined.state).toBe(active);
    }
  });
});

describe('game outcome contract', () => {
  it('a winning line sets status won with the winner', () => {
    const events: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' },
      { type: 'Move', cell: 3, player: 'O' },
      { type: 'Move', cell: 1, player: 'X' },
      { type: 'Move', cell: 4, player: 'O' },
      { type: 'Move', cell: 2, player: 'X' }, // completes row [0,1,2]
    ];
    const state = applyEvents(initialState('g1'), events);
    expect(state.status).toBe('won');
    expect(state.winner).toBe('X');
    expect(state.board[0]).toBe('X');
    expect(state.board[1]).toBe('X');
    expect(state.board[2]).toBe('X');
  });

  it('a full board with no line sets status draw with no winner', () => {
    // A legal, drawn game (both players join, X takes five moves, O four).
    const events: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' },
      { type: 'Move', cell: 1, player: 'O' },
      { type: 'Move', cell: 2, player: 'X' },
      { type: 'Move', cell: 4, player: 'O' },
      { type: 'Move', cell: 3, player: 'X' },
      { type: 'Move', cell: 5, player: 'O' },
      { type: 'Move', cell: 7, player: 'X' },
      { type: 'Move', cell: 6, player: 'O' },
      { type: 'Move', cell: 8, player: 'X' },
    ];
    const state = applyEvents(initialState('g1'), events);
    expect(state.status).toBe('draw');
    expect(state.winner).toBeNull();
  });
});

describe('move rejection contract', () => {
  // Build an active game with X to move (both seats bound).
  const active = applyEvents(initialState('g1'), [
    { type: 'Joined', seat: 'X', token: 'tx' },
    { type: 'Joined', seat: 'O', token: 'to' },
  ]);

  it('an out-of-turn move is rejected and leaves the state reference unchanged', () => {
    const badMove: GameEvent = { type: 'Move', cell: 5, player: 'O' };
    expect(active.turn).toBe('X');
    // Silent reject: the reducer returns the very same state object.
    expect(applyEvents(active, [badMove])).toBe(active);
    expect(active.board[5]).toBeNull();
  });

  it('a move onto an occupied cell is rejected', () => {
    const xHas0 = applyEvents(active, [{ type: 'Move', cell: 0, player: 'X' }]);
    // Now it is O's turn.
    expect(xHas0.turn).toBe('O');
    expect(xHas0.board[0]).toBe('X');
    const badMove: GameEvent = { type: 'Move', cell: 0, player: 'O' };
    expect(applyEvents(xHas0, [badMove])).toEqual(xHas0);
    expect(xHas0.board[0]).toBe('X');
  });

  it('a move on a terminal (won) game is rejected', () => {
    const won = applyEvents(initialState('g1'), [
      { type: 'Joined', seat: 'X', token: 'tx' },
      { type: 'Joined', seat: 'O', token: 'to' },
      { type: 'Move', cell: 0, player: 'X' },
      { type: 'Move', cell: 3, player: 'O' },
      { type: 'Move', cell: 1, player: 'X' },
      { type: 'Move', cell: 4, player: 'O' },
      { type: 'Move', cell: 2, player: 'X' },
    ]);
    expect(won.status).toBe('won');
    const boardSnapshot = structuredClone(won.board);
    const badMove: GameEvent = { type: 'Move', cell: 6, player: 'O' };
    const after = applyEvents(won, [badMove]);
    expect(after).toEqual(won);
    expect(after.board).toEqual(boardSnapshot);
    expect(after.status).toBe('won');
  });
});
