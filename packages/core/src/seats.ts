import type {
  GameState,
  Join,
  JoinResult,
  NextFreeSeat,
  PlayerToken,
} from './domain';
import { applyEvents } from './reducer';

/** First unbound seat in X-then-O order, or null when both are bound (full). */
export const nextFreeSeat: NextFreeSeat = (state) => {
  if (state.seats.X === undefined) return 'X';
  if (state.seats.O === undefined) return 'O';
  return null;
};

/**
 * Resolve a join for an anonymous token. Idempotent for an already-bound token
 * (rejoin, no new event), binds the first free seat for a new token (a Joined
 * event is folded), or reports the game as full.
 */
export const join: Join = (state, token) => {
  if (state.seats.X === token) return { kind: 'rejoined', seat: 'X', state };
  if (state.seats.O === token) return { kind: 'rejoined', seat: 'O', state };

  const seat = nextFreeSeat(state);
  if (seat === null) return { kind: 'full' };

  const nextState = applyEvents(state, [{ type: 'Joined', seat, token }]);
  return { kind: 'joined', seat, token, state: nextState };
};

export type { JoinResult } from './domain';
