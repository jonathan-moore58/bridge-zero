// Minimal JSON-RPC 2.0 client over WebSocket (the global WebSocket of Node 24): numbered
// requests with timeouts, and subscriptions in the Substrate style (the subscribe call
// returns an id, notifications carry { subscription, result }). Every wait is bounded: the
// connection, each request, and close(), which cuts the connection when the node does not
// answer the close frame.

import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { Socket } from "node:net";

export class RpcError extends Error {
  override name = "RpcError";

  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}${code === undefined ? "" : ` (code ${code})`}`);
  }
}

export interface Subscription {
  readonly id: string;
  unsubscribe(): Promise<void>;
}

export interface RpcClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type JsonRpcMessage = {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: { subscription?: string | number; result?: unknown };
};

/** Notifications that arrive before their subscribe call has returned are held, up to this many each. */
const EARLY_NOTIFICATION_LIMIT = 64;
/** How long close() waits for the node to answer the close frame before it cuts the connection. */
const CLOSE_TIMEOUT_MS = 5_000;

/** True when `promise` settles within `ms`; the timer never keeps the process alive. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true as const, () => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The TCP socket under a WebSocket, which Node's WebSocket (undici) does not expose: undici
 * publishes each socket it connects on "undici:client:connected", and the local address of a
 * WebSocket's socket on "undici:websocket:open". Settles with null when either is missing.
 */
function socketOf(ws: WebSocket): { socket: Promise<Socket | null>; stop: () => void } {
  const connected: Socket[] = [];
  let found: (socket: Socket | null) => void = () => {};
  const socket = new Promise<Socket | null>((resolve) => (found = resolve));
  const onConnected = (message: unknown) => {
    const s = (message as { socket?: unknown } | null)?.socket;
    if (s instanceof Socket) connected.push(s);
  };
  const onOpen = (message: unknown) => {
    const m = message as { websocket?: unknown; address?: { address?: unknown; port?: unknown } } | null;
    if (m?.websocket !== ws) return;
    stop(connected.find((s) => s.localPort === m.address?.port && s.localAddress === m.address?.address) ?? null);
  };
  const stop = (s: Socket | null = null) => {
    unsubscribe("undici:client:connected", onConnected);
    unsubscribe("undici:websocket:open", onOpen);
    connected.length = 0;
    found(s);
  };
  subscribe("undici:client:connected", onConnected);
  subscribe("undici:websocket:open", onOpen);
  return { socket, stop: () => stop() };
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, (result: unknown) => void>();
  private readonly early = new Map<string, unknown[]>();
  private readonly ended = new Set<string>();
  private closeError: Error | null = null;
  /** Settles when the socket has closed, for whatever reason. */
  readonly closed: Promise<void>;

  private constructor(
    readonly url: string,
    private readonly socket: WebSocket,
    private readonly requestTimeoutMs: number,
    /** The connection's TCP socket, null when it could not be found. */
    private readonly tcp: Promise<Socket | null>,
  ) {
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", (event) => {
        this.fail(new Error(`connection to ${url} closed (code ${event.code}${event.reason ? `, ${event.reason}` : ""})`));
        resolve();
      });
    });
  }

  static connect(url: string, options: RpcClientOptions = {}): Promise<RpcClient> {
    const connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      const tcp = socketOf(socket);
      const timer = setTimeout(() => {
        tcp.stop();
        socket.close();
        reject(new Error(`no connection to ${url} after ${connectTimeoutMs} ms`));
      }, connectTimeoutMs);
      const onOpen = () => {
        cleanup();
        // undici publishes the open socket right after this event; whatever it published is in by then.
        setImmediate(tcp.stop);
        resolve(new RpcClient(url, socket, options.requestTimeoutMs ?? 60_000, tcp.socket));
      };
      const onFailure = () => {
        cleanup();
        tcp.stop();
        reject(new Error(`cannot connect to ${url}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onFailure);
      socket.addEventListener("close", onFailure);
    });
  }

  request<T = unknown>(method: string, params: unknown[] = [], timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closeError) return Promise.reject(this.closeError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(method, `no response after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject, timer });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcError(method, `send failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /** Calls `method`, then routes every notification for the returned subscription id to `onResult`. */
  async subscribe<T>(method: string, params: unknown[], unsubscribeMethod: string, onResult: (result: T) => void): Promise<Subscription> {
    const raw = await this.request<unknown>(method, params);
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new RpcError(method, `expected a subscription id, got ${JSON.stringify(raw)}`);
    }
    const id = String(raw);
    const listener = (result: unknown) => onResult(result as T);
    this.listeners.set(id, listener);
    const held = this.early.get(id) ?? [];
    this.early.delete(id);
    held.forEach(listener);
    return {
      id,
      unsubscribe: async () => {
        this.listeners.delete(id);
        this.ended.add(id);
        if (!this.closeError) await this.request(unsubscribeMethod, [raw]).catch(() => undefined);
      },
    };
  }

  /** Why the connection ended, or null while it is open. */
  get closeReason(): Error | null {
    return this.closeError;
  }

  /**
   * Sends the close frame and waits up to CLOSE_TIMEOUT_MS for the node's; a node that stalls
   * (TCP open, nothing answered) has its connection cut then. Returns in a few seconds at most.
   */
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close(1000, "done");
    if (await settlesWithin(this.closed, CLOSE_TIMEOUT_MS)) return;
    this.fail(new Error(`connection to ${this.url} cut: no answer to the close frame within ${CLOSE_TIMEOUT_MS} ms`));
    const tcp = await this.tcp;
    tcp?.destroy();
    if (tcp) await settlesWithin(this.closed, 1_000);
  }

  private onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      return; // not JSON: ignore
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return; // timed out already
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new RpcError(pending.method, message.error.message ?? "error", message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const subscription = message.params?.subscription;
    if (typeof message.method === "string" && subscription !== undefined) {
      const id = String(subscription);
      const listener = this.listeners.get(id);
      if (listener) {
        listener(message.params?.result);
      } else if (!this.ended.has(id)) {
        const held = this.early.get(id) ?? [];
        if (held.length < EARLY_NOTIFICATION_LIMIT) held.push(message.params?.result);
        this.early.set(id, held);
      }
    }
  }

  private fail(error: Error): void {
    this.closeError ??= error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError(pending.method, error.message));
      this.pending.delete(id);
    }
  }
}
