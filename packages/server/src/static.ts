import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Minimal SPA fallback used when the client build dir is absent. */
const FALLBACK_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tic-Tac-Toe</title>
  </head>
  <body>
    <main>
      <h1>Tic-Tac-Toe</h1>
      <p>The client app was not found. Open <code>/api/new-game</code> to mint a game.</p>
    </main>
  </body>
</html>`;

/** GET /api/new-game -> 200 { gameId } via the injected id mint. */
export function handleNewGame(res: ServerResponse, createId: () => string): void {
  // A minted id is single-use: caches must never replay one to another visitor.
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ gameId: createId() }));
}

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function serveFile(res: ServerResponse, filePath: string, contentType: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }
  res.writeHead(200, { 'content-type': contentType });
  const stream = fs.createReadStream(filePath);
  // Headers are already sent, so a vanished/unreadable file can only abort the
  // response; the handler exists so the stream's 'error' never goes unhandled.
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Serve the built client SPA: `/` and `/g/:id` both return index.html (the
 * client reads the game id from the URL), and any other path resolves to a
 * static file under clientDistDir. When clientDistDir is missing, serve the
 * fallback page instead.
 */
export function serveApp(req: IncomingMessage, res: ServerResponse, clientDistDir: string): void {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (!fs.existsSync(clientDistDir)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FALLBACK_HTML);
    return;
  }

  // SPA routes: home and any game URL serve the app shell.
  if (pathname === '/' || /^\/g\/[^/]+$/.test(pathname)) {
    serveFile(res, path.join(clientDistDir, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  // Static assets under the build dir. Reject path traversal.
  const rel = pathname.replace(/^\/+/, '');
  const filePath = path.resolve(clientDistDir, rel);
  if (filePath !== clientDistDir && !filePath.startsWith(clientDistDir + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  serveFile(res, filePath, contentType(filePath));
}
