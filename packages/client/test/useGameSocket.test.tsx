import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { GAME_FULL_MESSAGE, initialState, type GameState } from '@tictactoe/core';
import { useGameSocket, wsUrl } from '../src/useGameSocket';
import { getToken } from '../src/cookie';
import { createSocketFactory } from './fakeWebSocket';
import { clearGameTokens } from './cookie-helpers';

const GAME_ID = 'g1';

/** Build a full GameState from the engine's fresh game, overriding per test. */
const state = (over: Partial<GameState> = {}): GameState => ({
  ...initialState(GAME_ID),
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  clearGameTokens();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clearGameTokens();
});

describe('useGameSocket', () => {
  it('hello carries lastSeq -1 and omits token for a brand-new visitor', () => {
    const factory = createSocketFactory();
    renderHook(() => useGameSocket(GAME_ID, { createSocket: factory.createSocket }));

    act(() => factory.latest().emitOpen());

    const hello = JSON.parse(factory.latest().sent[0]!);
    expect(hello).toEqual({ type: 'hello', gameId: GAME_ID, lastSeq: -1 });
    expect(hello).not.toHaveProperty('token');
  });

  it('welcome persists the seat token before acknowledging it', () => {
    const factory = createSocketFactory();
    const { result } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );

    act(() => factory.latest().emitOpen());
    act(() =>
      factory.latest().emitMessage({
        type: 'welcome',
        gameId: GAME_ID,
        player: 'X',
        token: 'tok-x',
        seq: 0,
        state: state(),
      }),
    );

    expect(result.current.player).toBe('X');
    expect(getToken(GAME_ID)).toBe('tok-x');
    expect(JSON.parse(factory.latest().sent.at(-1)!)).toEqual({ type: 'ack' });
  });

  it('does not reconnect after an invalid-game error', () => {
    const factory = createSocketFactory();
    const { result } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );

    act(() => factory.latest().emitOpen());
    act(() =>
      factory.latest().emitMessage({
        type: 'error',
        code: 'invalid-game',
        message: 'That game does not exist.',
      }),
    );
    expect(result.current.terminal).toBe(true);

    act(() => factory.latest().emitClose());
    act(() => vi.advanceTimersByTime(10_000));
    expect(factory.sockets).toHaveLength(1);
  });

  it('renders the authoritative state frame and clears a prior error', () => {
    const factory = createSocketFactory();
    const { result } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );

    act(() =>
      factory.latest().emitMessage({ type: 'error', code: 'not-your-turn', message: 'not yet' }),
    );
    expect(result.current.error).toBe('not yet');

    const authoritative = state({ status: 'active' });
    act(() => factory.latest().emitMessage({ type: 'state', seq: 3, state: authoritative }));

    expect(result.current.state).toEqual(authoritative);
    expect(result.current.error).toBeNull();
  });

  it('sends a move only while the socket is OPEN', () => {
    const factory = createSocketFactory();
    const { result } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );

    // Still CONNECTING: a move is dropped.
    act(() => result.current.makeMove(0));
    expect(factory.latest().sent).toEqual([]);

    act(() => factory.latest().emitOpen());
    act(() => result.current.makeMove(4));
    expect(JSON.parse(factory.latest().sent.at(-1)!)).toEqual({ type: 'move', cell: 4 });

    // Closed: further moves are dropped.
    act(() => factory.latest().emitClose());
    const sent = factory.latest().sent.length;
    act(() => result.current.makeMove(8));
    expect(factory.latest().sent.length).toBe(sent);
  });

  it('ignores a malformed frame without changing the view', () => {
    const factory = createSocketFactory();
    const { result } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );
    const before = result.current;

    act(() => factory.latest().emitRaw('{not json'));

    expect(result.current).toBe(before);
  });

  it('reconnects on unexpected close with 1s then 2s backoff', () => {
    const factory = createSocketFactory();
    const { result } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );

    act(() => factory.latest().emitClose());
    expect(result.current.error).toBe('Connection lost. Reconnecting…');
    expect(factory.sockets).toHaveLength(1);

    act(() => vi.advanceTimersByTime(999));
    expect(factory.sockets).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(factory.sockets).toHaveLength(2);

    // Second consecutive failure waits 2000ms.
    act(() => factory.latest().emitClose());
    act(() => vi.advanceTimersByTime(1999));
    expect(factory.sockets).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(factory.sockets).toHaveLength(3);
  });

  it('does not schedule a reconnect after a terminal game-full error', () => {
    const factory = createSocketFactory();
    const { result } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );

    act(() => factory.latest().emitOpen());
    act(() =>
      factory.latest().emitMessage({
        type: 'error',
        code: 'game-full',
        message: 'seat taken',
      }),
    );
    expect(result.current.terminal).toBe(true);
    expect(result.current.error).toBe(GAME_FULL_MESSAGE);

    act(() => factory.latest().emitClose());
    act(() => vi.advanceTimersByTime(10_000));
    expect(factory.sockets).toHaveLength(1);
  });

  it('closes the socket and suppresses reconnect on unmount', () => {
    const factory = createSocketFactory();
    const { unmount } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );
    const ws = factory.latest();

    unmount();
    // close() is graceful: CLOSING first, CLOSED once the queued event runs.
    expect(ws.readyState).toBe(2);

    act(() => vi.advanceTimersByTime(10_000));
    expect(ws.readyState).toBe(3);
    expect(factory.sockets).toHaveLength(1);
  });

  it('clears a pending reconnect timer on unmount (no orphan socket)', () => {
    const factory = createSocketFactory();
    const { unmount } = renderHook(() =>
      useGameSocket(GAME_ID, { createSocket: factory.createSocket }),
    );

    // A drop schedules a reconnect 1s out; unmounting inside that window must
    // cancel the timer, or it fires after unmount and opens an orphan socket.
    act(() => factory.latest().emitClose());
    unmount();
    act(() => vi.advanceTimersByTime(10_000));
    expect(factory.sockets).toHaveLength(1);
  });

  it('resets backoff after a successful open (1s again, not capped at 10s)', () => {
    const factory = createSocketFactory();
    renderHook(() => useGameSocket(GAME_ID, { createSocket: factory.createSocket }));

    // Three failed attempts push the delay to 8s.
    act(() => factory.latest().emitClose());
    act(() => vi.advanceTimersByTime(1000));
    act(() => factory.latest().emitClose());
    act(() => vi.advanceTimersByTime(2000));
    act(() => factory.latest().emitClose());
    act(() => vi.advanceTimersByTime(4000));
    expect(factory.sockets).toHaveLength(4);

    // One successful open restarts the sequence: the next drop waits 1s, not 8s.
    act(() => factory.latest().emitOpen());
    act(() => factory.latest().emitClose());
    act(() => vi.advanceTimersByTime(999));
    expect(factory.sockets).toHaveLength(4);
    act(() => vi.advanceTimersByTime(1));
    expect(factory.sockets).toHaveLength(5);
  });

  it('builds ws:// or wss:// from the given location', () => {
    expect(wsUrl('g1', { protocol: 'http:', host: 'localhost:3000' })).toBe(
      'ws://localhost:3000/g/g1/ws',
    );
    expect(wsUrl('g1', { protocol: 'https:', host: 'tic.example' })).toBe(
      'wss://tic.example/g/g1/ws',
    );
  });

  it('does not reconnect from a socket disposed by a StrictMode remount', () => {
    const factory = createSocketFactory();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useGameSocket(GAME_ID, { createSocket: factory.createSocket }), { wrapper });

    // StrictMode mounts twice: setup, cleanup, setup.
    expect(factory.sockets).toHaveLength(2);

    // Flush the disposed socket's queued close and advance well past backoff:
    // a ghost reconnect would open a third socket here.
    act(() => vi.advanceTimersByTime(10_000));

    expect(factory.sockets).toHaveLength(2);
  });
});
