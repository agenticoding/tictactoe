import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { EventLog, GameEvent, GameId, StampedEvent } from '@tictactoe/core';
import { createGameStore, type GameStore } from './games';

// `node:sqlite` is loaded via runtime require (not a static import) because
// the pinned vitest 2.1 / vite-node resolver predates the builtin and fails
// to resolve a static `from 'node:sqlite'` at test time. Type-only imports
// are erased before resolution, so they are safe. Runtime node handles the
// require fine (verified on Node 24).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type Db = DatabaseSyncType;

/**
 * Open the file-backed db, creating missing parent dirs first, then ensure the
 * events table. SQLite cannot create directories, and the opener owns the path
 * precondition — so the opener (not the caller) creates the parent.
 */
export function openGameDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS events (game_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (game_id, seq)); CREATE TABLE IF NOT EXISTS games (game_id TEXT PRIMARY KEY)',
  );
  return db;
}

/** SQLite-backed EventLog for one game. State is never stored; replay the log. */
export function createSqliteEventLog(db: Db, gameId: GameId): EventLog {
  return {
    append(event: GameEvent): StampedEvent {
      const row = db
        .prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM events WHERE game_id = ?')
        .get(gameId) as { s: number };
      const seq: number = row.s + 1;
      db.prepare('INSERT INTO events (game_id, seq, payload) VALUES (?, ?, ?)').run(
        gameId,
        seq,
        JSON.stringify(event),
      );
      return { seq, event };
    },
    fetchAfter(lastSeq: number): StampedEvent[] {
      const rows = db
        .prepare('SELECT seq, payload FROM events WHERE game_id = ? AND seq > ? ORDER BY seq')
        .all(gameId, lastSeq) as { seq: number; payload: string }[];
      return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as GameEvent }));
    },
    latestSeq(): number {
      const row = db
        .prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM events WHERE game_id = ?')
        .get(gameId) as { s: number };
      return row.s;
    },
  };
}

/** Every explicitly minted game plus legacy games with persisted events. */
export function listGameIds(db: Db): GameId[] {
  const rows = db
    .prepare('SELECT game_id FROM games UNION SELECT DISTINCT game_id FROM events')
    .all() as { game_id: string }[];
  return rows.map((r) => r.game_id);
}

/** Persistent store: one SQLite db shared across games, state rebuilt by replay. */
export function createSqliteGameStore(dbPath: string): GameStore {
  const db = openGameDb(dbPath);
  return createGameStore({
    createEventLog: (gid) => createSqliteEventLog(db, gid),
    listGameIds: () => listGameIds(db),
    mintGame: (gameId) => {
      db.prepare('INSERT OR IGNORE INTO games (game_id) VALUES (?)').run(gameId);
    },
    cleanup: () => db.close(),
  });
}
