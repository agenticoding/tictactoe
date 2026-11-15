import * as fc from 'fast-check';
import type { Cell, GameEvent, Player } from './domain';

/**
 * Shared fast-check arbitraries + run count for the invariant suites, so the
 * core and server property tests exercise the SAME input space from one source
 * of truth. Test-only: deliberately not re-exported from the public barrel.
 *
 * `RUNS` is env-overridable so `npm run test:ci` runs the properties harder
 * than the default local pass. fast-check echoes the failing seed either way.
 */
export const RUNS: number = Number(process.env.FC_NUM_RUNS ?? 200);

export const playerArb = fc.constantFrom<Player>('X', 'O');
export const cellArb = fc.constantFrom<Cell>(0, 1, 2, 3, 4, 5, 6, 7, 8);
// A small token pool so rejoins / duplicate-seat collisions occur naturally.
export const tokenArb = fc.constantFrom('t0', 't1', 't2', 't3', 't4', 't5');

export const joinedArb = fc
  .tuple(playerArb, tokenArb)
  .map(([seat, token]): GameEvent => ({ type: 'Joined', seat, token }));
export const moveArb = fc
  .tuple(playerArb, cellArb)
  .map(([player, cell]): GameEvent => ({ type: 'Move', cell, player }));

/** Every event kind the log can hold: Joined | Move. */
export const eventArb = fc.oneof(joinedArb, moveArb);
