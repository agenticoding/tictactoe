/**
 * @tictactoe/core — the domain contract.
 *
 * This is the single source of truth for the game model. It contains ONLY
 * types, pure data, and the signatures every implementation module must
 * satisfy. No game logic lives here. No clocks, no randomness, no I/O.
 *
 * The implementation modules MUST provide exactly these exports, and MUST
 * match the stated signatures/types exactly:
 *
 *   ./reducer   -> reduce, initialState, applyEvents, checkWinner, isBoardFull
 *   ./seats     -> nextFreeSeat, join
 *   ./event-log -> createInMemoryEventLog
 *
 * Everything else in the system imports these from @tictactoe/core's index.
 */

/** Server-minted id that identifies a game; it is the game's shareable URL. */
export type GameId = string;

/** The two seats. */
export type Player = 'X' | 'O';

/** A board cell index, 0..8. */
export type Cell = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Exactly 9 cells, each empty or holding a player's mark. */
export type Board = (Player | null)[];

/** waiting = one seat bound, active = both seats bound, won/draw = terminal. */
export type GameStatus = 'waiting' | 'active' | 'won' | 'draw';

/**
 * Opaque, server-minted identity for a seat holder. NOT an account.
 * Kept in a cookie by the client so a refresh re-joins the same seat.
 */
export type PlayerToken = string;

/** The authoritative, server-owned game state. Clients only render this. */
export interface GameState {
  id: GameId;
  board: Board;
  /** Whose move is next (valid only while status === 'active'). */
  turn: Player;
  status: GameStatus;
  /** Non-null iff status === 'won'. */
  winner: Player | null;
  /**
   * Seat -> bound token. A seat is "taken"/bound iff its key is present.
   * A game is full exactly when both keys are present.
   */
  seats: Partial<Record<Player, PlayerToken>>;
}

/** Discrete, ordered events. Ordering is the log; the reducer folds them. */
export type GameEvent =
  | { type: 'Joined'; seat: Player; token: PlayerToken }
  | { type: 'Move'; cell: Cell; player: Player };

// ---------------------------------------------------------------------------
// Reducer signatures (implemented in ./reducer)
// ---------------------------------------------------------------------------

/**
 * Pure: (state, event) -> state. Deterministic, no clocks/randomness/IO.
 *
 * A rejected/invalid event MUST return the input state BY REFERENCE (no copy):
 * the server treats `next === state` as the rejection signal, so an equal copy
 * would make it append illegal events to the durable log without an error.
 */
export type Reducer = (state: GameState, event: GameEvent) => GameState;

/** Fresh empty game: empty board, turn X, status 'waiting', seats empty. */
export type InitialState = (gameId: GameId) => GameState;

/** Fold events into state in order. */
export type ApplyEvents = (initial: GameState, events: GameEvent[]) => GameState;

/** A winning player, or null if no line is complete. */
export type CheckWinner = (board: Board) => Player | null;

/** True if all 9 cells are marked. */
export type IsBoardFull = (board: Board) => boolean;

/** All eight 3-in-a-row lines (rows, columns, diagonals). */
export const winningLines: readonly [Cell, Cell, Cell][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

// ---------------------------------------------------------------------------
// Seat signatures (implemented in ./seats)
// ---------------------------------------------------------------------------

/** First unbound seat in X then O order, or null if both are bound (full). */
export type NextFreeSeat = (state: GameState) => Player | null;

export type JoinResult =
  | { kind: 'joined'; seat: Player; token: PlayerToken; state: GameState } // new seat bound + a Joined event folded
  | { kind: 'rejoined'; seat: Player; state: GameState } // token already bound; no new event
  | { kind: 'full' }; // both seats bound and the token is not one of them

/**
 * Resolve a join for an anonymous token. If the token is already bound to a
 * seat, rejoin it (no new event). Otherwise bind the first free seat (X then
 * O) and fold a Joined event. If both seats are bound and the token isn't one
 * of them -> { kind:'full' }.
 */
export type Join = (state: GameState, token: PlayerToken) => JoinResult;

// ---------------------------------------------------------------------------
// Event-log signatures (implemented in ./event-log)
// ---------------------------------------------------------------------------

/** An event stamped with its server-assigned sequence number. */
export interface StampedEvent {
  seq: number;
  event: GameEvent;
}

/**
 * Append-only log whose sequence numbers are STRICTLY MONOTONIC and GAPLESS
 * from 0. fetchAfter(lastSeq) returns every event with seq > lastSeq in
 * ascending order — this is the entire replay window.
 */
export interface EventLog {
  /** Append and return the seq-stamped event. First appended event has seq 0. */
  append(event: GameEvent): StampedEvent;
  /** All events with seq > lastSeq, ascending. Empty when lastSeq is current. */
  fetchAfter(lastSeq: number): StampedEvent[];
  /** The latest seq assigned, or -1 if the log is empty. */
  latestSeq(): number;
}

/** In-memory EventLog (no persistence); the server's SQLite store implements the same EventLog interface. */
export type InMemoryEventLog = () => EventLog;
