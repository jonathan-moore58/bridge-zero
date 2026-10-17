// Finds GRANDPA authority-set changes from block headers alone. A set change is a block whose
// digest carries a FRNK ScheduledChange (or ForcedChange) log; pallet_grandpa increments
// Grandpa.CurrentSetId in that same block. Reading the set id at old blocks needs their state,
// which pruning nodes discard (the V3 testnet keeps about 256 blocks), but every node still
// serves old headers, so a scan back from a finalized block works on all of them.

import { bytesToHex, equalBytes, hexToBytes, type Hex } from "./bytes.js";
import { grandpaLogs, type DigestItem, type GrandpaLog, type Header } from "./scale.js";

/** Blocks whose hashes are asked for in one request; their headers are then read in parallel. */
const CHUNK = 256;

export interface HeaderSource {
  /** The hashes of these block numbers on the node's chain, in the same order. */
  blockHashes(numbers: number[]): Promise<Hex[]>;
  /** The header with this hash; rejected unless its SCALE bytes hash to it. */
  header(hash: Hex): Promise<Header>;
}

export interface FoundChange {
  number: number;
  hash: Hex;
  header: Header;
  /** The header's FRNK ScheduledChange and ForcedChange logs, in digest order (normally one). */
  logs: { item: DigestItem; log: GrandpaLog }[];
}

export interface ChangeScan {
  /** Set-change blocks, newest first. */
  changes: FoundChange[];
  /** Every block from `lowest` up to the start block was examined, each the parent of the next. */
  lowest: number;
  /** Headers examined, the start block included. */
  examined: number;
  /** Other FRNK logs (OnDisabled, Pause, Resume) in the examined blocks, newest first. */
  otherLogs: { number: number; kind: GrandpaLog["kind"] }[];
  /** Examined blocks whose header carries RuntimeEnvironmentUpdated (a runtime upgrade), newest first. */
  runtimeUpdates: number[];
}

export interface ScanOptions {
  /** Stop at the block where this many set changes have been found. */
  want: number;
  /** Examine at most this many blocks below the start block. */
  limit: number;
  /** Header requests in flight at once. */
  concurrency: number;
}

/** Runs `fn` over `items` with at most `limit` calls pending; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Walks back from `start` (examined too) until `want` set changes are found, block 0 is
 * examined, or `limit` blocks below `start` have been examined. Each header must be the parent
 * of the one above it, so every block examined is an ancestor of `start`; a start block that is
 * finalized makes them all finalized.
 */
export async function scanSetChanges(source: HeaderSource, start: { header: Header; hash: Uint8Array }, options: ScanOptions): Promise<ChangeScan> {
  if (!Number.isInteger(options.want) || options.want < 1) throw new RangeError(`want must be a positive integer, got ${options.want}`);
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new RangeError(`limit must be a non-negative integer, got ${options.limit}`);
  const scan: ChangeScan = { changes: [], lowest: start.header.number, examined: 0, otherLogs: [], runtimeUpdates: [] };

  /** Records what `header` carries; true once `want` changes are found. */
  const examine = (header: Header, hash: Uint8Array): boolean => {
    const changes: FoundChange["logs"] = [];
    for (const entry of grandpaLogs(header)) {
      if (entry.log.kind === "ScheduledChange" || entry.log.kind === "ForcedChange") changes.push(entry);
      else scan.otherLogs.push({ number: header.number, kind: entry.log.kind });
    }
    if (header.digest.some((d) => d.kind === "RuntimeEnvironmentUpdated")) scan.runtimeUpdates.push(header.number);
    if (changes.length > 0) scan.changes.push({ number: header.number, hash: bytesToHex(hash), header, logs: changes });
    scan.lowest = header.number;
    scan.examined += 1;
    return scan.changes.length >= options.want;
  };

  if (examine(start.header, start.hash)) return scan;
  const floor = Math.max(0, start.header.number - options.limit);
  let child = start.header;
  for (let top = start.header.number - 1; top >= floor; top -= CHUNK) {
    const numbers: number[] = [];
    for (let n = top; n >= Math.max(floor, top - CHUNK + 1); n--) numbers.push(n);
    const hashes = await source.blockHashes(numbers);
    const headers = await mapLimit(hashes, options.concurrency, (hash) => source.header(hash));
    for (let i = 0; i < numbers.length; i++) {
      const header = headers[i];
      const hash = hexToBytes(hashes[i]);
      if (header.number !== numbers[i]) throw new Error(`asked for #${numbers[i]}, got the header of #${header.number}`);
      if (!equalBytes(child.parentHash, hash)) throw new Error(`#${numbers[i]} ${hashes[i]} is not the parent of #${child.number}`);
      if (examine(header, hash)) return scan;
      child = header;
    }
  }
  return scan;
}
