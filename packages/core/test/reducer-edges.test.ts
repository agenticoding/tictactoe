import { describe, it, expect } from 'vitest';
import {
  initialState,
  applyEvents,
  reduce,
  checkWinner,
  isBoardFull,
  winningLines,
  type Cell,
  type GameEvent,
  type GameState,
  type Player,
} from '@tictactoe/core';

/** Nine empty cells (a fresh array so tests cannot leak marks into each other). */
const emptyBoard = (): (Player | null)[] => Array<Player | null>(9).fill(null);

/** An active game (both seats bound) with X to move. */
const activeState = (): GameState =>
  applyEvents(initialState('g'), [
    { type: 'Joined', seat: 'X', token: 'tx' },
    { type: 'Joined', seat: 'O', token: 'to' },
  ]);

/** A game with only seat X bound to token A (waiting, X to move). */
const xBoundToA = (): GameState =>
  applyEvents(initialState('g'), [{ type: 'Joined', seat: 'X', token: 'A' }]);

describe('reduce: out-of-range move guard', () => {
  // A malformed index must never extend or corrupt the board: silent no-op.
  it.each([-1, 9, 1.5, NaN])('cell %p is a no-op (same state reference)', (cell) => {
    const state = activeState();
    const next = reduce(state, {
      type: 'Move',
      cell: cell as unknown as Cell,
      player: 'X',
    });
    expect(next).toBe(state);
  });
});

describe('reduce: unknown event type', () => {
  it('is a silent no-op (same state reference)', () => {
    const state = activeState();
    const next = reduce(state, { type: 'Nope' } as unknown as GameEvent);
    expect(next).toBe(state);
  });
});

describe('reduce: Joined collision semantics', () => {
  it('rejects a different token claiming an already-bound seat', () => {
    const bound = xBoundToA();
    const next = applyEvents(bound, [{ type: 'Joined', seat: 'X', token: 'B' }]);
    expect(next).toBe(bound);
  });

  it('rejects a token claiming a second seat (one token owns at most one seat)', () => {
    const bound = xBoundToA();
    const next = applyEvents(bound, [{ type: 'Joined', seat: 'O', token: 'A' }]);
    expect(next).toBe(bound);
  });

  it('is idempotent when the same token rejoins its own seat', () => {
    const bound = xBoundToA();
    const next = applyEvents(bound, [{ type: 'Joined', seat: 'X', token: 'A' }]);
    expect(next).toBe(bound);
  });
});

describe('checkWinner', () => {
  it.each(winningLines.map((line) => [...line]))(
    'detects X on winning line [%i, %i, %i]',
    (a, b, c) => {
      const board = emptyBoard();
      for (const cell of [a, b, c]) board[cell] = 'X';
      expect(checkWinner(board)).toBe('X');
    },
  );

  it('detects O as the winner too (returns the mark, not a hard-coded X)', () => {
    const board = emptyBoard();
    for (const cell of winningLines[0]!) board[cell] = 'O';
    expect(checkWinner(board)).toBe('O');
  });

  it('returns null when no line is complete', () => {
    // Interleaved marks such that no row, column, or diagonal is uniform.
    const board: (Player | null)[] = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'];
    expect(checkWinner(board)).toBeNull();
    expect(checkWinner(emptyBoard())).toBeNull();
  });
});

describe('isBoardFull', () => {
  it('is false for the empty board and for any board with a gap', () => {
    expect(isBoardFull(emptyBoard())).toBe(false);
    const oneGap = emptyBoard();
    oneGap[4] = 'X';
    expect(isBoardFull(oneGap)).toBe(false);
  });

  it('is true only when all nine cells are marked', () => {
    expect(isBoardFull(emptyBoard().map(() => 'X'))).toBe(true);
    expect(isBoardFull(emptyBoard().map(() => 'O'))).toBe(true);
  });
});
