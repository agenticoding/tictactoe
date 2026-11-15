/**
 * Minimal in-process WebSocket stand-in for hook tests. jsdom ships no server,
 * so tests drive the lifecycle explicitly through the emit* helpers. Only the
 * surface useGameSocket touches is implemented; the factory casts to the DOM
 * WebSocket type at the boundary so production typing is unaffected.
 */
export class FakeWebSocket {
  readonly url: string;
  /** 0 = CONNECTING, like a real socket before the handshake completes. */
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /**
   * Browser-faithful close: close() while CONNECTING queues the close event
   * (HTML spec), so tests can exercise disposed-socket races.
   */
  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2; // CLOSING
    setTimeout(() => {
      this.readyState = 3; // CLOSED
      this.onclose?.();
    }, 0);
  }

  /** Complete the handshake; the socket becomes OPEN (1), matching WebSocket.OPEN. */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver a server frame carrying `obj` as its JSON payload. */
  emitMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  /** Deliver raw frame text; used to exercise malformed-JSON handling. */
  emitRaw(data: string): void {
    this.onmessage?.({ data });
  }

  /** Simulate the transport/peer closing. */
  emitClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

export interface SocketFactory {
  createSocket: (url: string) => WebSocket;
  sockets: FakeWebSocket[];
  latest: () => FakeWebSocket;
}

/** A fresh factory + registry per test so socket state never leaks between tests. */
export function createSocketFactory(): SocketFactory {
  const sockets: FakeWebSocket[] = [];
  const createSocket = (url: string): WebSocket => {
    const ws = new FakeWebSocket(url);
    sockets.push(ws);
    return ws as unknown as WebSocket;
  };
  return {
    createSocket,
    sockets,
    latest: () => {
      const ws = sockets.at(-1);
      if (!ws) throw new Error('no socket created yet');
      return ws;
    },
  };
}
