import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { GAME_FULL_MESSAGE, initialState, type GameState } from '@tictactoe/core';
import Game from '../src/components/Game';
import { useGameSocket } from '../src/useGameSocket';
import { navigate } from '../src/navigate';

vi.mock('../src/useGameSocket', () => ({ useGameSocket: vi.fn() }));
vi.mock('../src/navigate', () => ({ navigate: vi.fn() }));

const mockUseGameSocket = vi.mocked(useGameSocket);
const mockNavigate = vi.mocked(navigate);

const state = (over: Partial<GameState> = {}): GameState => ({ ...initialState('g'), ...over });

/** A complete hook view with per-test overrides. */
function view(over: Partial<ReturnType<typeof useGameSocket>> = {}): ReturnType<typeof useGameSocket> {
  return { state: null, player: null, error: null, errorCode: null, terminal: false, makeMove: vi.fn(), ...over };
}

beforeEach(() => {
  mockUseGameSocket.mockReset();
  mockNavigate.mockReset();
});
afterEach(cleanup);

describe('Game', () => {
  it('surfaces a terminal game-full error in the dialog with friendly copy', () => {
    mockUseGameSocket.mockReturnValue(view({ terminal: true, error: GAME_FULL_MESSAGE, errorCode: 'game-full' }));

    render(<Game gameId="g" />);

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Game full')).toBeTruthy();
    expect(screen.getByText(GAME_FULL_MESSAGE)).toBeTruthy();
  });

  it('titles the seat-evicted dialog for a game open in another window', () => {
    mockUseGameSocket.mockReturnValue(
      view({ terminal: true, error: 'This game is open in another window.', errorCode: 'seat-evicted' }),
    );

    render(<Game gameId="g" />);

    expect(screen.getByText('Game open elsewhere')).toBeTruthy();
    expect(screen.getByText('This game is open in another window.')).toBeTruthy();
  });

  it('shows a transient error as an inline alert, not a dialog', () => {
    mockUseGameSocket.mockReturnValue(view({ error: 'Connection lost. Reconnecting…' }));

    render(<Game gameId="g" />);

    expect(screen.getByRole('alert').textContent).toContain('Connection lost. Reconnecting…');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('renders the status line and board once state arrives', () => {
    mockUseGameSocket.mockReturnValue(
      view({ state: state({ status: 'active', turn: 'X' }), player: 'X' }),
    );

    render(<Game gameId="g" />);

    expect(screen.getByText('Your turn — X')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Tic-tac-toe board' })).toBeTruthy();
  });

  it('starts a new game by navigating home from the full-game dialog', () => {
    mockUseGameSocket.mockReturnValue(view({ terminal: true, error: GAME_FULL_MESSAGE, errorCode: 'game-full' }));

    render(<Game gameId="g" />);
    screen.getByText('Start a new game').click();

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
