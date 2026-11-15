import WebSocket from 'ws';
import type {
  ClientMessage,
  ErrorCode,
  GameId,
  GameState,
  HelloMessage,
  MoveMessage,
  Player,
  PlayerToken,
  ServerMessage,
} from '@tictactoe/core';
import { GAME_FULL_MESSAGE, SEAT_EVICTED_MESSAGE, join, reduce } from '@tictactoe/core';
import type { GameRecord, GameStore } from './games';

export interface ClientSocket extends WebSocket {
  isAlive: boolean;
  seat?: Player;
  token?: PlayerToken;
  gameId?: GameId;
}

export interface ConnectionDeps {
  createToken: () => PlayerToken;
}

const READY_OPEN = WebSocket.OPEN;
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  'seat-evicted': SEAT_EVICTED_MESSAGE,
  'game-full': GAME_FULL_MESSAGE,
  'not-your-turn': 'It is not your turn.',
  'invalid-move': 'That cell is already taken.',
  'game-over': 'This game is over.',
  'invalid-game': 'That game does not exist.',
  'invalid-message': 'Malformed message.',
};

function broadcast(targets: Iterable<WebSocket>, message: ServerMessage, except?: WebSocket): void {
  const payload = JSON.stringify(message);
  for (const socket of targets) {
    if (socket !== except && socket.readyState === READY_OPEN) socket.send(payload);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  broadcast([socket], message);
}

function reject(socket: WebSocket, code: ErrorCode, close = false): void {
  send(socket, { type: 'error', code, message: ERROR_MESSAGES[code] });
  if (close) socket.close();
}

function bindSocket(record: GameRecord, seat: Player, socket: ClientSocket): void {
  const previous = record.sockets.get(seat);
  if (previous !== undefined && previous !== socket && previous.readyState !== WebSocket.CLOSED) {
    reject(previous, 'seat-evicted');
    previous.close();
  }
  record.sockets.set(seat, socket);
}

function moveErrorCode(state: GameState, player: Player): ErrorCode {
  if (state.status === 'won' || state.status === 'draw') return 'game-over';
  if (state.status === 'waiting' || player !== state.turn) return 'not-your-turn';
  return 'invalid-move';
}

function sendWelcome(record: GameRecord, socket: ClientSocket, gameId: GameId): void {
  send(socket, {
    type: 'welcome',
    gameId,
    player: socket.seat as Player,
    token: socket.token as PlayerToken,
    seq: record.log.latestSeq(),
    state: record.state,
  });
}

function replayWindow(record: GameRecord, socket: ClientSocket, lastSeq: number | undefined): void {
  if (lastSeq === undefined) return;
  for (const stamped of record.log.fetchAfter(lastSeq)) {
    send(socket, { type: 'event', seq: stamped.seq, event: stamped.event });
  }
  send(socket, { type: 'state', seq: record.log.latestSeq(), state: record.state });
}

function bind(record: GameRecord, socket: ClientSocket, gameId: GameId, seat: Player, token: PlayerToken): void {
  socket.gameId = gameId;
  socket.seat = seat;
  socket.token = token;
  bindSocket(record, seat, socket);
}

function existingSeat(record: GameRecord, token: PlayerToken): Player | undefined {
  const result = join(record.state, token);
  return result.kind === 'rejoined' ? result.seat : undefined;
}

function freeSeat(record: GameRecord): Player | undefined {
  return (['X', 'O'] as const).find((seat) => record.state.seats[seat] === undefined && !record.pending.has(seat));
}

function handleHello(
  store: GameStore,
  socket: ClientSocket,
  gameId: GameId,
  message: HelloMessage,
  deps: ConnectionDeps,
): void {
  if (socket.seat !== undefined) return reject(socket, 'invalid-message');
  const record = store.get(gameId);
  if (record === undefined) return reject(socket, 'invalid-game', true);

  if (message.token !== undefined) {
    const seat = existingSeat(record, message.token);
    const pending = [...record.pending.values()].find((entry) => entry.token === message.token);
    if (seat === undefined && pending === undefined) return reject(socket, 'invalid-message', true);
    const resolvedSeat = seat ?? pending?.seat as Player;
    bind(record, socket, gameId, resolvedSeat, message.token);
    if (pending !== undefined) record.pending.set(resolvedSeat, { ...pending, socket });
    sendWelcome(record, socket, gameId);
    replayWindow(record, socket, message.lastSeq);
    return;
  }

  const seat = freeSeat(record);
  if (seat === undefined) return reject(socket, 'game-full', true);
  const token = deps.createToken();
  bind(record, socket, gameId, seat, token);
  record.pending.set(seat, { seat, token, socket });
  sendWelcome(record, socket, gameId);
  replayWindow(record, socket, message.lastSeq);
}

function handleAck(store: GameStore, socket: ClientSocket, gameId: GameId): void {
  const record = store.get(gameId);
  const seat = socket.seat;
  if (record === undefined || seat === undefined) return;
  const pending = record.pending.get(seat);
  if (pending?.socket !== socket || pending.token !== socket.token) return;
  record.log.append({ type: 'Joined', seat, token: pending.token });
  record.state = reduce(record.state, { type: 'Joined', seat, token: pending.token });
  record.pending.delete(seat);
  broadcast(record.sockets.values(), { type: 'state', seq: record.log.latestSeq(), state: record.state });
}

function handleMove(store: GameStore, socket: ClientSocket, gameId: GameId, message: MoveMessage): void {
  const record = store.get(gameId);
  const seat = socket.seat;
  if (record === undefined || seat === undefined || record.state.seats[seat] !== socket.token) {
    return reject(socket, 'invalid-game');
  }
  if (!Number.isInteger(message.cell) || message.cell < 0 || message.cell > 8) {
    return reject(socket, 'invalid-message');
  }
  const next = reduce(record.state, { type: 'Move', cell: message.cell, player: seat });
  if (next === record.state) return reject(socket, moveErrorCode(record.state, seat));
  record.log.append({ type: 'Move', cell: message.cell, player: seat });
  record.state = next;
  broadcast(record.sockets.values(), { type: 'state', seq: record.log.latestSeq(), state: next });
}

function handleMessage(
  store: GameStore,
  socket: ClientSocket,
  gameId: GameId,
  raw: WebSocket.RawData,
  deps: ConnectionDeps,
): void {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw.toString()) as ClientMessage;
  } catch {
    return reject(socket, 'invalid-message');
  }
  if (message === null || typeof message !== 'object') return reject(socket, 'invalid-message');
  switch (message.type) {
    case 'hello': return handleHello(store, socket, gameId, message, deps);
    case 'ack': return handleAck(store, socket, gameId);
    case 'move': return handleMove(store, socket, gameId, message);
    default: return reject(socket, 'invalid-message');
  }
}

function handleClose(store: GameStore, socket: ClientSocket): void {
  const record = socket.gameId === undefined ? undefined : store.get(socket.gameId);
  const seat = socket.seat;
  if (record === undefined || seat === undefined) return;
  if (record.sockets.get(seat) === socket) record.sockets.delete(seat);
  if (record.pending.get(seat)?.socket === socket) record.pending.delete(seat);
}

export function sweepSockets(sockets: Set<ClientSocket>): void {
  for (const socket of sockets) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      socket.terminate();
    }
  }
}

export function handleConnection(
  store: GameStore,
  socket: ClientSocket,
  gameId: GameId,
  registry: Set<ClientSocket>,
  deps: ConnectionDeps = { createToken: () => `tok-${crypto.randomUUID()}` },
): void {
  registry.add(socket);
  socket.isAlive = true;
  socket.gameId = gameId;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (raw) => handleMessage(store, socket, gameId, raw, deps));
  socket.on('close', () => {
    registry.delete(socket);
    handleClose(store, socket);
  });
  socket.on('error', (err) => console.error(`[server] ws error for game ${gameId}:`, err));
}
