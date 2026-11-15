import { type Cell as CellIndex, type GameState, type Player } from '@tictactoe/core';
import Cell from './Cell';

interface Props {
  state: GameState;
  player: Player | null;
  onMove: (cell: CellIndex) => void;
}

/** The 3x3 grid. A cell is clickable only when the game is active, empty, and it's our turn. */
export default function Board({ state, player, onMove }: Props) {
  const interactive = state.status === 'active';
  return (
    <div
      className="grid w-full max-w-96 grid-cols-3 gap-6 rounded-2xl bg-grid p-6"
      role="group"
      aria-label="Tic-tac-toe board"
    >
      {state.board.map((mark, cell) => (
        <Cell
          key={cell}
          index={cell as CellIndex}
          mark={mark}
          onClick={() => onMove(cell as CellIndex)}
          disabled={!interactive || mark !== null || state.turn !== player}
        />
      ))}
    </div>
  );
}
