import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '@tictactoe/server';
import { useGameSocket, type GameSocketDeps } from '../src/useGameSocket';
import { getToken } from '../src/cookie';
import { clearGameTokens } from './cookie-helpers';

/** The DOM socket type the hook consumes — for the single ws→hook boundary cast. */
type HookSocket = ReturnType<NonNullable<GameSocketDeps['createSocket']>>;

/**
 * Client <-> server integration gate: the hook drives its PRODUCTION logic
 * (cookie hello, lastSeq resume, backoff reconnect) against a REAL server.
 * Only the socket URL is injected — jsdom's location port is meaningless, so
 * `createSocket` ignores it and connects a real `ws` client instead.
 *
 * Real timers; every await targets an OBSERVED condition (rendered state or an
 * inbound frame) with a timeout guard, never a sleep.
 */
describe('useGameSocket against the real server', () => {
  let server: GameServer;

  /** A hook-created socket plus the JSON frames the hook sent/received through it. */
  interface Tracked {
    ws: WebSocket;
    sent: unknown[];
    received: unknown[];
  }

  /** Hook sockets (this test only) — index 0 is the first, later ones reconnects. */
  let tracked: Tracked[] = [];
  /** Every socket opened in the file (hook + raw second seats) for teardown. */
  const allSockets: WebSocket[] = [];

  /** A tracked socket factory bound to one game id. */
  const factoryFor =
    (gameId: string): NonNullable<GameSocketDeps['createSocket']> =>
    () => {
      server.mint(gameId);
      const real = new WebSocket(server.wsUrl(gameId));
      const entry: Tracked = { ws: real, sent: [], received: [] };
      // Buffer inbound frames so late assertions can inspect what already landed.
      real.on('message', (raw) => entry.received.push(JSON.parse(String(raw))));
      const rawSend = real.send.bind(real);
      real.send = ((data: string) => {
        entry.sent.push(JSON.parse(data));
        rawSend(data);
      }) as typeof real.send;
      tracked.push(entry);
      allSockets.push(real);
      return real as unknown as HookSocket;
    };

  const hookSocket = (): Tracked => {
    const entry = tracked.at(-1);
    if (!entry) throw new Error('no hook socket created yet');
    return entry;
  };

  beforeAll(async () => {
    server = createGameServer({
      eventLog: { dbPath: ':memory:' },
      clientDistDir: '<nonexistent>',
    });
    await server.start(0);
  });

  afterAll(async () => {
    for (const ws of allSockets) {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
    }
    await server.close();
  });

  beforeEach(() => {
    tracked = [];
    clearGameTokens();
  });
  afterEach(() => {
    cleanup();
    clearGameTokens();
  });

  /** Resolve the next inbound frame matching `pred`, with a timeout guard. */
  function waitForMessage<T = any>(ws: WebSocket, pred: (msg: any) => boolean, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onMsg = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(String(raw));
        if (pred(msg)) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(msg as T);
        }
      };
      const timer = setTimeout(() => {
        ws.off('message', onMsg);
        reject(new Error('timed out waiting for a server message'));
      }, timeoutMs);
      ws.on('message', onMsg);
    });
  }

  /** Raw second-seat client: open, hello, resolve on its welcome. */
  async function joinRaw(gameId: string): Promise<{ ws: WebSocket; welcome: any }> {
    const ws = new WebSocket(server.wsUrl(gameId));
    // A later terminate can surface an RST 'error'; keep it from crashing vitest.
    ws.on('error', () => {});
    allSockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'hello', gameId }));
    const welcome = await waitForMessage(ws, (m) => m.type === 'welcome');
    ws.send(JSON.stringify({ type: 'ack' }));
    await waitForMessage(ws, (m) => m.type === 'state' && m.seq === welcome.seq + 1);
    return { ws, welcome };
  }

  it('a join renders state after welcome + replay', async () => {
    const { result } = renderHook(() =>
      useGameSocket('int-join', { createSocket: factoryFor('int-join') }),
    );

    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.player).toBe('X');
    expect(result.current.state?.status).toBe('waiting');
    // The seat token from welcome round-trips into the cookie.
    expect(result.current.state?.seats.X).toBe(getToken('int-join'));
  });

  it('a move converges: the rendered state matches the server state', async () => {
    const { result } = renderHook(() =>
      useGameSocket('int-move', { createSocket: factoryFor('int-move') }),
    );
    await waitFor(() => expect(result.current.state).not.toBeNull());

    // O joins through a raw socket so the game turns active.
    const o = await joinRaw('int-move');
    expect(o.welcome.player).toBe('O');

    await waitFor(() => expect(result.current.state?.status).toBe('active'));
    result.current.makeMove(0);

    // The server state (observed on O's socket) is the authority.
    const serverFrame = await waitForMessage(o.ws, (m) => m.type === 'state' && m.state.board[0] === 'X');
    await waitFor(() => expect(result.current.state).toEqual(serverFrame.state));
  });

  it('after a drop the hook reconnects with its last seen seq and replays the tail', async () => {
    const gameId = 'int-drop';
    const { result } = renderHook(() => useGameSocket(gameId, { createSocket: factoryFor(gameId) }));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const o = await joinRaw(gameId);
    await waitFor(() => expect(result.current.state?.status).toBe('active'));
    result.current.makeMove(0); // seq 2
    await waitFor(() => expect(result.current.state?.board[0]).toBe('X'));

    // Drop the LIVE socket from under the hook, then O moves while X is down.
    hookSocket().ws.terminate();
    o.ws.send(JSON.stringify({ type: 'move', cell: 4 })); // seq 3
    await waitForMessage(o.ws, (m) => m.type === 'state' && m.state.board[4] === 'O');

    // The hook reconnects on its own (1s backoff) and converges.
    await waitFor(() => expect(result.current.state?.board[4]).toBe('O'), { timeout: 5000 });
    // The reconnect hello resumed from the last seen seq with the cookie token.
    expect(hookSocket().sent).toContainEqual({
      type: 'hello',
      gameId,
      lastSeq: 2,
      token: getToken(gameId),
    });
  });

  it('a server-issued cookie token rejoins the SAME seat after a drop', async () => {
    const gameId = 'int-cookie';
    const { result } = renderHook(() => useGameSocket(gameId, { createSocket: factoryFor(gameId) }));
    await waitFor(() => expect(result.current.player).toBe('X'));
    const token = getToken(gameId);
    expect(token).toBeTruthy();

    // Drop and reconnect: the persisted token regains X rather than taking O.
    hookSocket().ws.terminate();
    await waitFor(() => expect(tracked).toHaveLength(2), { timeout: 5000 });
    const reconnect = hookSocket();
    expect(reconnect.sent[0]).toEqual({ type: 'hello', gameId, token, lastSeq: 0 });
    const welcome = await waitFor<any>(() => {
      const msg = reconnect.received.find((m: any) => m.type === 'welcome');
      expect(msg).toBeTruthy();
      return msg;
    });
    expect(welcome.player).toBe('X');
    expect(welcome.token).toBe(token);
    expect(welcome.state.seats.X).toBe(token);
  });
});
