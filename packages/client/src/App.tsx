import Home from './components/Home';
import Game from './components/Game';

/** Matches `/g/:id`. The id is the shareable game key; the game is the URL. */
const GAME_ROUTE = /^\/g\/([^/]+)$/;

export default function App() {
  const match = window.location.pathname.match(GAME_ROUTE);
  if (match) {
    return <Game gameId={decodeURIComponent(match[1]!)} />;
  }
  if (window.location.pathname === '/') {
    return <Home />;
  }
  return (
    <main className="flex min-h-screen flex-col items-center gap-y-6 bg-page px-4 py-12 text-text">
      <h1 className="text-2xl font-bold">Tic-Tac-Toe</h1>
      <p>Page not found.</p>
    </main>
  );
}
