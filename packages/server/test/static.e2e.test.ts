import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGameServer, type GameServer } from '@tictactoe/server';
import { request } from './http-helpers';

// ---------------------------------------------------------------------------
// Static SPA serving + HTTP method/route contract (real http server, real fs).
// ---------------------------------------------------------------------------

const SPA_MARKER = '<title>SPA</title>';
const SECRET = 'TOPSECRET';

let root: string;
let distDir: string;
let server: GameServer;
let fallback: GameServer;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tictactoe-static-'));
  distDir = path.join(root, 'dist');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    `<!doctype html><html><head>${SPA_MARKER}</head><body>app</body></html>`,
  );
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(distDir, 'styles.css'), 'body{}');
  fs.writeFileSync(path.join(distDir, 'data.json'), '{"ok":true}');
  fs.writeFileSync(path.join(distDir, 'blob.xyz'), 'binary');
  // Sentinel OUTSIDE the served dir: traversal must never reach it.
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET);

  server = createGameServer({ clientDistDir: distDir, createId: () => 'g1' });
  await server.start(0);
  fallback = createGameServer({
    clientDistDir: path.join(root, 'does-not-exist'),
    createId: () => 'g1',
  });
  await fallback.start(0);
});

afterAll(async () => {
  await server.close();
  await fallback.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('static SPA serving', () => {
  it('serves the app shell at /', async () => {
    const res = await request(`${server.origin()}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain(SPA_MARKER);
  });

  it('serves the app shell for a game route (/g/:id)', async () => {
    const res = await request(`${server.origin()}/g/g1`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain(SPA_MARKER);
  });

  it('maps .js to text/javascript', async () => {
    const res = await request(`${server.origin()}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.body).toContain('console.log');
  });

  it('maps .css to text/css', async () => {
    const res = await request(`${server.origin()}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('maps .json to application/json and unknown extensions to octet-stream', async () => {
    const json = await request(`${server.origin()}/data.json`);
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toBe('application/json');

    const unknown = await request(`${server.origin()}/blob.xyz`);
    expect(unknown.status).toBe(200);
    expect(unknown.headers['content-type']).toBe('application/octet-stream');
  });

  it('404s a missing static file', async () => {
    const res = await request(`${server.origin()}/missing.js`);
    expect(res.status).toBe(404);
  });

  it('405s a non-GET request', async () => {
    const res = await request(`${server.origin()}/api/new-game`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('falls back to the notice page when the client build is absent', async () => {
    const res = await request(`${fallback.origin()}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('The client app was not found');
  });

  it('mints a single-use game id that must not be cached', async () => {
    const res = await request(`${server.origin()}/api/new-game`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({ gameId: 'g1' });
  });

  it('keeps traversal attempts inside the dist dir', async () => {
    // FINDING: the 403 guard in serveApp is unreachable over HTTP. WHATWG URL
    // normalization collapses `%2e%2e` dot-segments, so the request never
    // escapes dist and lands on a 404. `%2f` stays percent-encoded, so no
    // decoded separator escapes either. The security invariant (no file
    // outside dist is served) still holds, which is what we assert here.
    for (const raw of ['/%2e%2e/%2e%2e/etc/passwd', '/%2e%2e/secret.txt']) {
      const res = await request(`${server.origin()}${raw}`);
      expect(res.status).not.toBe(200);
      expect(res.body).not.toContain(SECRET);
    }
  });
});
