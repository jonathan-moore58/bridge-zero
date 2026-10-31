// The watcher goes on through an error that no round handles (watch.ts lastResort), and counts it
// (outsideErrors: the round that saw it signs nothing more), against stand-ins on local ports for
// the V3 node, its EVM RPC and Sepolia's RPC. polkadot-js subscribes to the runtime version at the
// end of its init with no error handler, and RxJS throws an error of that subscription from a
// timer, outside every round: on Oct 30 its request had no answer after the laptop slept, the
// provider gave it up after its 60 s request timeout, and Node ended the watcher on that uncaught
// exception. release.test.ts has the tool's other runs.
//
//   npm test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";

const RELAYER = fileURLToPath(new URL("..", import.meta.url));
const CLOSED = "http://127.0.0.1:9";
const SCRATCH = join(tmpdir(), "bz-release-last-resort-test");

interface Run {
  code: number | null;
  out: string;
}

/** Every chain's RPC a closed local port, unless a test names a stand-in. */
const ENV = { SEPOLIA_RPC_URL: CLOSED, BASE_SEPOLIA_RPC_URL: CLOSED, ARBITRUM_SEPOLIA_RPC_URL: CLOSED, BASE_SEPOLIA_ARCHIVE_RPC_URLS: CLOSED, ARBITRUM_SEPOLIA_ARCHIVE_RPC_URLS: CLOSED };

/** Node with tsx and `argv` in relayer/ (the tool: src/release.ts and its arguments); a child that runs past 90 s is killed, so none outlives its test. */
function node(argv: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...argv], { cwd: RELAYER, env: { ...process.env, ...ENV, ...env }, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const kill = setTimeout(() => child.kill(), 90_000);
    child.on("error", (error) => {
      clearTimeout(kill);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      done({ code, out });
    });
  });
}

/**
 * A stand-in for the V3 node over WebSocket, the handshake and the frames by hand (as
 * automint.test.ts's): it answers what ApiPromise asks at its init (V3's genesis, spec 3002 and its
 * metadata, from fixtures/v3-testnet-events), then refuses state_subscribeRuntimeVersion, the init's
 * last request, with an error ("refused"), or never answers it ("unanswered"). Its sockets go to
 * `sockets`, for the test to cut.
 */
function v3Node(subscription: "refused" | "unanswered", sockets: Socket[]): Server {
  const record = JSON.parse(readFileSync(join(RELAYER, "..", "deployments", "v3-testnet.json"), "utf8")) as { genesisHash: string };
  const metadata = JSON.parse(readFileSync(join(RELAYER, "..", "fixtures", "v3-testnet-events", "metadata-3002.json"), "utf8")) as { stripped: { gzipBase64: string } };
  const results: Record<string, unknown> = {
    chain_getBlockHash: record.genesisHash,
    state_getRuntimeVersion: { specName: "portaldot-v3", implName: "portaldot-v3", authoringVersion: 1, specVersion: 3002, implVersion: 0, apis: [], transactionVersion: 1, systemVersion: 1 },
    system_chain: "PortaldotV3 Test",
    system_properties: { ss58Format: 42 },
    state_getMetadata: `0x${gunzipSync(Buffer.from(metadata.stripped.gzipBase64, "base64")).toString("hex")}`,
    system_health: { peers: 1, isSyncing: false, shouldHavePeers: true },
  };
  results.rpc_methods = { version: 1, methods: [...Object.keys(results), "rpc_methods", "state_subscribeRuntimeVersion", "state_unsubscribeRuntimeVersion"] };
  /** A text frame, unmasked as a server sends it, its length in 7, 16 or 64 bits. */
  const frame = (message: object): Buffer => {
    const payload = Buffer.from(JSON.stringify(message));
    const n = payload.length;
    let head: Buffer;
    if (n < 126) head = Buffer.from([0x81, n]);
    else if (n < 65_536) head = Buffer.from([0x81, 126, n >> 8, n & 0xff]);
    else {
      head = Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 0, 0]);
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    return Buffer.concat([head, payload]);
  };
  const server = createServer();
  server.on("upgrade", (req, socket: Socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // Each whole frame from the client, masked: a text frame is a request, a close frame the end.
      for (;;) {
        if (pending.length < 2) return;
        const size = pending[1] & 0x7f;
        const at = size === 126 ? 4 : size === 127 ? 10 : 2;
        if (pending.length < at) return;
        const length = size === 126 ? pending.readUInt16BE(2) : size === 127 ? Number(pending.readBigUInt64BE(2)) : size;
        if (pending.length < at + 4 + length) return;
        const mask = pending.subarray(at, at + 4);
        const payload = Buffer.from(pending.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]));
        const opcode = pending[0] & 0x0f;
        pending = pending.subarray(at + 4 + length);
        if (opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode !== 0x1) continue;
        const { id, method } = JSON.parse(payload.toString()) as { id: number; method: string };
        if (method === "state_subscribeRuntimeVersion") {
          if (subscription === "refused") socket.write(frame({ jsonrpc: "2.0", id, error: { code: -32000, message: "subscriptions refused" } }));
          continue;
        }
        socket.write(frame(method in results ? { jsonrpc: "2.0", id, result: results[method] } : { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
      }
    });
  });
  return server;
}

