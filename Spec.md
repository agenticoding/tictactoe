# Realtime multiplayer tic-tac-toe

A live two-player game that plays as one product for kids and adults.

## Product
- Landing on the home page mints a new game id and redirects to it. That id is the game's shareable URL (/g/:id).
- Opening an existing game URL auto-joins the visitor at the first free seat — X, then O.
- A visitor is an anonymous seat holder, not an account. The server mints an opaque player token on first join and returns it to the client, which keeps it in a cookie, so a refresh rejoins the same seat.
- If both seats are already bound, opening the URL shows a clear, friendly message: "This game is already full."

## Stack
React · NodeJS · TypeScript

## Architecture
- The server is the single source of truth; clients only render what it sends.
- A game lives at its own URL, identified by a server-minted id. There are no accounts: a visitor becomes a seat purely by connecting, known to the server only by an anonymous player token (opaque, kept in a cookie).
- The event log persists in SQLite; game state is never stored separately — it is reconstructed deterministically by replaying the persisted log (single source of truth).
- Clients talk to the server over WebSockets; the server pushes state after every change.
- Each game stamps events with a strictly increasing sequence number. A client that falls behind replays events after its last seen number and converges on the exact server state, so reconnections resume in order and never drift.
- A dropped socket is treated as a simple outage: the client reconnects with backoff and resends its last seen sequence. Because a game is short-lived and every move is logged, the full event log is the replay window — no snapshots or trimming. A light heartbeat keeps idle connections alive between moves.
- Each game holds two seats, X and O. On join, the first unbound seat is assigned in order X then O and recorded as a `Joined` event, so seat assignment is part of the ordered event log.
- A game is `waiting` until both seats are bound, then `active`; joining a game whose seats are both bound is rejected and the client shows the "already full" message.
- Seat ownership is bound to the player token, not to a live socket. A returning visitor (same cookie token) rejoins the same seat on reconnect, using the token plus its last-seen sequence number.

## Design
- shadcn/ui on Radix UI + Tailwind CSS, all MIT. Radix supplies WAI-ARIA / WCAG AA-level primitives; shadcn's owned, copy-paste components leave the visual language fully ours, which is how one accessible system serves kids and adults.
- Shared sizing honors both ages: touch targets at 48px (Apple 44, Material 48), an 8pt grid with 24px around targets, and a playful high-contrast palette held to 4.5:1 for text and 3:1 for UI (WCAG AA). Child-facing controls go larger than 48px as a research-based courtesy, not a guideline requirement.

## Testing
- The transition logic is a pure function of state plus an event, with no clocks, randomness, or I/O inside, so a synchronous replay of ordered events reproduces identical state every time.
- Time is not a source of non-determinism: ordering is a server-assigned monotonic sequence, not a timestamp, and the transition function reads no clock. The remaining seams are injectable — game-id mint, player-token mint, and the event-log backend — and transport tests exercise the real WebSocket client against an ephemeral server with an in-memory SQLite log.
- Property-based tests (fast-check + Vitest) feed arbitrary command streams and assert the invariants that ARE the mechanism: numbers are monotonic and gapless from zero, replaying from any sequence reproduces the live state, and the final state depends only on the ordered log. Runs are reproducible (fast-check seeds every run and echoes the failing seed) and a heavier run is available on demand via a higher run count (`npm run test:ci`) than the default local run.
- A few scripted golden replay fixtures pin the client's recovery path.
- Thin real end-to-end tests (real WebSocket plus in-memory SQLite) verify the external contract: reconnect with last sequence N delivers N+1, N+2… in order, and client state matches server state.
- Seat-assignment invariants (unit): first join gets X, second gets O, the game moves waiting→active on the second bind, and a third join is rejected.
- End-to-end lifecycle test (real WebSocket plus in-memory SQLite): the home page mints an id and redirects; two joins bind X then O and server state matches; a third open shows "This game is already full"; reopening with the same cookie rejoins the same seat.
