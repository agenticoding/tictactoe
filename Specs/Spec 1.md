# Realtime multiplayer tic-tac-toe

A live two-player game that plays as one product for kids and adults.

## Stack
React · NodeJS · TypeScript

## Architecture
- The server is the single source of truth; clients only render what it sends.
- A game lives at its own URL. Open it and you're in — no accounts.
- Game state and its event log persist in SQLite.
- Clients talk to the server over WebSockets; the server pushes state after every change.
- Each game stamps events with a strictly increasing sequence number. A client that falls behind replays events after its last seen number and converges on the exact server state, so reconnections resume in order and never drift.

## Design
- shadcn/ui on Radix UI + Tailwind CSS, all MIT. Radix supplies WCAG AAA primitives; shadcn's owned, copy-paste components leave the visual language fully ours, which is how one accessible system serves kids and adults.
- Shared sizing honors both ages: touch targets at 48px (Apple 44, Material 48, 60+ for children), 8px minimum / 24px recommended spacing, and a playful high-contrast palette held to 4.5:1 for text and 3:1 for UI.

## Testing
- The transition logic is a pure function of state plus an event, with no clocks, randomness, or I/O inside, so a synchronous replay of ordered events reproduces identical state every time.
- The environment's non-determinism sits behind narrow boundaries — an injectable clock and an in-memory WebSocket transport — that tests swap out so ticks are driven by hand.
- Property-based tests (fast-check + Vitest) feed arbitrary command streams and assert the invariants that ARE the mechanism: numbers are monotonic and gapless from zero, replaying from any sequence reproduces the live state, and the final state depends only on the ordered log.
- A few scripted golden replay fixtures pin the client's recovery path.
- Thin real end-to-end tests (real WebSocket plus in-memory SQLite) verify the external contract: reconnect with last sequence N delivers N+1, N+2… in order, and client state matches server state.
