// A small JSON-RPC client: HTTP with a timeout, retries and fallback endpoints, and a WebSocket
// client for the Substrate node that serves no HTTP. Read-only methods only; nothing here signs.
//
// Calls made to the same endpoint within a few milliseconds of each other go out as one JSON-RPC
// batch, up to the endpoint's `batch` size, so a page load costs a few requests per node rather
// than dozens. An endpoint that does not answer a batch as a batch gets its calls one by one from
// then on. Requests leave the browser's preflight cache alone (no `cache: "no-store"`: a POST is
// never served from the HTTP cache anyway), so a node that allows it is asked for CORS once.

export interface Endpoint {
  id: string;
  label: string;
  url: string;
  /** The most calls the endpoint takes in one batch; 1 or absent sends each call on its own. */
  batch?: number;
  /** The widest eth_getLogs range, in blocks, the node serves in one call, where it caps it; absent: no cap known. */
  logRange?: number;
}

/** The endpoint could not be reached or did not answer in time. */
export class TransportError extends Error {
  readonly endpoint: Endpoint;

  constructor(message: string, endpoint: Endpoint) {
    super(message);
    this.endpoint = endpoint;
  }
}

/** The node answered with a JSON-RPC error (for eth_call, a revert carries its data here). */
export class NodeError extends Error {
  readonly code: number | undefined;
  readonly data: string | undefined;
  readonly endpoint: Endpoint;

  constructor(code: number | undefined, message: string, data: string | undefined, endpoint: Endpoint) {
    super(message);
    this.code = code;
    this.data = data;
    this.endpoint = endpoint;
  }

  get isRevert(): boolean {
    return this.code === 3 || /revert/i.test(this.message);
  }
}

/** Every endpoint failed; `problems` says how. */
export class AllFailed extends Error {
  readonly method: string;
  readonly problems: string[];

  constructor(method: string, problems: string[]) {
    super(`${method}: ${problems.join("; ")}`);
    this.method = method;
    this.problems = problems;
  }
}

export interface Answer<T> {
  result: T;
  endpoint: Endpoint;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Extra attempts per endpoint after a transport failure. */
  retries?: number;
  /** An answer this refuses (a null receipt, say) moves on to the next endpoint. */
  accept?: (result: unknown) => boolean;
}

let nextId = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorData(error: Record<string, unknown>): string | undefined {
  const d = error.data;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && typeof (d as Record<string, unknown>).data === "string") return (d as Record<string, string>).data;
  return undefined;
}

interface Call {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

/** One POST: the parsed JSON body and the HTTP status, or a TransportError when there is no JSON answer. */
async function post(ep: Endpoint, payload: Call | Call[], timeoutMs: number): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new TransportError(ctrl.signal.aborted ? `no answer in ${timeoutMs / 1000} s` : "unreachable", ep);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TransportError(ctrl.signal.aborted ? `no answer in ${timeoutMs / 1000} s` : res.ok ? "not a JSON-RPC answer" : `HTTP ${res.status}`, ep);
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** A JSON-RPC answer object: its result, or its error as a NodeError. */
function settle(answer: Record<string, unknown>, ep: Endpoint): { result: unknown } | { error: NodeError } {
  if (answer.error && typeof answer.error === "object") {
    const e = answer.error as Record<string, unknown>;
    return { error: new NodeError(typeof e.code === "number" ? e.code : undefined, String(e.message ?? "error"), errorData(e), ep) };
  }
  return { result: answer.result };
}

async function postOnce(ep: Endpoint, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  const r = await post(ep, { jsonrpc: "2.0", id: nextId++, method, params }, timeoutMs);
  if (!r.ok || typeof r.body !== "object" || r.body === null || Array.isArray(r.body)) throw new TransportError(r.ok ? "not a JSON-RPC answer" : `HTTP ${r.status}`, ep);
  const s = settle(r.body as Record<string, unknown>, ep);
  if ("error" in s) throw s.error;
  return s.result;
}

// ---------------------------------------------------------------------------------------------
// Batching

interface Queued {
  call: Call;
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** How long calls wait for others to the same endpoint before their batch leaves. */
const BATCH_WINDOW_MS = 8;
const queues = new Map<string, { ep: Endpoint; calls: Queued[] }>();
/** Endpoints that answered a batch with something other than a batch answer: one call at a time from then on. */
const noBatch = new Set<string>();

function batchSize(ep: Endpoint): number {
  return noBatch.has(ep.url) ? 1 : Math.max(1, ep.batch ?? 1);
}

function sendAlone(ep: Endpoint, q: Queued): void {
  postOnce(ep, q.call.method, q.call.params, q.timeoutMs).then(q.resolve, q.reject);
}

async function sendBatch(ep: Endpoint, calls: Queued[]): Promise<void> {
  if (calls.length === 1) {
    sendAlone(ep, calls[0]!);
    return;
  }
  let r: { ok: boolean; status: number; body: unknown };
  try {
    r = await post(
      ep,
      calls.map((c) => c.call),
      Math.max(...calls.map((c) => c.timeoutMs)),
    );
  } catch (error) {
    // No answer at all: each call's own retries and fallbacks take it from here.
    for (const c of calls) c.reject(error as Error);
    return;
  }
  const answers = Array.isArray(r.body) ? (r.body as unknown[]) : null;
  if (!answers || r.status === 429) {
    const single = !answers && r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : null;
    const saysBatch = !!single && /batch/i.test(JSON.stringify(single.error ?? ""));
    if (!r.ok && !saysBatch) {
      for (const c of calls) c.reject(new TransportError(`HTTP ${r.status}`, ep));
      return;
    }
    // One answer to a whole batch ("batched requests are not supported"): send these one by one.
    noBatch.add(ep.url);
    for (const c of calls) sendAlone(ep, c);
    return;
  }
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const a of answers) if (a && typeof a === "object") byId.set((a as Record<string, unknown>).id, a as Record<string, unknown>);
  for (const c of calls) {
    const a = byId.get(c.call.id);
    const e = a?.error && typeof a.error === "object" ? (a.error as Record<string, unknown>) : null;
    if (!a || (e && /batch/i.test(String(e.message ?? "")))) {
      // No answer for this call, or the batch itself refused (too many calls for the plan, say).
      if (e) noBatch.add(ep.url);
      sendAlone(ep, c);
      continue;
    }
    const s = settle(a, ep);
    if ("error" in s) c.reject(s.error);
    else c.resolve(s.result);
  }
}

/** For the tests: forget what was learned about endpoints and drop queued calls. */
export function resetBatching(): void {
  queues.clear();
  noBatch.clear();
}

function flush(url: string): void {
  const q = queues.get(url);
  queues.delete(url);
  if (!q) return;
  const size = batchSize(q.ep);
  for (let i = 0; i < q.calls.length; i += size) void sendBatch(q.ep, q.calls.slice(i, i + size));
}

/** One call to one endpoint, batched with the calls made to it at about the same time. */
function send(ep: Endpoint, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  if (batchSize(ep) <= 1) return postOnce(ep, method, params, timeoutMs);
  return new Promise((resolve, reject) => {
    let q = queues.get(ep.url);
    if (!q) {
      q = { ep, calls: [] };
      queues.set(ep.url, q);
      setTimeout(() => flush(ep.url), BATCH_WINDOW_MS);
    }
    q.calls.push({ call: { jsonrpc: "2.0", id: nextId++, method, params }, timeoutMs, resolve, reject });
  });
}

/**
 * Sends `method` to the endpoints in order until one answers. A transport failure is retried, then
 * the next endpoint is tried; a node error moves to the next endpoint too (a pruned range, an
 * unsupported method), except a revert, which is an answer and is thrown to the caller.
 */
export async function request<T>(endpoints: Endpoint[], method: string, params: unknown[], opts: RequestOptions = {}): Promise<Answer<T>> {
  const { timeoutMs = 8000, retries = 1, accept } = opts;
  const problems: string[] = [];
  for (const ep of endpoints) {
    let problem = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await send(ep, method, params, timeoutMs);
        if (accept && !accept(result)) {
          problem = "no data";
          break;
        }
        return { result: result as T, endpoint: ep };
      } catch (error) {
        if (error instanceof NodeError) {
          if (error.isRevert) throw error;
          problem = error.message;
          break;
        }
        problem = (error as Error).message;
        if (attempt < retries) await sleep(350 * (attempt + 1));
      }
    }
    problems.push(`${ep.label}: ${problem}`);
  }
  throw new AllFailed(method, problems);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One WebSocket to a Substrate node, opened on first use and again after it closes. */
