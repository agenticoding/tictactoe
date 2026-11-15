export * from './domain';
export * from './protocol';

// The functions below live in implementation modules that satisfy the contract
// types declared in domain.ts. index.ts re-exports them so the whole codebase
// imports from one place.
export {
  reduce,
  initialState,
  applyEvents,
  checkWinner,
  isBoardFull,
} from './reducer';
export { nextFreeSeat, join, type JoinResult } from './seats';
export { createInMemoryEventLog, type EventLog, type StampedEvent } from './event-log';
