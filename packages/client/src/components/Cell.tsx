import type { Cell as CellIndex, Player } from '@tictactoe/core';
import { Button } from '@/components/ui/button';

interface Props {
  index: CellIndex;
  mark: Player | null;
  onClick: () => void;
  disabled: boolean;
}

/** A single board square, rendered as a real button for keyboard/screen-reader use. */
export default function Cell({ index, mark, onClick, disabled }: Props) {
  const row = Math.floor(index / 3) + 1;
  const col = (index % 3) + 1;
  const label = mark ? `${mark}, row ${row}, column ${col}` : `Empty, row ${row}, column ${col}`;
  const markColor = mark === 'X' ? 'text-mark-x' : mark === 'O' ? 'text-mark-o' : undefined;
  return (
    <Button
      size="boardCell"
      className={markColor}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {mark ?? ''}
    </Button>
  );
}
