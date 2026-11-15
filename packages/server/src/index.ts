import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { wsPath } from '@tictactoe/core';
import type { GameId, PlayerToken } from '@tictactoe/core';
import { createGameStore, type GameStore } from './games';
import { createSqliteGameStore } from './event-log-sqlite';
import { handleConnection, sweepSockets, type ClientSocket } from './ws-handler';
import { handleNewGame, sendText, serveApp } from './static';

export interface GameServerOptions {
  /** Directory holding the built client SPA. Defaults to `<repo>/packages/client/dist`. */
  clientDistDir?: string;
  /** Game-id minting function; injectable for deterministic tests. Defaults to crypto.randomUUID. */
  createId?: () => string;
  /** When set, persist event logs to SQLite at dbPath (else in-memory). */
  eventLog?: { dbPath: string };
  /** Player-token mint; injectable for deterministic tests. */
  createToken?: () => PlayerToken;
  /** Heartbeat sweep interval in ms; injectable so tests need not wait 30s. */
  heartbeatIntervalMs?: number;
}

export interface GameServer {
  /** Bind and start listening; resolves with the ACTUAL bound port (ephemeral when port===0). */
  start(port: number): Promise<number>;
  close(): Promise<void>;
  /** "http://localhost:<boundPort>" — safe to call only after start(). */
  origin(): string;
  /** "ws://localhost:<boundPort>/g/<id>/ws" — safe to call only after start(). */
  wsUrl(gameId: GameId): string;
  /** Test fixture hook for pre-registering deterministic game IDs. */
  mint(gameId: GameId): void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIENT_DIST = path.resolve(__dirname, '..', '..', 'client', 'dist');

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  createId: () => string,
  store: GameStore,
  clientDistDir: string,
): void {
  if (req.method !== 'GET') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/api/new-game') {
    handleNewGame(res, () => {
      const gameId = createId();
      store.mint(gameId);
      return gameId;
    });
    return;
  }
  serveApp(req, res, clientDistDir);
}

export function createGameServer(opts?: GameServerOptions): GameServer {
  const clientDistDir = opts?.clientDistDir ?? DEFAULT_CLIENT_DIST;
  const createId = opts?.createId ?? (() => randomUUID());
  const store: GameStore = opts?.eventLog
    ? createSqliteGameStore(opts.eventLog.dbPath)
    : createGameStore();
  const createToken = opts?.createToken ?? (() => `tok-${randomUUID()}`);
  const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const sockets = new Set<ClientSocket>();

  const server: Server = createServer((req, res) => handleHttp(req, res, createId, store, clientDistDir));
  const wss = new WebSocketServer({ noServer: true });

  // Only `/g/:id/ws` upgrades to a WebSocket; everything else is left to HTTP.
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const match = /^\/g\/([^/]+)\/ws$/.exec(pathname);
    if (match === null) {
      socket.destroy();
      return;
    }
    const gameId = match[1] as string; // regex guarantees the capture group
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(store, ws as unknown as ClientSocket, gameId, sockets, { createToken });
    });
  });

  let boundPort: number | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  return {
    async start(port) {
      await new Promise<void>((resolve, reject) => {
        // Reject only covers the listen phase; the listener is removed on
        // success so post-listen errors aren't swallowed by a resolved promise.
        const onListenError = (err: Error) => reject(err);
        server.once('error', onListenError);
        server.listen(port, () => {
          server.removeListener('error', onListenError);
          const addr = server.address();
          if (addr === null || typeof addr === 'string') {
            server.close();
            reject(new Error('Could not read the bound port'));
            return;
          }
          boundPort = addr.port;
          resolve();
        });
      });
      // Post-listen failures (e.g. the port drops) must be visible, never
      // silently vanish or crash the process by default.
      server.on('error', (err) => console.error('[server] http server error:', err));
      heartbeat = setInterval(() => sweepSockets(sockets), heartbeatIntervalMs);
      return boundPort as number;
    },

    async close() {
      if (heartbeat !== null) clearInterval(heartbeat);
      for (const s of sockets) s.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
    },

    origin() {
      if (boundPort === null) throw new Error('GameServer is not started');
      return `http://localhost:${boundPort}`;
    },

    wsUrl(gameId) {
      if (boundPort === null) throw new Error('GameServer is not started');
      return `ws://localhost:${boundPort}${wsPath(gameId)}`;
    },

    mint(gameId) {
      store.mint(gameId);
    },
  };
}
