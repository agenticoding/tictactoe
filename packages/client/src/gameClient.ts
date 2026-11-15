import {
  GAME_FULL_MESSAGE,
  initialState,
  reduce,
  type ErrorCode,
  type GameId,
  type GameState,
  type Player,
  type PlayerToken,
  type ServerMessage,
} from '@tictactoe/core';

/**
 * The client's recovery state machine, extracted as pure functions so the
 * reconnect/replay logic is testable with no WebSocket, no DOM, no mocks.
 *
 * `replayBase` is both the replay accumulator AND the resume anchor: it advances
 * on every `event` frame (via the real core `reduce`) and on the final `state`
 * frame, so a drop mid-replay reports a consistent `{ lastSeq, base }` and can
 * never double-apply. `state` is the RENDERED state — it only changes on the
 * authoritative `state` frame, so the UI never flashes intermediate replay
 * states.
 */
export interface GameClientView {
  /** Rendered, authoritative state. Updated ONLY by the final `state` frame. */
  state: GameState | null;
  player: Player | null;
  token: PlayerToken | null;
  error: string | null;
  /** Latest sequence already applied; the reconnect/resume anchor. */
  lastSeq: number;
  /** Replay accumulator AND resume base. Advances on `event` and `state`. */
  replayBase: GameState | null;
  /** True inside a replay window (between welcome and the final `state`). */
  replaying: boolean;
  /** A terminal error (game-full, seat-evicted) has stopped all reconnection. */
  terminal: boolean;
  /** The error code behind `error`, if any; drives the terminal dialog title. */
  errorCode: ErrorCode | null;
}

export function initialView(): GameClientView {
  return {
    state: null,
    player: null,
    token: null,
    error: null,
    errorCode: null,
    lastSeq: -1,
    replayBase: null,
    replaying: false,
    terminal: false,
  };
}

/** The protocol's friendly copy for the primary user-facing failure. */
export function gameFullError(code: string, message: string): string {
  return code === 'game-full' ? GAME_FULL_MESSAGE : message;
}

/** Short dialog titles per terminal code; one map, sane fallback. */
const TERMINAL_TITLES: Partial<Record<ErrorCode, string>> = {
  'game-full': 'Game full',
  'seat-evicted': 'Game open elsewhere',
  'invalid-game': 'Game unavailable',
};

/** Title for the terminal error dialog, derived from the error code. */
export function terminalErrorTitle(code: string | null | undefined): string {
  return (code !== null && code !== undefined ? TERMINAL_TITLES[code as ErrorCode] : undefined) ?? 'Game unavailable';
}

export function applyServerMessage(
  view: GameClientView,
  msg: ServerMessage,
  gameId: GameId,
): GameClientView {
  switch (msg.type) {
    case 'welcome':
      // Fresh join: seed the replay from the engine's initial state; reconnect:
      // keep the previously committed replayBase as the resume base. Either way
      // the event window that follows is reduced onto this base. lastSeq jumps
      // to the join point so a drop before the first event resumes from there.
      // A terminal error ends the session; a welcome must not resurrect it or
      // clear the terminal copy (the dialog would render blank).
      return {
        ...view,
        token: msg.token,
        player: msg.player,
        error: view.terminal ? view.error : null,
        lastSeq: msg.seq,
        replayBase: view.replayBase ?? initialState(gameId),
        replaying: true,
      };
    case 'event':
      if (!view.replaying) return view;
      return {
        ...view,
        replayBase: reduce(view.replayBase ?? initialState(gameId), msg.event),
        lastSeq: msg.seq,
      };
    case 'state':
      return {
        ...view,
        state: msg.state,
        replayBase: msg.state,
        lastSeq: msg.seq,
        replaying: false,
        error: null,
      };
    case 'error':
      return {
        ...view,
        error: gameFullError(msg.code, msg.message),
        errorCode: msg.code,
        // seat-evicted stops reconnecting like game-full: the seat is simply
        // held by another live window, so retrying would evict it right back.
        terminal:
          view.terminal ||
          msg.code === 'game-full' ||
          msg.code === 'seat-evicted' ||
          msg.code === 'invalid-game',
      };
  }
}

/** Exponential reconnect backoff: 1s, 2s, 4s, 8s, capped at 10s. */
export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10000);
}
