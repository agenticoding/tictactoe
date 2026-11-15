import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../src/App';
import { useGameSocket } from '../src/useGameSocket';

vi.mock('../src/useGameSocket', () => ({ useGameSocket: vi.fn() }));
vi.mock('../src/navigate', () => ({ navigate: vi.fn() }));

const mockUseGameSocket = vi.mocked(useGameSocket);

/** Render App at `path` by driving the real history API. */
function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(() => mockUseGameSocket.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('App routing', () => {
  it('renders Home at /', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ gameId: 'g1' }) }),
    );

    renderAt('/');

    expect(screen.getByText('Starting a new game…')).toBeTruthy();
  });

  it('renders Game at /g/:id', () => {
    mockUseGameSocket.mockReturnValue({
      state: null,
      player: null,
      error: null,
      errorCode: null,
      terminal: false,
      makeMove: vi.fn(),
    });

    renderAt('/g/abc');

    expect(screen.getByRole('status').textContent).toBe('Connecting…');
  });

  it('renders the not-found page for an unknown route', () => {
    renderAt('/nope');

    expect(screen.getByText('Page not found.')).toBeTruthy();
  });
});
