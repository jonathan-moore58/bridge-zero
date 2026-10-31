// The Verify page's words and lists, apart from the build's records so that node --test runs them:
// the transfers it lists to pick from (the recorded locks and burns, newest first), what the field
// takes (lock-7, 7, burn-base-sepolia-0, a transaction hash), and the commands that check the same
// without this page. The checks themselves are ../lib/proof/verify.ts; the reads and the runs are
// ./verify.ts.

import type { Hex } from "../lib/hex.ts";
import type { Facts, Run } from "../lib/proof/verdict.ts";
import type { BurnRecord, RecordedLock, ReleaseRecord, RollupRuns } from "../lib/records-types.ts";
import { DESTS, burnKey, destByChainId, lockKey, refOf, type Dest, type DestKey } from "./dests.ts";

/** What the card's head says of a transfer: from the records at once, or once its chain has been read. */
export interface VerifyHead {
  dir: "in" | "back";
  dest: DestKey;
  /** "Lock 4", "Burn 0 on Base Sepolia". */
  label: string;
  /** When it was signed or mined (ms), when known. */
  at: number | null;
  /** Base units, 14 decimals; null until read. */
  amount: bigint | null;
  /** A lock from a Polkadot wallet. */
  substrate: boolean;
}

export type VerifyState =
  /** Its chain is being read: the head when the records give it. */
  | { status: "resolving"; head: VerifyHead | null }
  /** No lock or burn of this bridge goes by this id. */
  | { status: "none"; why: string }
  | { status: "error"; head: VerifyHead | null; why: string }
  | { status: "run"; head: VerifyHead; run: Run };

/**
 * The destination #/verify/<id> is about, whose light client the top bar's status shows, as a
 * receipt's: a burn's by its id; a lock's by its run, once its chain named it, else by the records
 * (`recorded`); null while a lock beyond the records is read, or for an id of no transfer.
 */
export function verifyDest(id: string, state: VerifyState | undefined, recorded: VerifyHead | null): DestKey | null {
  const k = refOf(id);
  if (!k) return null;
  if (k.dir === "back") return k.dest;
  return (state && state.status !== "none" ? state.head?.dest : null) ?? recorded?.dest ?? null;
}

/** What the picker lists of a transfer, and what the check list's head says before anything is read. */
export interface PickRow {
  /** Its id: #/verify/<id>. */
  id: string;
  dir: "in" | "back";
  dest: DestKey;
  /** The lock's nonce, or the burn's. */
  n: number;
  /** Base units, 14 decimals. */
  amount: bigint;
  /** When it was signed (ms). */
  at: number;
  /** "Lock 4", "Burn 0 on Base Sepolia". */
  label: string;
  /** A lock from a Polkadot wallet: a Substrate extrinsic. */
  substrate: boolean;
  /** Minted, or released, by the records; for a lock read from V3, by used(n) on the chain it names, null when that was not answered. */
  done: boolean | null;
}

/**
 * A lock past the records, read from V3 for the picker: its nonce; its Locked log being read, read,
 * or not read (V3's EVM RPC did not answer); and its row once read (null for one with none, a
 * Substrate extrinsic's).
 */
export interface BeyondLock {
  n: number;
  read: "reading" | "read" | "failed";
  row: PickRow | null;
}

/**
 * A lock past the records once its Locked log was asked for: "failed" when V3's EVM RPC did not
 * answer, never taken for a lock with no log; else its row when the log names a destination, minted
 * by used(n) there (null when that was not answered), or none.
 */
export function beyondLock(n: number, log: { dest: DestKey; amount: bigint; at: number | null; minted: boolean | null } | "failed" | null): BeyondLock {
  if (log === "failed") return { n, read: "failed", row: null };
  const row: PickRow | null = log ? { id: lockKey(n), dir: "in", dest: log.dest, n, amount: log.amount, at: log.at ?? Number.NaN, label: `Lock ${n}`, substrate: false, done: log.minted } : null;
  return { n, read: "read", row };
}

/** What the picker says of a lock past the records that has no row: its log being read, not read, or none (a Substrate extrinsic's). */
export function bareMeta(read: BeyondLock["read"]): string {
  if (read === "reading") return "Reading its Locked log on V3…";
  if (read === "failed") return "Its Locked log could not be read: V3's EVM RPC did not answer";
  return "No Locked log through V3's EVM RPC: a lock from a Polkadot wallet, which its mint names · read from V3";
}

