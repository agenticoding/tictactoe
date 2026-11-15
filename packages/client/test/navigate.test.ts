import { describe, it, expect, vi, afterEach } from 'vitest';
import { navigate } from '../src/navigate';

describe('navigate seam', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('assigns the url to window.location.href', () => {
    const location = { href: '' };
    vi.stubGlobal('window', { location });

    navigate('/g/abc');

    expect(location.href).toBe('/g/abc');
  });
});
