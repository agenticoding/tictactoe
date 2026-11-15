import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initialState, type Board as BoardModel, type GameState } from '@tictactoe/core';
import Board from '../src/components/Board';

const state = (over: Partial<GameState>): GameState => ({ ...initialState('g'), ...over });

/** A fresh board with `mark` placed at `cell`. */
function boardWith(cell: number, mark: 'X' | 'O'): BoardModel {
  const board = initialState('g').board.slice();
  board[cell] = mark;
  return board;
}

const cells = (): HTMLButtonElement[] => {
  const group = screen.getByRole('group', { name: 'Tic-tac-toe board' });
  return within(group).getAllByRole('button') as HTMLButtonElement[];
};

afterEach(cleanup);

describe('Board', () => {
  it('renders nine cells inside a labelled group', () => {
    render(<Board state={state({})} player={null} onMove={() => {}} />);
    expect(cells()).toHaveLength(9);
  });

  it('disables every cell while the game is not active', () => {
    render(<Board state={state({ status: 'waiting' })} player="X" onMove={() => {}} />);
    expect(cells().every((c) => c.disabled)).toBe(true);
  });

  it("disables every cell when it is not the local player's turn", () => {
    render(
      <Board state={state({ status: 'active', turn: 'O' })} player="X" onMove={() => {}} />,
    );
    expect(cells().every((c) => c.disabled)).toBe(true);
  });

  it("disables an occupied cell but leaves empty ones live on the local player's turn", () => {
    render(
      <Board state={state({ status: 'active', turn: 'X', board: boardWith(0, 'X') })} player="X" onMove={() => {}} />,
    );
    const [occupied, empty] = cells();
    expect(occupied!.disabled).toBe(true);
    expect(empty!.disabled).toBe(false);
  });

  it('calls onMove with the clicked cell index', async () => {
    const onMove = vi.fn();
    render(<Board state={state({ status: 'active', turn: 'X' })} player="X" onMove={onMove} />);

    await userEvent.click(cells()[0]!);

    expect(onMove).toHaveBeenCalledWith(0);
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('ignores a click on an occupied cell', async () => {
    const onMove = vi.fn();
    render(
      <Board state={state({ status: 'active', turn: 'X', board: boardWith(4, 'X') })} player="X" onMove={onMove} />,
    );

    await userEvent.click(cells()[4]!);

    expect(onMove).not.toHaveBeenCalled();
  });
});
