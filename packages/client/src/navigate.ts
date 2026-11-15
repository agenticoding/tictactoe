/**
 * Navigation seam. The only place the app assigns `window.location.href`, so
 * tests can spy on navigation without touching jsdom's non-configurable location.
 */
export function navigate(url: string): void {
  window.location.href = url;
}
