import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '@tictactoe/server';
import { GAME_FULL_MESSAGE } from '@tictactoe/core';
import {
  createJoiner,
  createMessageQueue,
  getJson,
  openSocket,
  waitForClose,
  type MessageQueue,
} from './ws-helpers';

/**
 * E2E lifecycle contract. The server is shared (started once), but every test
 * uses its OWN game id so games never observe each other's state — failures
 * pinpoint the broken interaction instead of a single long sequential scenario.
 */
describe('realtime game lifecycle (real ws + in-memory server)', () => {
  let server: GameServer;
  const sockets: WebSocket[] = [];
  let join: ReturnType<typeof createJoiner>;

  const track = (ws: WebSocket): WebSocket => {
    sockets.push(ws);
    return ws;
  };

  beforeAll(async () => {
    server = createGameServer({
      eventLog: { dbPath: ':memory:' },
      clientDistDir: '<nonexistent>',
      createId: () => 'g1',
    });
    await server.start(0);
    join = createJoiner(track, server);
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

  it('GET /api/new-game mints the id from the injected factory', async () => {
    const created = await getJson(`${server.origin()}/api/new-game`);
    expect(created).toEqual({ gameId: 'g1' });
  });

  it('rejects an unminted id without creating it', async () => {
    const ws = track(await openSocket(server.wsUrl('never-minted')));
    const queue = createMessageQueue(ws);
    ws.send(JSON.stringify({ type: 'hello', gameId: 'never-minted' }));

    expect(await queue.next((m) => m.type === 'error')).toEqual({
      type: 'error',
      code: 'invalid-game',
      message: 'That game does not exist.',
    });
    await waitForClose(ws);
  });

  it('two joins bind X then O and flip the game waiting -> active', async () => {
    const gameId = 'join-order';
    const x = await join(gameId);
    expect(x.welcome.player).toBe('X');
    expect(typeof x.welcome.token).toBe('string');
    expect(x.welcome.token.length).toBeGreaterThan(0);
    expect(x.welcome.state.status).toBe('waiting');

    const o = await join(gameId);
    expect(o.welcome.player).toBe('O');
    expect(o.welcome.state.status).toBe('active');
    expect(o.welcome.state.seats.X).toBe(x.welcome.token);
    expect(o.welcome.state.seats.O).toBe(o.welcome.token);
  });

  it('a move by X lands on the O socket as a state with board[0] === X', async () => {
    const gameId = 'move-broadcast';
    const x = await join(gameId);
    const o = await join(gameId);

    // Drain X's join broadcast so it cannot be mistaken for the move frame.
    await x.queue.next((m: any) => m.type === 'state' && m.seq === 1);

    x.ws.send(JSON.stringify({ type: 'move', cell: 0 }));
    const oState = await o.queue.next((m: any) => m.type === 'state' && m.state.board[0] === 'X');
    expect(oState.state.turn).toBe('O');
    expect(oState.state.status).toBe('active');
  });

  it('reconnects a pre-ACK token and commits exactly one join', async () => {
    const gameId = 'reconnect-before-ack';
    server.mint(gameId);
    const first = track(await openSocket(server.wsUrl(gameId)));
    const firstQueue = createMessageQueue(first);
    first.send(JSON.stringify({ type: 'hello', gameId }));
    const firstWelcome = await firstQueue.next((m) => m.type === 'welcome');
    const reconnect = track(await openSocket(server.wsUrl(gameId)));
    const reconnectQueue = createMessageQueue(reconnect);
    reconnect.send(JSON.stringify({ type: 'hello', gameId, token: firstWelcome.token }));
    const reconnectWelcome = await reconnectQueue.next((m) => m.type === 'welcome');
    expect(reconnectWelcome.seq).toBe(-1);
    reconnect.send(JSON.stringify({ type: 'ack' }));
    const committed = await reconnectQueue.next((m) => m.type === 'state' && m.seq === 0);
    expect(committed.state.seats.X).toBe(firstWelcome.token);

    const o = await join(gameId);
    expect(o.welcome.player).toBe('O');
    expect(o.welcome.seq).toBe(1);
  });

  it('releases an unacknowledged seat when its socket closes', async () => {
    const gameId = 'close-before-ack';
    server.mint(gameId);
    const pending = track(await openSocket(server.wsUrl(gameId)));
    const queue = createMessageQueue(pending);
    pending.send(JSON.stringify({ type: 'hello', gameId }));
    await queue.next((m) => m.type === 'welcome');
    pending.terminate();
    await waitForClose(pending);

    expect((await join(gameId)).welcome.player).toBe('X');
  });

  it('a third join is rejected as game-full and the socket closes', async () => {
    const gameId = 'game-full';
    await join(gameId);
    await join(gameId);

    const third = track(await openSocket(server.wsUrl(gameId)));
    const thirdQueue = createMessageQueue(third);
    third.send(JSON.stringify({ type: 'hello', gameId }));
    const error = await thirdQueue.next((m: any) => m.type === 'error');
    expect(error.code).toBe('game-full');
    expect(error.message).toBe(GAME_FULL_MESSAGE);

    await waitForClose(third);
  });

  it('reopening with the same token rejoins the same seat without consuming one', async () => {
    const gameId = 'rejoin';
    const x = await join(gameId);
    await join(gameId);

    const rejoin = await join(gameId, x.welcome.token);
    expect(rejoin.welcome.player).toBe('X');
    expect(rejoin.welcome.token).toBe(x.welcome.token);
  });
});
