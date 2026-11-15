import { describe, it, expect } from 'vitest';
import {
  GAME_FULL_MESSAGE,
  applyEvents,
  initialState,
  reduce,
  type GameEvent,
  type StampedEvent,
} from '@tictactoe/core';
import { applyServerMessage, backoffDelay, initialView, terminalErrorTitle } from '../src/gameClient';

/** A golden log: two joins then two moves, the shape the reconnect e2e uses. */
const log: StampedEvent[] = [
  { seq: 0, event: { type: 'Joined', seat: 'X', token: 'tok-x' } },
  { seq: 1, event: { type: 'Joined', seat: 'O', token: 'tok-o' } },
  { seq: 2, event: { type: 'Move', cell: 0, player: 'X' } },
  { seq: 3, event: { type: 'Move', cell: 4, player: 'O' } },
];
const fullLog = log.map((s) => s.event);
const converged = applyEvents(initialState('g1'), fullLog);
const prefix = log.slice(0, 3);
const prefixState = applyEvents(initialState('g1'), prefix.map((s) => s.event));

/** The frames a reconnecting client (lastSeq=2) receives from the server. */
const reconnectFrames = [
  { type: 'welcome' as const, gameId: 'g1', player: 'X' as const, token: 'tok-x', seq: 3, state: converged },
  { type: 'event' as const, seq: log[3]!.seq, event: log[3]!.event },
  { type: 'state' as const, seq: 3, state: converged },
];

describe('client recovery over the real core reducer', () => {
  it('a reconnect with lastSeq=N replays N+1.. in order, WITHOUT rendering mid-replay, then converges', () => {
    // The previous session committed the prefix view via its final state frame.
    let view = initialView();
    view = applyServerMessage(view, { type: 'state', seq: 2, state: prefixState }, 'g1');
    expect(view.state).toEqual(prefixState);
    expect(view.lastSeq).toBe(2);
    expect(view.replaying).toBe(false);

    for (const frame of reconnectFrames) view = applyServerMessage(view, frame, 'g1');

    expect(view.state).toEqual(converged);
    expect(view.replayBase).toEqual(converged);
    expect(view.replaying).toBe(false);
    expect(view.lastSeq).toBe(3);
    expect(view.error).toBeNull();

    // The authoritative state the server pushed is the log-folded convergence.
    expect(converged).toEqual(applyEvents(initialState('g1'), fullLog));
    expect(converged.status).toBe('active');
    expect(converged.board[0]).toBe('X');
    expect(converged.board[4]).toBe('O');
  });

  it('welcome sets the replay base and the event window advances lastSeq without touching the display', () => {
    let view = initialView();
    view = applyServerMessage(view, { type: 'state', seq: 2, state: prefixState }, 'g1');

    // Reconnect welcome: player/token set, base stays the committed prefix, replay starts.
    view = applyServerMessage(view, reconnectFrames[0]!, 'g1');
    expect(view.player).toBe('X');
    expect(view.token).toBe('tok-x');
    expect(view.replaying).toBe(true);
    expect(view.replayBase).toEqual(prefixState);
    expect(view.state).toEqual(prefixState); // display unchanged

    // The tail event reduces into the base but the DISPLAY state is untouched.
    view = applyServerMessage(view, reconnectFrames[1]!, 'g1');
    expect(view.replayBase).toEqual(reduce(prefixState, log[3]!.event));
    expect(view.state).toEqual(prefixState); // NOT rendered mid-replay
    expect(view.lastSeq).toBe(3);

    // The final state frame converges AND renders.
    view = applyServerMessage(view, reconnectFrames[2]!, 'g1');
    expect(view.state).toEqual(converged);
    expect(view.replaying).toBe(false);
  });

  it('a cold full replay (lastSeq -1) applies the whole log, in order, then converges', () => {
    // A brand-new visitor joining an in-progress game: welcome seeds the base
    // from the engine's initial state, then the full log replays.
    let view = initialView();
    view = applyServerMessage(
      view,
      { type: 'welcome', gameId: 'g1', player: 'X', token: 'tok-x', seq: 3, state: converged },
      'g1',
    );
    expect(view.replaying).toBe(true);
    expect(view.replayBase).toEqual(initialState('g1'));
    // welcome.seq anchors lastSeq at the join point (2.1 contract).
    expect(view.lastSeq).toBe(3);

    let acc = initialState('g1');
    for (const stamped of log) {
      view = applyServerMessage(view, { type: 'event', seq: stamped.seq, event: stamped.event }, 'g1');
      acc = reduce(acc, stamped.event);
      expect(view.replayBase).toEqual(acc);
      expect(view.state).toBeNull(); // nothing rendered until the authoritative state frame
    }
    expect(view.lastSeq).toBe(3);

    view = applyServerMessage(view, { type: 'state', seq: 3, state: converged }, 'g1');
    expect(view.state).toEqual(converged);
    expect(view.replaying).toBe(false);
  });

  it('ignores an event frame that arrives outside a replay window', () => {
    // Frames are only meaningful between welcome and the final state; a stray
    // event after the window must not mutate the committed view.
    let view = initialView();
    view = applyServerMessage(view, { type: 'state', seq: 2, state: prefixState }, 'g1');
    const committed = view;

    view = applyServerMessage(view, { type: 'event', seq: 3, event: log[3]!.event }, 'g1');

    expect(view).toBe(committed);
  });

  it('a game-full error sets terminal state and the exact friendly copy', () => {
    let view = initialView();
    view = applyServerMessage(view, { type: 'error', code: 'game-full', message: GAME_FULL_MESSAGE }, 'g1');
    expect(view.terminal).toBe(true);
    expect(view.error).toBe(GAME_FULL_MESSAGE);
  });

  it('a seat-evicted error is terminal: the displaced client stops reconnecting', () => {
    let view = initialView();
    view = applyServerMessage(
      view,
      { type: 'error', code: 'seat-evicted', message: 'This game is open in another window.' },
      'g1',
    );
    expect(view.terminal).toBe(true);
    expect(view.error).toBe('This game is open in another window.');
    expect(view.errorCode).toBe('seat-evicted');
  });

  it('does not let a late welcome resurrect a terminal session', () => {
    let view = initialView();
    view = applyServerMessage(
      view,
      { type: 'error', code: 'seat-evicted', message: 'This game is open in another window.' },
      'g1',
    );

    view = applyServerMessage(
      view,
      { type: 'welcome', gameId: 'g1', player: 'X', token: 'tok-x', seq: 3, state: converged },
      'g1',
    );

    expect(view.terminal).toBe(true);
    expect(view.error).toBe('This game is open in another window.');
    expect(view.errorCode).toBe('seat-evicted');
  });

  it('the terminal dialog title follows the error code, with a fallback', () => {
    expect(terminalErrorTitle('game-full')).toBe('Game full');
    expect(terminalErrorTitle('seat-evicted')).toBe('Game open elsewhere');
    expect(terminalErrorTitle(null)).toBe('Game unavailable');
  });

  it('a transient server error is not terminal', () => {
    let view = initialView();
    view = applyServerMessage(
      view,
      { type: 'error', code: 'invalid-move', message: 'That cell is already taken.' },
      'g1',
    );
    expect(view.terminal).toBe(false);
    expect(view.error).toBe('That cell is already taken.');
  });

  it('reconnect backoff is 1s, 2s, 4s, 8s, 10s, 10s (capped at 10s)', () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(3)).toBe(8000);
    expect(backoffDelay(4)).toBe(10000);
    expect(backoffDelay(5)).toBe(10000);
  });
});
