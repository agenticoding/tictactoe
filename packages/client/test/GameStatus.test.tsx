import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { initialState, type GameState, type Player } from '@tictactoe/core';
import GameStatus from '../src/components/GameStatus';

const state = (over: Partial<GameState>): GameState => ({ ...initialState('g'), ...over });

afterEach(cleanup);

describe('GameStatus', () => {
  const cases: [string, GameState | null, Player | null, string][] = [
    ['connecting before any state', null, null, 'Connecting…'],
    ['waiting for a second seat', state({ status: 'waiting' }), 'X', 'Waiting for opponent…'],
    ['active on our turn', state({ status: 'active', turn: 'X' }), 'X', 'Your turn — X'],
    ['active on the opponent turn', state({ status: 'active', turn: 'O' }), 'X', 'O to move'],
    ['won', state({ status: 'won', winner: 'X' }), 'X', 'X wins!'],
    ['draw', state({ status: 'draw' }), 'X', 'Draw'],
  ];

  it.each(cases)('announces the %s line', (_name, gameState, player, text) => {
    render(<GameStatus state={gameState} player={player} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe(text);
    expect(status.getAttribute('aria-live')).toBe('polite');
  });
});
