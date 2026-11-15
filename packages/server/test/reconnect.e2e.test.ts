import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '@tictactoe/server';
import { applyEvents, initialState, type GameEvent, type GameState } from '@tictactoe/core';
import { acknowledgeJoin, createMessageQueue, openSocket, waitForClose, type MessageQueue } from './ws-helpers';

/**
 * Gate: reconnect & never drift.
 *
 * One server backed by an in-memory SQLite store. A single `it` walks the whole
 * game sequentially (the log is ordered and append-only), which keeps the shared
 * `g1` game from being observed in contradictory states by parallel blocks.
 */
describe('reconnect + replay (real ws + in-memory sqlite)', () => {
  let server: GameServer;
  const sockets: WebSocket[] = [];

  const track = (ws: WebSocket): WebSocket => {
    sockets.push(ws);
    // A terminating/reconnecting socket can emit a client-side 'error' (RST);
    // swallow it so it never crashes vitest with an unhandled error event.
    ws.on('error', () => {});
    return ws;
  };

  beforeAll(async () => {
    server = createGameServer({
      eventLog: { dbPath: ':memory:' },
      createId: () => 'g1',
      clientDistDir: '<nonexistent>',
    });
    await server.start(0);
    server.mint('g1');
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

  it('reconnect with lastSeq=N delivers N+1..in order and converges', async () => {
    const wsUrl = server.wsUrl('g1');

    // 1. X receives a token before its join event is committed, then ACKs it.
    const xSocket = track(await openSocket(wsUrl));
    const xQueue = createMessageQueue(xSocket);
    xSocket.send(JSON.stringify({ type: 'hello', gameId: 'g1' }));
    const xWelcome = await xQueue.next((m) => m.type === 'welcome');
    expect(xWelcome.player).toBe('X');
    expect(xWelcome.seq).toBe(-1);
    expect(xWelcome.state.status).toBe('waiting');
    const xToken: string = xWelcome.token;
    await acknowledgeJoin(xSocket, xQueue, xWelcome);

    // 2. O does the same. Its pre-ACK welcome sees only X; ACK appends seq 1.
    const oSocket = track(await openSocket(wsUrl));
    const oQueue = createMessageQueue(oSocket);
    oSocket.send(JSON.stringify({ type: 'hello', gameId: 'g1' }));
    const oWelcome = await oQueue.next((m) => m.type === 'welcome');
    expect(oWelcome.player).toBe('O');
    expect(oWelcome.seq).toBe(0);
    expect(oWelcome.state.status).toBe('waiting');
    expect(oWelcome.state.seats.X).toBe(xToken);
    const oToken: string = oWelcome.token;
    await Promise.all([
      acknowledgeJoin(oSocket, oQueue, oWelcome),
      xQueue.next((m) => m.type === 'state' && m.seq === 1),
    ]);

    // 3. X moves cell 0 (seq 2). Both clients receive state seq:2, board[0]='X'.
    xSocket.send(JSON.stringify({ type: 'move', cell: 0 }));
    const xAfterMove = xQueue.next(
      (m) => m.type === 'state' && m.state.board[0] === 'X' && m.seq === 2,
    );
    const oAfterMove = oQueue.next(
      (m) => m.type === 'state' && m.state.board[0] === 'X' && m.seq === 2,
    );
    const [xState, oState] = await Promise.all([xAfterMove, oAfterMove]);
    expect(xState.state.turn).toBe('O');
    expect(oState.state.turn).toBe('O');

    // 4. X's socket drops (transient disconnect).
    xSocket.terminate();
    await waitForClose(xSocket);

    // 5. O moves cell 4 (O's turn — legal). Only O is reachable; seq 3.
    oSocket.send(JSON.stringify({ type: 'move', cell: 4 }));
    const oAfterO4 = await oQueue.next(
      (m) =>
        m.type === 'state' &&
        m.state.board[0] === 'X' &&
        m.state.board[4] === 'O',
    );
    expect(oAfterO4.seq).toBe(3);

    // 6. X reconnects with lastSeq=2: tail [seq 3] then a converging state.
    const reconnectX = track(await openSocket(wsUrl));
    const reconnectQueue: MessageQueue = createMessageQueue(reconnectX);
    reconnectX.send(
      JSON.stringify({ type: 'hello', gameId: 'g1', token: xToken, lastSeq: 2 }),
    );
    // Drain the FULL ordered inbound stream once the terminal state frame lands.
    const replayed = await reconnectQueue.drain(
      (m) => m.type === 'state' && m.seq === 3,
    );
    expect(replayed).toHaveLength(3); // welcome, one event, final state
    const [w, e, s] = replayed;

    // welcome (rejoin): X seat, own token, seq anchored at latest
    expect(w.type).toBe('welcome');
    expect(w.player).toBe('X');
    expect(w.token).toBe(xToken);
    expect(w.seq).toBe(3);

    // exactly ONE event frame: O's move at seq 3
    expect(e).toEqual({
      type: 'event',
      seq: 3,
      event: { type: 'Move', cell: 4, player: 'O' },
    });

    // final authoritative state: no drift from the live game
    expect(s.type).toBe('state');
    expect(s.seq).toBe(3);
    expect(s.state.board[0]).toBe('X');
    expect(s.state.board[4]).toBe('O');
    expect(s.state.status).toBe('active');
    expect(s.state.winner).toBeNull();
    expect(s.state.seats.X).toBe(xToken);
    expect(s.state.seats.O).toBe(oToken);
    const serverFinalState: GameState = s.state;

    // 7. CONVERGENCE (no drift): replay the reconnect tail onto the prefix the
    //    client should already hold, and check it equals the live state.
    const prefixEvents: GameEvent[] = [
      { type: 'Joined', seat: 'X', token: xToken },
      { type: 'Joined', seat: 'O', token: oToken },
      { type: 'Move', cell: 0, player: 'X' },
    ];
    const base = applyEvents(initialState('g1'), prefixEvents);
    const reduced = applyEvents(base, [
      { type: 'Move', cell: 4, player: 'O' },
    ]);
    expect(reduced).toEqual(serverFinalState);

    // 8. FULL-REPLAY (cold refresh, lastSeq=-1): the whole log, in order.
    const freshSocket = track(await openSocket(wsUrl));
    const freshQueue = createMessageQueue(freshSocket);
    freshSocket.send(
      JSON.stringify({ type: 'hello', gameId: 'g1', token: xToken, lastSeq: -1 }),
    );
    const full = await freshQueue.drain((m) => m.type === 'state' && m.seq === 3);
    // welcome, 4 events (seq 0..3 ascending), final state (seq 3)
    expect(full).toHaveLength(6);
    const types = full.map((m) => m.type);
    expect(types).toEqual(['welcome', 'event', 'event', 'event', 'event', 'state']);
    const eventSeqs = full.filter((m) => m.type === 'event').map((m) => m.seq);
    expect(eventSeqs).toEqual([0, 1, 2, 3]);
    const eventList = full
      .filter((m) => m.type === 'event')
      .map((m) => m.event) as GameEvent[];
    expect(eventList).toEqual([
      { type: 'Joined', seat: 'X', token: xToken },
      { type: 'Joined', seat: 'O', token: oToken },
      { type: 'Move', cell: 0, player: 'X' },
      { type: 'Move', cell: 4, player: 'O' },
    ]);
    // Rebuilding from initialState over the FULL log must also converge.
    const coldRebuilt = applyEvents(initialState('g1'), eventList);
    expect(coldRebuilt).toEqual(serverFinalState);
  });
});