/** The records the picker reads: the recorded locks, Sepolia's return path and the rollups' runs. */
export interface PickRecords {
  locks: RecordedLock[];
  returnPath: { burns: BurnRecord[]; releases: ReleaseRecord[] };
  rollupRuns: Partial<Record<DestKey, RollupRuns | null>>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (v: number): string => String(v).padStart(2, "0");

/** "Oct 27, 23:55", UTC, as Activity prints a row's time. */
export function dayTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** A burn's name: Sepolia's by its number, a rollup's with its chain. */
export const burnLabel = (dest: DestKey, n: number, dests: readonly Dest[] = DESTS): string =>
  dest === "sepolia" ? `Burn ${n}` : `Burn ${n} on ${dests.find((d) => d.key === dest)?.short ?? dest}`;

/** The recorded locks, newest first: each to the chain it names. */
export function lockRows(r: Pick<PickRecords, "locks">, dests: readonly Dest[] = DESTS): PickRow[] {
  return r.locks
    .flatMap((l): PickRow[] => {
      const d = destByChainId(l.dstChainId, dests);
      return d ? [{ id: lockKey(l.nonce), dir: "in", dest: d.key, n: l.nonce, amount: BigInt(l.amountNative), at: Date.parse(l.signedAt), label: `Lock ${l.nonce}`, substrate: l.via === "substrate", done: l.mint !== null }] : [];
    })
    .sort((a, b) => b.n - a.n);
}

/** The recorded burns, newest first: Sepolia's and each rollup's, each released when the records hold its release by its id. */
export function burnRows(r: Pick<PickRecords, "returnPath" | "rollupRuns">, dests: readonly Dest[] = DESTS): PickRow[] {
  const released = (id: string | null) => !!id && r.returnPath.releases.some((x) => x.burnId === id && x.status === "released");
  const of = (dest: DestKey, b: BurnRecord): PickRow[] =>
    b.ok === true && b.status === 1 && b.burnNonce !== null && b.burnId && b.signedAt
      ? [{ id: burnKey(dest, Number(b.burnNonce)), dir: "back", dest, n: Number(b.burnNonce), amount: BigInt(b.amount), at: Date.parse(b.signedAt), label: burnLabel(dest, Number(b.burnNonce), dests), substrate: false, done: released(b.burnId) }]
      : [];
  return [
    ...r.returnPath.burns.flatMap((b) => of("sepolia", b)),
    ...dests.filter((d) => d.key !== "sepolia").flatMap((d) => (r.rollupRuns[d.key]?.burns ?? []).flatMap((b) => of(d.key, b))),
  ].sort((a, b) => b.at - a.at);
}

/** What the "Another lock or burn" field was given. */
export type FieldInput = { kind: "id"; id: string } | { kind: "hash"; hash: Hex } | { kind: "bad"; why: string };

/** lock-7, a bare 7 (a lock's nonce), burn-0, burn-base-sepolia-0, or a 0x… transaction hash. */
export function readField(text: string): FieldInput {
  const t = text.trim().toLowerCase();
  if (!t) return { kind: "bad", why: "Type a lock's number, a burn's id or a transaction hash." };
  if (/^0x[0-9a-f]{64}$/.test(t)) return { kind: "hash", hash: t as Hex };
  if (/^0x/.test(t)) return { kind: "bad", why: "A transaction hash is 0x and 64 hex digits." };
  const id = /^(0|[1-9]\d{0,8})$/.test(t) ? lockKey(Number(t)) : t.replace(/\s+/g, "-");
  return refOf(id) ? { kind: "id", id } : { kind: "bad", why: "Not an id this page knows: lock-7, 7, burn-0 or burn-base-sepolia-0." };
}

// ---------------------------------------------------------------------------------------------
// Check it without this page

/** A command and what it shows. */
export interface Command {
  what: string;
  cmd: string;
}

/**
 * The same checks with Foundry's cast and coreutils, read-only, against the destination's public
 * RPC: used(n), the client's record of the block and its set's keys, the replay that stops at the
 * nonce, and the header's blake2b-256; for a burn, its id and released(burnId) on V3. For locks 0
 * and 1, the relayer's offline check of their recorded bundles.
 */
export function commandsOf(f: Facts, d: Dest, rpc: string, v3: { vault: string; rpc: string }): Command[] {
  const out: Command[] = [];
  const minter = d.minter ?? "";
  const r = `--rpc-url ${rpc}`;
  const lock = f.burnId === null;
  if (f.nonce !== null && lock) out.push({ what: `used(${f.nonce}) on ${d.short}: true once minted`, cmd: `cast call ${minter} "used(uint256)(bool)" ${f.nonce} ${r}` });
  if (f.nonce !== null && !lock) out.push({ what: `burnIdOf(${f.nonce}) on ${d.short}: the id the committee releases against`, cmd: `cast call ${minter} "burnIdOf(uint256)(bytes32)" ${f.nonce} ${r}` });
  if (f.block && lock) out.push({ what: `the light client's record of #${f.block.number}: its number, state root and set`, cmd: `cast call ${d.lightClient} "headerOf(bytes32)((uint32,bytes32,uint64))" ${f.block.hash} ${r}` });
  if (f.setId !== null) out.push({ what: `set ${f.setId}'s keys, as the client holds them`, cmd: `cast call ${d.lightClient} "authorities(uint64)(bytes32[])" ${f.setId} ${r}` });
  if (f.mint && f.nonce !== null) {
    // A mint sent through Multicall3 goes again as its own call to the minter: Multicall3 would answer with its own error.
    const data = f.mint.data ?? `$(cast tx ${f.mint.tx} input ${r})`;
    out.push({
      what: `the mint sent again as a read${f.mint.data ? ", its own call to the minter (it went through Multicall3)" : ""}: it reverts NonceAlreadyUsed(${f.nonce})`,
      cmd: `cast call ${minter}${f.mint.from ? ` --from ${f.mint.from}` : ""} --data ${data} ${r}`,
    });
  }
  if (f.header) out.push({ what: "the header's blake2b-256: the block hash", cmd: `printf ${f.header.slice(2)} | xxd -r -p | b2sum -l 256` });
  if (f.burnId) out.push({ what: "released(burnId) on V3's vault", cmd: `cast call ${v3.vault} "released(bytes32)(bool)" ${f.burnId} --rpc-url ${v3.rpc}` });
  const bundle = f.burnId === null ? BUNDLES[String(f.nonce)] : undefined;
  if (bundle) out.push({ what: `the relayer's offline check of lock ${f.nonce}'s recorded bundle, with no chain access`, cmd: `cd relayer && npm ci && npm run check -- --dir ../fixtures/${bundle}` });
  return out;
}

/** The recorded mint bundles the relayer's offline check re-verifies: locks 0 and 1. */
const BUNDLES: Partial<Record<string, string>> = { "0": "v3-testnet-hero", "1": "v3-testnet-lock1" };
