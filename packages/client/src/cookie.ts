/**
 * An anonymous seat token is minted by the server on first join and returned
 * in `welcome`. The client stores it so a refresh re-joins the same seat.
 * NOT an account — just a browser cookie that identifies the seat holder.
 */
const cookieName = (gameId: string): string => `tt_token_${encodeURIComponent(gameId)}`;

/** Read this game's stored player token, or null for a brand-new visitor. */
export function getToken(gameId: string): string | null {
  const name = cookieName(gameId);
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  const value = match?.[1];
  return value === undefined ? null : decodeURIComponent(value);
}

/** Persist this game's server-given token (1 year, same-origin only). */
export function setToken(gameId: string, token: string): void {
  document.cookie = `${cookieName(gameId)}=${encodeURIComponent(token)}; path=/; SameSite=Lax; Max-Age=31536000`;
}
