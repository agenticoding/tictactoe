import { afterEach, describe, expect, it } from 'vitest';
import { getToken, setToken } from '../src/cookie';
import { clearGameTokens } from './cookie-helpers';

afterEach(clearGameTokens);

describe('game-scoped seat cookies', () => {
  it('keeps each game token separate', () => {
    setToken('game-a', 'token-a');
    setToken('game-b', 'token-b');

    expect(getToken('game-a')).toBe('token-a');
    expect(getToken('game-b')).toBe('token-b');
  });
});
