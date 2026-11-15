import { useEffect, useState } from 'react';
import { gamePath } from '@tictactoe/core';
import { navigate } from '../navigate';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

/** Homepage mints a new game and redirects to its `/g/:id` URL. */
export default function Home() {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/new-game');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { gameId } = (await res.json()) as { gameId: string };
        if (!cancelled) navigate(gamePath(gameId));
      } catch {
        if (!cancelled) setError('Couldn’t start a new game. Please try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-y-6 bg-page px-4 py-12 text-text">
      <h1 className="text-2xl font-bold">Tic-Tac-Toe</h1>
      {error ? (
        <div className="flex flex-col items-center gap-y-4">
          <Alert variant="destructive" className="max-w-sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => {
            setError(null);
            setAttempt((value) => value + 1);
          }}>
            Retry
          </Button>
        </div>
      ) : (
        <p>Starting a new game…</p>
      )}
    </main>
  );
}
