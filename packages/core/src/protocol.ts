import type { Cell, GameEvent, GameId, GameState, Player, PlayerToken } from './domain';

/**
 * Wire protocol shared by server and client. Importing these types keeps the
 * client and server on a single source of truth (no drifting message shapes).
 */

export const gamePath = (id: GameId): string => `/g/${id}`;
/** WebSocket upgrade route for a game (same id as its URL). */
export const wsPath = (id: GameId): string => `/g/${id}/ws`;

// --- Client -> Server ---

/** Sent on connect. token is absent for a brand-new visitor (first join). */
export interface HelloMessage {
  type: 'hello';
  gameId: GameId;
  token?: PlayerToken;
  /** Last sequence already applied by the client; resume/replay anchor. */
  lastSeq?: number;
}
/** A move from this client's seat. The server validates turn + empty cell. */
export interface MoveMessage {
  type: 'move';
  cell: Cell;
}
/** Confirms receipt of a newly minted seat token before its join is persisted. */
export interface AckMessage {
  type: 'ack';
}
export type ClientMessage = HelloMessage | MoveMessage | AckMessage;

// --- Server -> Client ---

/** Sent once after a successful join (new or rejoin): your seat + current state. */
export interface WelcomeMessage {
  type: 'welcome';
  gameId: GameId;
  player: Player;
  token: PlayerToken;
  /** The latest sequence at join; the client anchors its lastSeq here. */
  seq: number;
  state: GameState;
}
/**
 * Pushed after every state change (and as the final frame of a replay window).
 * `seq` is the log's latest sequence that produced this state, so the client can
 * track exactly how far behind it is — reconnect replays everything after it.
 */
export interface StateMessage {
  type: 'state';
  seq: number;
  state: GameState;
}
/** A single appended event (replay window for a rejoining client). */
export interface EventMessage {
  type: 'event';
  seq: number;
  event: GameEvent;
}
export type ErrorCode =
  | 'seat-evicted'
  | 'game-full'
  | 'not-your-turn'
  | 'invalid-move'
  | 'game-over'
  | 'invalid-game'
  | 'invalid-message';
export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}
export type ServerMessage = WelcomeMessage | StateMessage | EventMessage | ErrorMessage;

/** Friendly copy for the primary user-facing failure. */
export const GAME_FULL_MESSAGE = 'This game is already full.';
/** Copy for a seat whose socket was displaced by another window with its token. */
export const SEAT_EVICTED_MESSAGE = 'This game is open in another window.';
