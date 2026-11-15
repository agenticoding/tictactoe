import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '@tictactoe/server';
import type { GameState } from '@tictactoe/core';
import {
  createJoiner,
  createMessageQueue,
  openSocket,
  waitForClose,
  type MessageQueue,
} from './ws-helpers';

/**
 * Gate: the WebSocket error contract.
 *
 * One shared server; each case uses its own game id, which is clean isolation
 * because all server state (seats, log, sockets) is keyed per game. Every
 * assertion pins the exact user-visible `{type:'error', code, message}` frame.
 */
describe('websocket error contract (real ws)', () => {
  let server: GameServer;
  const sockets: WebSocket[] = [];
  let joinAs: ReturnType<typeof createJoiner>;

  const track = (ws: WebSocket): WebSocket => {
    sockets.push(ws);
    ws.on('error', () => {});
    return ws;
  };

  beforeAll(async () => {
    server = createGameServer({
      eventLog: { dbPath: ':memory:' },
      clientDistDir: '<nonexistent>',
      createId: () => 'g1',
    });
    await server.start(0);
    joinAs = createJoiner(track, server);
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

  async function expectError(queue: MessageQueue, code: string, message: string): Promise<void> {
    expect(await queue.next((m) => m.type === 'error')).toEqual({ type: 'error', code, message });
  }

  it('rejects malformed JSON as invalid-message', async () => {
    const ws = track(await openSocket(server.wsUrl('bad-json')));
    const queue = createMessageQueue(ws);
    ws.send('{not valid json');
    await expectError(queue, 'invalid-message', 'Malformed message.');
  });

  it('rejects parsed non-object JSON frames without crashing the server', async () => {
    const ws = track(await openSocket(server.wsUrl('non-object-frame')));
    const queue = createMessageQueue(ws);
    // JSON.parse succeeds on all of these; reading `.type` must not throw.
    for (const frame of ['null', '5', '"hello"', '[]']) {
      ws.send(frame);
      await expectError(queue, 'invalid-message', 'Malformed message.');
    }
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects an unknown message type as invalid-message', async () => {
    const ws = track(await openSocket(server.wsUrl('unknown-type')));
    const queue = createMessageQueue(ws);
    ws.send(JSON.stringify({ type: 'frobnicate' }));
    await expectError(queue, 'invalid-message', 'Malformed message.');
  });

  it('rejects a move before hello as invalid-game', async () => {
    const ws = track(await openSocket(server.wsUrl('move-before-hello')));
    const queue = createMessageQueue(ws);
    ws.send(JSON.stringify({ type: 'move', cell: 0 }));
    await expectError(queue, 'invalid-game', 'That game does not exist.');
  });

  it('rejects an out-of-turn move as not-your-turn', async () => {
    await joinAs('out-of-turn'); // X
    const o = await joinAs('out-of-turn');
    o.ws.send(JSON.stringify({ type: 'move', cell: 0 })); // X moves first
    await expectError(o.queue, 'not-your-turn', 'It is not your turn.');
  });

  it('rejects a second hello on the same socket and keeps the seat binding', async () => {
    const gameId = 'double-hello';
    const x = await joinAs(gameId); // X

    x.ws.send(JSON.stringify({ type: 'hello', gameId }));
    await expectError(x.queue, 'invalid-message', 'Malformed message.');

    // The socket kept seat X and O is still free for a new visitor.
    const o = await joinAs(gameId);
    expect(o.welcome.player).toBe('O');
    expect(o.welcome.state.seats.X).toBe(x.welcome.token);

    // The original socket still moves as X (proves it was not rebound to O).
    x.ws.send(JSON.stringify({ type: 'move', cell: 0 }));
    const moved = await o.queue.next((m) => m.type === 'state' && m.state.board[0] === 'X');
    expect(moved.state.turn).toBe('O');
  });

  it('rejects malformed cells as invalid-message, not invalid-move', async () => {
    const gameId = 'bad-cells';
    const x = await joinAs(gameId);
    await joinAs(gameId); // game active, X on turn

    for (const cell of [99, -1, 1.5, '0', undefined]) {
      x.ws.send(JSON.stringify({ type: 'move', cell }));
      await expectError(x.queue, 'invalid-message', 'Malformed message.');
    }
  });

  it('rejects a move onto an occupied cell as invalid-move', async () => {
    const x = await joinAs('occupied');
    const o = await joinAs('occupied');
    x.ws.send(JSON.stringify({ type: 'move', cell: 0 }));
    await o.queue.next((m) => m.type === 'state' && m.seq === 2);
    o.ws.send(JSON.stringify({ type: 'move', cell: 0 }));
    await expectError(o.queue, 'invalid-move', 'That cell is already taken.');
  });

  it('rejects a move while the game is waiting as not-your-turn', async () => {
    const x = await joinAs('waiting'); // only X is seated
    x.ws.send(JSON.stringify({ type: 'move', cell: 4 }));
    await expectError(x.queue, 'not-your-turn', 'It is not your turn.');
  });

  /** Drive alternating moves and resolve with the terminal state. */
  async function playMoves(
    observe: MessageQueue,
    startSeq: number,
    moves: Array<[WebSocket, number]>,
  ): Promise<{ seq: number; state: GameState }> {
    let seq = startSeq;
    let state: GameState | undefined;
    for (const [ws, cell] of moves) {
      ws.send(JSON.stringify({ type: 'move', cell }));
      seq += 1;
      const frame = await observe.next((m) => m.type === 'state' && m.seq === seq);
      state = frame.state;
    }
    return { seq, state: state as GameState };
  }

  it('rejects a move after a win as game-over', async () => {
    const x = await joinAs('won');
    const o = await joinAs('won');
    // X completes the top row on its 3rd move (seq 6).
    const { state } = await playMoves(o.queue, 1, [
      [x.ws, 0],
      [o.ws, 3],
      [x.ws, 1],
      [o.ws, 4],
      [x.ws, 2],
    ]);
    expect(state.status).toBe('won');
    expect(state.winner).toBe('X');
    o.ws.send(JSON.stringify({ type: 'move', cell: 5 }));
    await expectError(o.queue, 'game-over', 'This game is over.');
  });

  it('rejects a move after a draw as game-over', async () => {
    const x = await joinAs('drawn');
    const o = await joinAs('drawn');
    const { state } = await playMoves(o.queue, 1, [
      [x.ws, 0],
      [o.ws, 1],
      [x.ws, 2],
      [o.ws, 4],
      [x.ws, 3],
      [o.ws, 5],
      [x.ws, 7],
      [o.ws, 6],
      [x.ws, 8],
    ]);
    expect(state.status).toBe('draw');
    o.ws.send(JSON.stringify({ type: 'move', cell: 4 }));
    await expectError(o.queue, 'game-over', 'This game is over.');
  });

  it('evicts the previous socket with a seat-evicted error frame when a seat is rejoined with its token', async () => {
    const first = await joinAs('rejoin');
    const firstClosed = waitForClose(first.ws);
    const second = await joinAs('rejoin', first.welcome.token);
    await firstClosed;
    // The displaced socket is told WHY it was closed, so its client stops
    // reconnecting instead of evicting the new window straight back.
    await expectError(first.queue, 'seat-evicted', 'This game is open in another window.');
    expect(first.ws.readyState).toBe(WebSocket.CLOSED);
    expect(second.welcome.player).toBe(first.welcome.player);
    expect(second.welcome.token).toBe(first.welcome.token);
  });
});
