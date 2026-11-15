import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Cell from '../src/components/Cell';

afterEach(cleanup);

describe('Cell', () => {
  it('labels an empty square with its 1-based row and column', () => {
    render(<Cell index={0} mark={null} onClick={() => {}} disabled={false} />);
    expect(screen.getByRole('button', { name: 'Empty, row 1, column 1' })).toBeTruthy();
  });

  it('labels a marked square with the mark and position', () => {
    const { unmount } = render(<Cell index={0} mark="X" onClick={() => {}} disabled={false} />);
    expect(screen.getByRole('button', { name: 'X, row 1, column 1' })).toBeTruthy();
    unmount();

    render(<Cell index={5} mark="O" onClick={() => {}} disabled={false} />);
    expect(screen.getByRole('button', { name: 'O, row 2, column 3' })).toBeTruthy();
  });

  it('fires onClick when enabled', async () => {
    const onClick = vi.fn();
    render(<Cell index={0} mark={null} onClick={onClick} disabled={false} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', async () => {
    const onClick = vi.fn();
    render(<Cell index={0} mark={null} onClick={onClick} disabled />);

    await userEvent.click(screen.getByRole('button'));

    expect(onClick).not.toHaveBeenCalled();
  });
});
