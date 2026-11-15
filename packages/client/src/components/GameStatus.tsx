import type { GameState, Player } from '@tictactoe/core';

interface Props {
  state: GameState | null;
  player: Player | null;
}

/** Human-readable turn/result line. Always announced to assistive tech. */
export default function GameStatus({ state, player }: Props) {
  return (
    <p className="text-lg font-semibold text-status" role="status" aria-live="polite">
      {describe(state, player)}
    </p>
  );
}

function describe(state: GameState | null, player: Player | null): string {
  if (!state) return 'Connecting…';
  switch (state.status) {
    case 'waiting':
      return 'Waiting for opponent…';
    case 'active':
      return state.turn === player ? `Your turn — ${player}` : `${state.turn} to move`;
    case 'won':
      return `${state.winner} wins!`;
    case 'draw':
      return 'Draw';
  }
}
