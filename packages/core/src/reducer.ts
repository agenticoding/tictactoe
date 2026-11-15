import type {
  ApplyEvents,
  CheckWinner,
  GameEvent,
  GameState,
  InitialState,
  IsBoardFull,
  Reducer,
} from './domain';
import { winningLines } from './domain';

/** A fresh empty game: empty board, X to move, waiting, no seats bound. */
export const initialState: InitialState = (gameId) => ({
  id: gameId,
  board: Array<GameState['board'][number]>(9).fill(null),
  turn: 'X',
  status: 'waiting',
  winner: null,
  seats: {},
});

/**
 * Fold Ordered events into state. Folding is associative; replaying an ordered
 * log from any point reproduces the live state (a core invariant).
 */
export const applyEvents: ApplyEvents = (initial, events) => events.reduce(reduce, initial);

/** A winning player if one of the eight lines is fully marked, else null. */
export const checkWinner: CheckWinner = (board) => {
  for (const [a, b, c] of winningLines) {
    const mark = board[a];
    if (mark != null && board[b] === mark && board[c] === mark) return mark;
  }
  return null;
};

/** True iff every one of the nine cells is marked. */
export const isBoardFull: IsBoardFull = (board) => board.every((cell) => cell !== null);

/** Pure reducer: (state, event) -> state. Invalid events are silently ignored. */
export const reduce: Reducer = (state, event) => {
  switch (event.type) {
    case 'Joined':
      return applyJoined(state, event);
    case 'Move':
      return applyMove(state, event);
    default:
      // Defense in depth: a non-union event at runtime is ignored, never thrown.
      return state;
  }
};

function applyJoined(
  state: GameState,
  event: Extract<GameEvent, { type: 'Joined' }>,
): GameState {
  const atSeat = state.seats[event.seat];
  // Already-bound seat with a different token, or a token already owning the
  // other seat: silently reject (one token owns at most one seat).
  if (
    atSeat !== undefined && atSeat !== event.token ||
    state.seats[event.seat === 'X' ? 'O' : 'X'] === event.token
  ) {
    return state;
  }
  // Idempotent: seat already holds exactly this token -> nothing changes.
  if (atSeat === event.token) return state;

  const seats = { ...state.seats, [event.seat]: event.token };
  const next: GameState = { ...state, seats };
  // waiting -> active exactly once both seats are bound.
  if (state.status === 'waiting' && seats.X !== undefined && seats.O !== undefined) {
    return { ...next, status: 'active' };
  }
  return next;
}

function applyMove(state: GameState, event: Extract<GameEvent, { type: 'Move' }>): GameState {
  // Guard against out-of-range cells: a bad index must never extend the board.
  if (!Number.isInteger(event.cell) || event.cell < 0 || event.cell > 8) return state;
  // Legal only while active, the player is on turn, and the cell is empty.
  if (state.status !== 'active' || event.player !== state.turn) return state;
  if (state.board[event.cell] != null) return state;

  const board = state.board.slice();
  board[event.cell] = event.player;
  const next: GameState = { ...state, board, turn: state.turn === 'X' ? 'O' : 'X' };

  const winner = checkWinner(board);
  if (winner !== null) return { ...next, status: 'won', winner };
  if (isBoardFull(board)) return { ...next, status: 'draw' };
  return next;
}