export class WsClient {
  private socket: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private readonly pending = new Map<number, Pending>();
  readonly endpoint: Endpoint;

  constructor(endpoint: Endpoint) {
    this.endpoint = endpoint;
  }

  private connect(timeoutMs: number): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const opening = new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.endpoint.url);
      } catch {
        reject(new TransportError("could not open a WebSocket", this.endpoint));
        return;
      }
      const timer = setTimeout(() => {
        reject(new TransportError(`no connection in ${timeoutMs / 1000} s`, this.endpoint));
        ws.close();
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        this.socket = ws;
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new TransportError("unreachable", this.endpoint));
      };
      ws.onclose = () => {
        if (this.socket === ws) this.socket = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new TransportError("connection closed", this.endpoint));
          this.pending.delete(id);
        }
      };
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        const id = typeof msg.id === "number" ? msg.id : -1;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (msg.error && typeof msg.error === "object") {
          const e = msg.error as Record<string, unknown>;
          p.reject(new NodeError(typeof e.code === "number" ? e.code : undefined, String(e.message ?? "error"), errorData(e), this.endpoint));
        } else p.resolve(msg.result);
      };
    });
    this.opening = opening;
    const clear = () => {
      if (this.opening === opening) this.opening = null;
    };
    opening.then(clear, clear);
    return opening;
  }

  async request<T>(method: string, params: unknown[] = [], timeoutMs = 8000): Promise<T> {
    const ws = await this.connect(timeoutMs);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TransportError(`no answer in ${timeoutMs / 1000} s`, this.endpoint));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new TransportError("send failed", this.endpoint));
      }
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

/** A Substrate node over HTTP when it serves HTTP, else (or when HTTP fails) over its WebSocket. */
export class SubstrateClient {
  private readonly ws: WsClient;
  readonly http: Endpoint | null;
  readonly wsEndpoint: Endpoint;

  constructor(http: Endpoint | null, wsEndpoint: Endpoint) {
    this.http = http;
    this.wsEndpoint = wsEndpoint;
    this.ws = new WsClient(wsEndpoint);
  }

  async request<T>(method: string, params: unknown[] = [], timeoutMs = 8000): Promise<Answer<T>> {
    const problems: string[] = [];
    if (this.http) {
      try {
        return await request<T>([this.http], method, params, { timeoutMs, retries: 1 });
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { result: await this.ws.request<T>(method, params, timeoutMs), endpoint: this.wsEndpoint };
      } catch (error) {
        problems.push(`${this.wsEndpoint.label}: ${(error as Error).message}`);
        if (error instanceof NodeError) break;
        await sleep(400);
      }
    }
    throw new AllFailed(method, problems);
  }
}
