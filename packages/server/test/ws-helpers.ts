import http from 'node:http';
import WebSocket from 'ws';
import type { GameServer } from '@tictactoe/server';

/** Predicate over a parsed inbound server message. */
export type MsgPredicate = (msg: any) => boolean;

interface Waiter {
  predicate: MsgPredicate;
  resolve: (msg: any) => void;
  timer: NodeJS.Timeout;
}

/**
 * Buffers every parsed inbound WS message and exposes two read patterns:
 *  - `next`: resolve (consuming) the first message matching a predicate;
 *    non-matching messages already buffered are skipped so each step can wait
 *    for exactly the message it cares about.
 *  - `drain`: on a socket with no pending `next` waiters, collect the FULL
 *    ordered inbound stream once a terminal message matching a predicate
 *    arrives (inclusive). Use it to assert an exact reconnect/replay sequence.
 */
export interface MessageQueue {
  next<T = any>(predicate: MsgPredicate, timeoutMs?: number): Promise<T>;
  drain(predicate: MsgPredicate, timeoutMs?: number): Promise<any[]>;
}

/** Buffers inbound WS messages and lets a test await or capture them in order. */
export function createMessageQueue(ws: WebSocket): MessageQueue {
  const buffer: any[] = [];
  const waiters: Waiter[] = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const idx = waiters.findIndex((w) => w.predicate(msg));
    if (idx >= 0) {
      const w = waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      buffer.push(msg);
    }
  });

  function next<T = any>(predicate: MsgPredicate, timeoutMs = 4000): Promise<T> {
    const idx = buffer.findIndex(predicate);
    if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0] as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const wIdx = waiters.findIndex((w) => w.predicate === predicate);
        if (wIdx >= 0) waiters.splice(wIdx, 1);
        reject(new Error('Timed out waiting for a message matching the predicate'));
      }, timeoutMs);
      waiters.push({ predicate, resolve: resolve as (msg: any) => void, timer });
    });
  }

  function drain(predicate: MsgPredicate, timeoutMs = 6000): Promise<any[]> {
    // Fast path: the terminal message already arrived before drain registered.
    if (buffer.findIndex(predicate) >= 0) return Promise.resolve(buffer.splice(0));
    return new Promise<any[]>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.removeListener('message', onMessage);
        reject(new Error('Timed out waiting for drain terminal message'));
      }, timeoutMs);
      // Separate listener (not a consuming `next` waiter): it never pulls a
      // message out of the buffer, so the full ordered stream is captured.
      const onMessage = () => {
        if (settled) return;
        if (buffer.findIndex(predicate) >= 0) {
          settled = true;
          clearTimeout(timer);
          ws.removeListener('message', onMessage);
          resolve(buffer.splice(0));
        }
      };
      ws.on('message', onMessage);
    });
  }

  return { next, drain };
}

/** Open a WebSocket and resolve once the 'open' frame lands. */
export function openSocket(url: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket connection to ${url} timed out`));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Wait for a (possibly abruptly terminated) socket to finish closing. */
export function waitForClose(ws: WebSocket, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const onDone = () => {
      clearTimeout(timer);
      ws.removeListener('close', onDone);
      ws.removeListener('error', onDone);
      resolve();
    };
    const timer = setTimeout(() => {
      ws.removeListener('close', onDone);
      ws.removeListener('error', onDone);
      reject(new Error('socket did not close in time'));
    }, timeoutMs);
    // terminate() may surface an RST as 'error' on the client; either means closed.
    ws.once('close', onDone);
    ws.once('error', onDone);
  });
}

/** A seat that has completed hello and received its welcome. */
export interface Joined {
  ws: WebSocket;
  queue: MessageQueue;
  welcome: any;
}

/** Persist a newly delivered token and return the resulting authoritative state. */
export async function acknowledgeJoin(ws: WebSocket, queue: MessageQueue, welcome: any): Promise<any> {
  ws.send(JSON.stringify({ type: 'ack' }));
  return queue.next((m) => m.type === 'state' && m.seq === welcome.seq + 1);
}

/** Build a `join(gameId, token?)` bound to a test's socket tracking + server.
 * Completes the hello/welcome handshake and resolves with the welcome frame. */
export function createJoiner(
  track: (ws: WebSocket) => WebSocket,
  server: GameServer,
): (gameId: string, token?: string) => Promise<Joined> {
  return async (gameId, token) => {
    server.mint(gameId);
    const socket = track(await openSocket(server.wsUrl(gameId)));
    const queue = createMessageQueue(socket);
    socket.send(
      JSON.stringify(
        token === undefined ? { type: 'hello', gameId } : { type: 'hello', gameId, token },
      ),
    );
    const welcome = await queue.next((m) => m.type === 'welcome');
    if (welcome.state.seats[welcome.player] === welcome.token) return { ws: socket, queue, welcome };
    const confirmed = await acknowledgeJoin(socket, queue, welcome);
    return { ws: socket, queue, welcome: { ...welcome, seq: confirmed.seq, state: confirmed.state } };
  };
}

/** GET url and parse the JSON body. */
export function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}
