import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './index';

const port = Number(process.env.PORT ?? 3001);
// Resolve the default against this module, not cwd, so every launch method
// (npm workspace, `node src/main.ts` from the repo root) uses the same file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SQLITE_PATH ?? path.resolve(__dirname, '..', 'data', 'ttt.sqlite');
const server = createGameServer({ eventLog: { dbPath } });
console.log(`Event log: ${dbPath}`);
server
  .start(port)
  .then((p) => {
    console.log(`Tic-Tac-Toe server ready at ${server.origin()} (bound ${p})`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
