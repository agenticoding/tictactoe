import type { EventLog, GameId, GameState, Player, PlayerToken } from '@tictactoe/core';
import { applyEvents, createInMemoryEventLog, initialState } from '@tictactoe/core';
import type { WebSocket } from 'ws';

/** A live game: authoritative state, its append-only event log, and live sockets by seat. */
export interface PendingJoin {
  seat: Player;
  token: PlayerToken;
  socket: WebSocket;
}

export interface GameRecord {
  state: GameState;
  log: EventLog;
  sockets: Map<Player, WebSocket>;
  /** Token delivered but not yet acknowledged; never persisted. */
  pending: Map<Player, PendingJoin>;
}

export interface GameStoreOptions {
  createEventLog?: (gameId: GameId) => EventLog;
  listGameIds?: () => GameId[];
  mintGame?: (gameId: GameId) => void;
  cleanup?: () => void;
}

/** Game registry; hydrates persisted games by replaying their logs on construction. */
export interface GameStore {
  get(gameId: GameId): GameRecord | undefined;
  /** Register a game before it may accept WebSocket joins. */
  mint(gameId: GameId): void;
  /** Lazily create a record for a game on first touch (via initialState(gameId)). */
  getOrCreate(gameId: GameId): GameRecord;
  close(): Promise<void>;
}

export function createGameStore(opts?: GameStoreOptions): GameStore {
  const games = new Map<GameId, GameRecord>();
  const createEventLog = opts?.createEventLog ?? (() => createInMemoryEventLog());

  // Hydrate: state is never persisted; rebuild via applyEvents over the full log.
  for (const gameId of opts?.listGameIds?.() ?? []) {
    const log = createEventLog(gameId);
    const state = applyEvents(
      initialState(gameId),
      log.fetchAfter(-1).map((s) => s.event),
    );
    games.set(gameId, { state, log, sockets: new Map(), pending: new Map() });
  }

  return {
    get: (gameId) => games.get(gameId),
    mint(gameId) {
      if (games.has(gameId)) return;
      opts?.mintGame?.(gameId);
      games.set(gameId, {
        state: initialState(gameId),
        log: createEventLog(gameId),
        sockets: new Map(),
        pending: new Map(),
      });
    },
    getOrCreate(gameId) {
      let record = games.get(gameId);
      if (record === undefined) {
        record = {
          state: initialState(gameId),
          log: createEventLog(gameId),
          sockets: new Map(),
          pending: new Map(),
        };
        games.set(gameId, record);
      }
      return record;
    },
    async close() {
      opts?.cleanup?.();
    },
  };
}
