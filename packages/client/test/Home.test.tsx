import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import Home from '../src/components/Home';
import { navigate } from '../src/navigate';

vi.mock('../src/navigate', () => ({ navigate: vi.fn() }));

const mockNavigate = vi.mocked(navigate);
const FAILURE_COPY = 'Couldn’t start a new game. Please try again.';

/** A fetch response that reports success with a game id. */
const okResponse = { ok: true, json: async () => ({ gameId: 'g1' }) } as Response;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Home', () => {
  it('mints a game and navigates to its shareable URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse));

    render(<Home />);

    expect(screen.getByText('Starting a new game…')).toBeTruthy();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/g/g1'));
  });

  it('shows the retry alert when the request rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));

    render(<Home />);

    expect((await screen.findByRole('alert')).textContent).toContain(FAILURE_COPY);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('retries the request in place after a failure', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce(okResponse);
    vi.stubGlobal('fetch', fetch);

    render(<Home />);

    await screen.findByRole('alert');
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/g/g1'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a non-ok response as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));

    render(<Home />);

    expect((await screen.findByRole('alert')).textContent).toContain(FAILURE_COPY);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
