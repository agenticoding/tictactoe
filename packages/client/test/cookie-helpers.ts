/** Remove every game-scoped token so client tests start as a new browser. */
export function clearGameTokens(): void {
  for (const cookie of document.cookie.split('; ')) {
    const name = cookie.split('=', 1)[0];
    if (name?.startsWith('tt_token_')) document.cookie = `${name}=; path=/; Max-Age=0`;
  }
}
