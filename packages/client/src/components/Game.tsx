import { useGameSocket } from '../useGameSocket';
import { terminalErrorTitle } from '../gameClient';
import { navigate } from '../navigate';
import Board from './Board';
import GameStatus from './GameStatus';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Props {
  gameId: string;
}

/** A single game view: connects, renders state, and lets the local seat move. */
export default function Game({ gameId }: Props) {
  const { state, player, error, errorCode, terminal, makeMove } = useGameSocket(gameId);
  const startNewGame = () => {
    navigate('/');
  };
  return (
    <main className="flex min-h-screen flex-col items-center gap-y-6 bg-page px-4 py-12 text-text">
      <h1 className="text-2xl font-bold">Tic-Tac-Toe</h1>
      {error && !terminal && (
        <Alert variant="destructive" className="max-w-sm">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {state ? (
        <>
          <GameStatus state={state} player={player} />
          <Board state={state} player={player} onMove={makeMove} />
        </>
      ) : (
        !error && <GameStatus state={null} player={null} />
      )}
      <AlertDialog open={terminal} onOpenChange={() => {}}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{terminalErrorTitle(errorCode)}</AlertDialogTitle>
            <AlertDialogDescription>{error}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={startNewGame}>Start a new game</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
