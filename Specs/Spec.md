A realtime multiplayer tic tac toe game

Tech stack:
- React
- NodeJS
- Typescript

Architecture:
- Server is the source of truth
- Unique URL per game instance. No login, click the URL and you join the game
- Server stores game data in SQLite
- Clients communicate over WebSockets
- Server pushes state updates to clients
- Sequential logical sequence per game creates total ordering so clients can recover from error by replaying events from last known sequence value. **TODO:** How do we reliably and deterministically test these mechanisms?

**TODO:** What's a good open source design system that can be used for this game with a compatible license? The game targets kids and adults as one.