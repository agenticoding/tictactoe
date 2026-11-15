import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '@tictactoe/server';
import { sweepSockets, type ClientSocket } from '../src/ws-handler';
import { createMessageQueue, openSocket } from './ws-helpers';

/**
 * Heartbeat liveness contract, unit-tested via the exported `sweepSockets`.
 *
 * The rule: a socket that missed the previous ping is terminated; a live socket
 * is pinged and marked dead so the next sweep can tell whether its pong landed.
 * Fake sockets keep this deterministic — no timer, no network.
 */
function fakeSocket(isAlive: boolean, pingImpl?: () => void) {
  const ping = vi.fn(pingImpl);
  const terminate = vi.fn();
  const socket = { isAlive, ping, terminate } as unknown as ClientSocket;
  return { socket, ping, terminate };
}

describe('sweepSockets heartbeat liveness', () => {
  it('terminates a socket that missed the previous ping', () => {
    const { socket, ping, terminate } = fakeSocket(false);
    sweepSockets(new Set([socket]));
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(ping).not.toHaveBeenCalled();
  });

  it('pings a live socket and marks it dead for the next sweep', () => {
    const { socket, ping, terminate } = fakeSocket(true);
    sweepSockets(new Set([socket]));
    expect(ping).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
    expect(socket.isAlive).toBe(false);
  });

  it('terminates a socket whose ping throws', () => {
    const { socket, terminate } = fakeSocket(true, () => {
      throw new Error('socket already closed');
    });
    sweepSockets(new Set([socket]));
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('sweeps a mixed set independently', () => {
    const dead = fakeSocket(false);
    const live = fakeSocket(true);
    sweepSockets(new Set([dead.socket, live.socket]));
    expect(dead.terminate).toHaveBeenCalledTimes(1);
    expect(dead.ping).not.toHaveBeenCalled();
    expect(live.terminate).not.toHaveBeenCalled();
    expect(live.ping).toHaveBeenCalledTimes(1);
    expect(live.socket.isAlive).toBe(false);
  });
});

/**
 * Await N observed server pings. The real client auto-pongs, so surviving N
 * pings proves N sweeps kept it alive — no wall-clock sleep needed.
 */
function awaitPings(ws: WebSocket, count: number, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const done = (err?: Error) => {
      ws.removeListener('ping', onPing);
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const onPing = () => {
      seen += 1;
      if (seen >= count) done();
    };
    const timer = setTimeout(() => done(new Error(`only ${seen}/${count} pings observed`)), timeoutMs);
    ws.on('ping', onPing);
  });
}

/**
 * Integration proof: a real `ws` client auto-answers server pings, so the
 * `pong` handler keeps it alive across many real sweeps. A tiny interval turns
 * the 30s default into an observable number of sweeps.
 */
describe('heartbeat sweep keeps a real client alive', () => {
  let server: GameServer;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    server = createGameServer({
      eventLog: { dbPath: ':memory:' },
      clientDistDir: '<nonexistent>',
      createId: () => 'hb',
      heartbeatIntervalMs: 200,
    });
    await server.start(0);
    server.mint('hb');
  });

  afterAll(async () => {
    for (const s of sockets) {
      try {
        s.terminate();
      } catch {
        /* already closed */
      }
    }
    await server.close();
  });

  it('survives several sweeps and still processes messages', async () => {
    const ws = await openSocket(server.wsUrl('hb'));
    sockets.push(ws);
    ws.on('error', () => {});
    const queue = createMessageQueue(ws);
    ws.send(JSON.stringify({ type: 'hello', gameId: 'hb' }));
    await queue.next((m) => m.type === 'welcome');

    // Survive 4 observed sweeps; a missed pong would have terminated the socket.
    await awaitPings(ws, 4);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Still live: the server processes and replies to this malformed frame.
    ws.send('{');
    expect(await queue.next((m) => m.type === 'error')).toEqual({
      type: 'error',
      code: 'invalid-message',
      message: 'Malformed message.',
    });
  });
});