describe("an error polkadot-js throws outside the watcher's round", () => {
  const sockets: Socket[] = [];
  const refusing = v3Node("refused", sockets);
  const silent = v3Node("unanswered", sockets);
  // Sepolia's chain id, for the round's first check.
  const sepolia = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }));
  });
  // V3's EVM RPC, which answers 503 three times: the round ends Unreachable after about 4 s.
  const evm = createServer((_req, res) => {
    res.statusCode = 503;
    res.end();
  });
  const servers = [refusing, silent, sepolia, evm];
  const url = (s: Server, scheme = "http") => `${scheme}://127.0.0.1:${(s.address() as AddressInfo).port}`;

  before(async () => {
    for (const s of servers) await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  });

  after(() => {
    for (const s of sockets) s.destroy();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  });

  it("is written to stderr with the time, and the watcher's round goes on to its end: exit code 2 here, not a crash", { timeout: 120_000 }, async () => {
    // The node refuses the subscription: the error comes as the round, past V3's genesis, waits on the EVM RPC.
    const home = join(SCRATCH, "home");
    mkdirSync(home, { recursive: true });
    const { code, out } = await node(["src/release.ts", "release", "--watch", "10", "--rounds", "1", "--rpc", url(refusing, "ws"), "--evm", url(evm)], { SEPOLIA_RPC_URL: url(sepolia), USERPROFILE: home, HOME: home });
    assert.equal(code, 2, out);
    assert.match(out, /ok\s+genesis 0xd4f9acbc.155283bd is the Portaldot V3 testnet's/);
    assert.match(out, /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z: an uncaught exception that no round handles; the watcher goes on: RpcError: -32000: subscriptions refused/);
    assert.match(out, /the EVM RPC 127\.0\.0\.1:\d+ is unreachable \(eth_chainId: HTTP 503\)/);
    assert.doesNotMatch(out, /reportUnhandledError|Node\.js v\d/);
  });

  it("is an uncaught exception, not an unhandled rejection, when the provider gives the subscription up: lastResort keeps the process running, and counts it", { timeout: 120_000 }, async () => {
    // The API as connectV3 makes it, with a request timeout of 1 s in place of 60 s: the provider
    // looks for requests older than that every 5 s, and the subscription's is one by the first look.
    // With lastResort, the count once connected (as a round reads it) and after the error.
    const script = (kept: boolean) =>
      [
        kept ? `import { lastResort, outsideErrors } from "./src/watch.js"; lastResort((line) => console.error(line));` : "",
        `const { ApiPromise, WsProvider } = await import("@polkadot/api");`,
        `const provider = new WsProvider(${JSON.stringify(url(silent, "ws"))}, 2_500, {}, 1_000);`,
        `const api = await ApiPromise.create({ provider, noInitWarn: true, signedExtensions: { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } } });`,
        kept ? `const connected = outsideErrors();` : "",
        `await new Promise((resolve) => setTimeout(resolve, 8_000));`,
        kept ? "console.log(`errors no round handles: ${connected} once connected, ${outsideErrors()} after`);" : "",
        `await api.disconnect();`,
      ].join("\n");
    const [bare, kept] = await Promise.all([node(["--input-type=module", "-e", script(false)]), node(["--input-type=module", "-e", script(true)])]);
    // What Node does without it: RxJS throws the error from a timer, and the process ends with exit code 1.
    assert.equal(bare.code, 1, bare.out);
    assert.match(bare.out, /reportUnhandledError\.[jt]s:\d+\s+throw err;[^]*Error: No response received from RPC endpoint in 1s\s+at #timeoutHandlers/);
    assert.equal(kept.code, 0, kept.out);
    assert.match(kept.out, /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z: an uncaught exception that no round handles; the watcher goes on: Error: No response received from RPC endpoint in 1s\s+at #timeoutHandlers/);
    // A round that read 0 as it connected sees 1 before its next signing, and signs nothing more (release.ts approveFor).
    assert.match(kept.out, /errors no round handles: 0 once connected, 1 after/);
  });
});
