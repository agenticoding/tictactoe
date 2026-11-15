import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createGameServer, type GameServer } from '@tictactoe/server';
import Home from '../src/components/Home';
import { navigate } from '../src/navigate';

vi.mock('../src/navigate', () => ({ navigate: vi.fn() }));

const mockNavigate = vi.mocked(navigate);

/**
 * Home <-> server wire gate. The real component fetches the real mint endpoint;
 * only the base URL is adapted because jsdom has no origin. The response is
 * never stubbed, so a field/path rename on either side fails this test.
 */
describe('Home against the real server', () => {
  let server: GameServer;

  beforeAll(async () => {
    server = createGameServer({ clientDistDir: '<nonexistent>' });
    await server.start(0);
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('mints over /api/new-game and navigates to the server-issued id', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(new URL(String(input), server.origin()), init),
    );

    render(<Home />);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringMatching(/^\/g\/[0-9a-f-]{36}$/));
  });
});
