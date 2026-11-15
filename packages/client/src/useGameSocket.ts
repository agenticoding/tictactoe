import { useEffect, useRef, useState } from 'react';
import { wsPath, type Cell, type ClientMessage, type HelloMessage, type ServerMessage } from '@tictactoe/core';
import { getToken, setToken } from './cookie';
import { applyServerMessage, backoffDelay, initialView, type GameClientView } from './gameClient';

/**
 * WebSocket URL to the same origin, using the shared path helper. `loc` is
 * injectable so both protocol branches are testable without a DOM.
 */
export function wsUrl(
  gameId: string,
  loc: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${wsPath(gameId)}`;
}

/**
 * Injected socket factory. Production default is the browser WebSocket; tests
 * pass a fake so the hook's reconnect/terminal/move logic runs without a server.
 */
export interface GameSocketDeps {
  createSocket?: (url: string) => WebSocket;
}

/**
 * Thin WebSocket shell. All recovery/replay/state logic lives in the pure
 * `gameClient` module; this hook only owns the socket lifecycle, cookie I/O,
 * and reconnect scheduling. `viewRef` mirrors the current view so closures
 * (onclose, onmessage) read a fresh value, while `setView` drives re-renders.
 */
export function useGameSocket(gameId: string, deps: GameSocketDeps = {}) {
  const createSocket = deps.createSocket ?? ((url: string) => new WebSocket(url));
  const [view, setView] = useState<GameClientView>(() => initialView());
  const viewRef = useRef(view);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  const connect = () => {
    const ws = createSocket(wsUrl(gameId));
    socketRef.current = ws;

    ws.onopen = () => {
      // The connection succeeded: backoff restarts from 1s on the next drop.
      attemptRef.current = 0;
      const token = getToken(gameId);
      const hello: HelloMessage = {
        type: 'hello',
        gameId,
        lastSeq: viewRef.current.lastSeq,
        ...(token ? { token } : {}),
      };
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      const next = applyServerMessage(viewRef.current, msg, gameId);
      viewRef.current = next;
      setView(next);
      if (msg.type === 'welcome' && next.token !== null) {
        setToken(gameId, next.token);
        ws.send(JSON.stringify({ type: 'ack' } satisfies ClientMessage));
      }
    };

    ws.onclose = () => {
      // Only the socket the ref still points at is live: a disposed socket
      // (StrictMode remount, gameId change) must never schedule a reconnect or
      // its ghost connection would evict the current one.
      if (socketRef.current !== ws || viewRef.current.terminal) return;
      // Keep a richer error (e.g. game-full copy) over the generic close text.
      const next: GameClientView = {
        ...viewRef.current,
        error: viewRef.current.error ?? 'Connection lost. Reconnecting…',
      };
      viewRef.current = next;
      setView(next);
      reconnectTimerRef.current = setTimeout(connect, backoffDelay(attemptRef.current));
      attemptRef.current += 1;
    };
  };

  useEffect(() => {
    attemptRef.current = 0;
    connect();
    return () => {
      // Clear any pending reconnect or it fires after unmount and opens an
      // orphan socket that nothing will ever clean up.
      if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
      const ws = socketRef.current;
      socketRef.current = null;
      try {
        ws?.close();
      } catch {
        // The ws package (test client) throws synchronously when close() hits a
        // socket still CONNECTING; the browser API does not. Nothing to tear
        // down in either case.
      }
    };
  }, [gameId]);

  const makeMove = (cell: Cell) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = { type: 'move', cell };
      ws.send(JSON.stringify(msg));
    }
  };

  return {
    state: view.state,
    player: view.player,
    error: view.error,
    errorCode: view.errorCode,
    terminal: view.terminal,
    makeMove,
  };
}
