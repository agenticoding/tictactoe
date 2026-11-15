import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '@tictactoe/server';
import { applyEvents, initialState, type GameEvent, type GameState } from '@tictactoe/core';
import { acknowledgeJoin, createMessageQueue, openSocket } from './ws-helpers';

/**
 * Gate: a server restart must not lose a game.
 *
 * The only test that drives `createSqliteGameStore` + the `createGameStore`
 * hydration loop end-to-end: write a real SQLite file, close the server, then
 * reopen a fresh server (new port) on the SAME db. The rebuilt state must equal
 * the pre-restart state, and replaying the persisted log must converge on it.
 */
describe('server restart persistence (real ws + real sqlite file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ttt-restart-'));
  // Nested path proves the store opener creates missing parent dirs.
  const dbPath = join(dir, 'nested', 'db', 'games.sqlite');
  const sockets: WebSocket[] = [];
  let serverA: GameServer;
  let serverB: GameServer | undefined;

  const track = (ws: WebSocket): WebSocket => {
    sockets.push(ws);
    // A terminated socket can emit a client-side RST 'error'; swallow it.
    ws.on('error', () => {});
    return ws;
  };

  beforeAll(async () => {
    serverA = createGameServer({
      eventLog: { dbPath },
      clientDistDir: '<nonexistent>',
      createId: () => 'g1',
    });
    await serverA.start(0);
    serverA.mint('g1');
  });

  afterAll(async () => {
    for (const s of sockets) {
      try {
        s.terminate();
      } catch {
        /* already closed */
      }
    }
    // serverA was already closed inside the test; a second close rejects.
    await serverA.close().catch(() => {});
    await serverB?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('hydrates the persisted game and hands the seat back after restart', async () => {
    const url = serverA.wsUrl('g1');

    const x = track(await openSocket(url));
    const xq = createMessageQueue(x);
    x.send(JSON.stringify({ type: 'hello', gameId: 'g1' }));
    const xWelcome = await xq.next((m) => m.type === 'welcome');
    const xToken: string = xWelcome.token;
    await acknowledgeJoin(x, xq, xWelcome);

    const o = track(await openSocket(url));
    const oq = createMessageQueue(o);
    o.send(JSON.stringify({ type: 'hello', gameId: 'g1' }));
    const oWelcome = await oq.next((m) => m.type === 'welcome');
    const oToken: string = oWelcome.token;
    await Promise.all([
      acknowledgeJoin(o, oq, oWelcome),
      xq.next((m) => m.type === 'state' && m.seq === 1),
    ]);

    // Alternating legal moves build a non-trivial persisted log (seq 2..4).
    x.send(JSON.stringify({ type: 'move', cell: 0 }));
    await xq.next((m) => m.type === 'state' && m.seq === 2);
    o.send(JSON.stringify({ type: 'move', cell: 4 }));
    await oq.next((m) => m.type === 'state' && m.seq === 3);
    x.send(JSON.stringify({ type: 'move', cell: 1 }));
    const finalFrame = await xq.next((m) => m.type === 'state' && m.seq === 4);
    const preRestartState: GameState = finalFrame.state;
    const finalSeq: number = finalFrame.seq;
    expect(preRestartState.seats).toEqual({ X: xToken, O: oToken });
    expect(preRestartState.status).toBe('active');

    // Restart: close A, open B on the same file (new port, fresh in-memory registry).
    await serverA.close();
    serverB = createGameServer({
      eventLog: { dbPath },
      clientDistDir: '<nonexistent>',
      createId: () => 'g1',
    });
    await serverB.start(0);
    const urlB = serverB.wsUrl('g1');

    // Resume at the exact pre-restart seq: the hydrated welcome must carry the
    // same seat and the full rebuilt state.
    const resume = track(await openSocket(urlB));
    const resumeQ = createMessageQueue(resume);
    resume.send(
      JSON.stringify({ type: 'hello', gameId: 'g1', token: xToken, lastSeq: finalSeq }),
    );
    const rWelcome = await resumeQ.next((m) => m.type === 'welcome');
    expect(rWelcome.player).toBe('X');
    expect(rWelcome.token).toBe(xToken);
    expect(rWelcome.seq).toBe(finalSeq);
    expect(rWelcome.state).toEqual(preRestartState);

    // Nothing was appended after finalSeq, so only the final authoritative frame follows.
    const rTail = await resumeQ.drain((m) => m.type === 'state' && m.seq === finalSeq);
    expect(rTail).toEqual([{ type: 'state', seq: finalSeq, state: preRestartState }]);

    // Cold replay (lastSeq=-1): the full persisted log must be delivered in order
    // and folding it from initialState must converge on the pre-restart state.
    const cold = track(await openSocket(urlB));
    const coldQ = createMessageQueue(cold);
    cold.send(JSON.stringify({ type: 'hello', gameId: 'g1', token: xToken, lastSeq: -1 }));
    const stream = await coldQ.drain((m) => m.type === 'state' && m.seq === finalSeq);
    expect(stream.map((m) => m.type)).toEqual([
      'welcome',
      'event',
      'event',
      'event',
      'event',
      'event',
      'state',
    ]);
    const events = stream
      .filter((m) => m.type === 'event')
      .map((m) => m.event) as GameEvent[];
    expect(stream.filter((m) => m.type === 'event').map((m) => m.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(applyEvents(initialState('g1'), events)).toEqual(preRestartState);
  });
});

describe('unminted game persistence', () => {
  it('does not survive a restart after its hello is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttt-unminted-'));
    const dbPath = join(dir, 'games.sqlite');
    const create = () => createGameServer({ eventLog: { dbPath }, clientDistDir: '<nonexistent>' });
    const serverA = create();
    await serverA.start(0);

    const first = await openSocket(serverA.wsUrl('absent'));
    first.on('error', () => {});
    const firstQueue = createMessageQueue(first);
    first.send(JSON.stringify({ type: 'hello', gameId: 'absent' }));
    expect((await firstQueue.next((m) => m.type === 'error')).code).toBe('invalid-game');
    await serverA.close();

    const serverB = create();
    try {
      await serverB.start(0);
      const second = await openSocket(serverB.wsUrl('absent'));
      second.on('error', () => {});
      const secondQueue = createMessageQueue(second);
      second.send(JSON.stringify({ type: 'hello', gameId: 'absent' }));
      expect(await secondQueue.next((m) => m.type === 'error')).toMatchObject({ code: 'invalid-game' });
    } finally {
      await serverB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
