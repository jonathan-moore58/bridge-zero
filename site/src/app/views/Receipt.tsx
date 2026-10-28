// A finished transfer: what was sent, what was checked or trusted, the transactions, on its
// destination (Sepolia, Base Sepolia or Arbitrum Sepolia). The recorded runs come from the build's
// records (Sepolia's locks and burns, and the rollups' burns); a transfer this tab followed, from
// what it read on the way; any other lock or burn, from what the chains say of it now.

import { nodeConsoleBlock } from "../../lib/chains.ts";
import { checksum } from "../../lib/display.ts";
import { useField } from "../../lib/live.ts";
import type { Hex } from "../../lib/records-types.ts";
import { addWtpotToWallet } from "../connect.tsx";
import { deployed, destOf, explorerAddress, explorerTx, type Dest, type DestKey } from "../dests.ts";
import { FAST_CAP, fromOf, toOf, type Speed } from "../facts.ts";
import { ChainMark } from "../marks.tsx";
import type { Route } from "../router.ts";
import { useBox } from "../store.ts";
import {
  FAST_RUN,
  STD_RUN,
  followerOf,
  isDone,
  nonceOf,
  recordedBurn,
  recordedOf,
  timedRun,
  toTokens,
  transfers,
  useChainRead,
  type BurnRun,
  type ChainBurn,
  type ChainLock,
  type ChainTransfer,
  type LiveTransfer,
  type LockRun,
} from "../transfers.ts";
import { Addr, Chip, Icon, Nb, dur, fmt, num, secs, short } from "../ui.tsx";
import { wallet } from "../wallet.ts";
import { ALL_PASSED, ChainWait, ChecksPanel, CssSpan, NotFound, Redirect, TrustPanel, day, factsOf, hhmm, liveFacts, liveLabel, when, type CheckFacts } from "./Tx.tsx";

/** Where a receipt's values come from: the records, this tab (it sent the transfer), or the chains just now. */
type Source = "recorded" | "tab" | "chain";

interface Common {
  /** The chain on the other side of V3. */
  dest: DestKey;
  label: string;
  when: string;
  amount: number;
  /** The address paid on the other chain. */
  to: Hex;
  source: Source;
  /** A lock from a Polkadot wallet: it paid the address the visitor gave on the destination, which may not be theirs. */
  given?: boolean;
}

interface InReceipt extends Common {
  dir: "in";
  lockTx: Hex;
  lockBlock: number;
  /** null when used(nonce) says minted but the mint's log could not be read yet; `gas` null when its receipt could not. */
  mint: { tx: Hex; block: number; gas: number | null } | null;
  /** used(nonce) says minted, and the mint's log is older than the destination's nodes search: it is not looked for again. */
  beyond: boolean;
  /** The mint was mint(p) at a block the light client held already (true), importAndMint (false), or not known (null). */
  held: boolean | null;
  /** A self-relay's transactions before the mint, which imported V3's set changes the light client lacked (block 0: not read). */
  relayed: { tx: Hex; block: number }[];
  facts: CheckFacts;
  /** Seconds: lock, finality, proofs and mint, and the whole, when the run was timed. */
  timing: { parts: readonly [number, number, number, number]; total: number } | null;
  /** An untimed lock's story, for lock 0. */
  note: string | null;
}

interface BackReceipt extends Common {
  dir: "back";
  /** null: the chains say the burn was released, not whether fast or after finality. */
  speed: Speed | null;
  fallback: boolean;
  burnTx: Hex;
  burnBlock: number;
  burnId: Hex | null;
  open: { tx: Hex; block: number } | null;
  /** null: released(burnId) is true on V3. The extrinsic that ran it is a Substrate one, which V3's EVM RPC has no log of. */
  run: { tx: Hex; block: number } | null;
  /** Seconds from sending to the burn's block, from that block to the release, and from sending to the release. */
  fast: { mined: number; fromBlock: number; fromSend: number; measure: string } | null;
  /** Seconds from sending to the release, and the split between its chain's finality and the committee, when known. */
  std: { total: number; split: readonly [string, string] | null; grow: readonly [number, number] | null; measure: string } | null;
}

type Receipt = InReceipt | BackReceipt;

// ---------------------------------------------------------------------------------------------
// The recorded runs

function lockReceipt(r: LockRun, label: string): InReceipt {
  const s = r.steps;
  return {
    dir: "in",
    dest: "sepolia",
    label,
    when: when(r.lockAt),
    amount: toTokens(r.amount),
    to: r.recipient,
    source: "recorded",
    lockTx: r.lockTx,
    lockBlock: r.lockBlock,
    mint: { tx: r.mintTx, block: r.mintBlock, gas: r.mintGas },
    beyond: false,
    held: false,
    relayed: [],
    facts: factsOf(r),
    timing: s ? { parts: [s.lock, s.finality, s.proofs, s.mint], total: s.lock + s.finality + s.proofs + s.mint } : null,
    // Lock 0 was sent at 09:15, and BridgeMinter created at 21:31 the same day (README, row 24).
    note:
      !s && r.nonce === 0 && r.mintAt
        ? `Lock 0 was made on ${day(r.lockAt)}, before BridgeMinter existed, and minted that evening at ${hhmm(r.mintAt)} UTC. A lock does not expire.`
        : null,
  };
}

/**
 * A recorded burn's receipt. Sepolia's are timed: burn 1's measured Fast run, burn 0's records. A
 * rollup's burn 0 waited for the watcher to serve the rollups (README rows 108 to 113), so its hours
 * from the burn to the release are no measure of the way back: it carries no time block.
 */
function burnReceipt(b: BurnRun, label: string): BackReceipt {
  const runAt = b.run.at;
  const sep = b.dest === "sepolia";
  return {
    dir: "back",
    dest: b.dest,
    label,
    when: when(b.burnAt),
    amount: toTokens(b.amount),
    to: b.payee,
    source: "recorded",
    speed: b.fast ? "fast" : "std",
    fallback: false,
    burnTx: b.burnTx,
    burnBlock: b.burnBlock,
    burnId: b.burnId,
    open: b.open ? { tx: b.open.tx, block: b.open.block } : null,
    run: { tx: b.run.tx, block: b.run.block },
    // Burn 1's times are the README's, by the block timestamps (rows 56 to 58).
    fast:
      sep && b.fast && b.n === FAST_RUN.burn
        ? {
            mined: FAST_RUN.mined,
            fromBlock: FAST_RUN.ran - FAST_RUN.mined,
            fromSend: FAST_RUN.ran,
            measure: `Measured ${day(b.burnAt)} · checked against Sepolia's final chain: ok`,
          }
        : null,
    // The whole from the records' times; the split is burn 0's, from the README.
    std:
      sep && !b.fast && runAt
        ? {
            total: (Date.parse(runAt) - Date.parse(b.burnAt)) / 1000,
            split: b.n === STD_RUN.burn ? [STD_RUN.finLabel, STD_RUN.relLabel] : null,
            grow: null,
            measure: `${hhmm(b.burnAt)} → ${hhmm(runAt)} UTC · measured ${day(b.burnAt)} (burn ${b.n})`,
          }
        : null,
  };
}

/** #/receipt/lock-<n> and burn-<n> from the records, and the replays' (replay-in, replay-back?speed=). */
function recordedReceipt(id: string, speedQ: string | null): Receipt | null {
  if (id === "replay-in") {
    const r = timedRun();
    return lockReceipt(r, `Lock ${r.nonce} · the recorded run`);
  }
  if (id === "replay-back") {
    const b = recordedBurn(speedQ === "std" ? "std" : "fast");
    return b ? burnReceipt(b, `Burn ${b.n} · the recorded run`) : null;
  }
  const rec = recordedOf(id);
  if (!rec) return null;
  if (rec.dir === "in") return lockReceipt(rec.run, `Lock ${rec.run.nonce}`);
  const b = rec.run;
  return burnReceipt(b, b.dest === "sepolia" ? `Burn ${b.n}` : `Burn ${b.n} on ${destOf(b.dest).short}`);
}

// ---------------------------------------------------------------------------------------------
// A transfer this tab followed

function liveReceipt(x: LiveTransfer): Receipt | null {
  if (x.dir === "in") {
    const { lock, finality: fin } = x;
    const mint = x.mint?.stage === "mined" ? x.mint : null;
    // Minted by a transaction older than the destination's nodes search: its receipt names none, and is not timed.
    const beyond = !mint && x.mintBeyond !== undefined;
    if (lock.stage !== "mined" || (!mint && !beyond)) return null;
    const end = x.doneAt ?? mint?.minedAt ?? lock.minedAt;
    const built = x.proof.builtAt;
    const sec = (from: number, to: number) => Math.max(0, (to - from) / 1000);
    return {
      dir: "in",
      dest: x.dest,
      label: liveLabel(x),
      when: when(x.startedAt),
      amount: toTokens(x.amount),
      to: x.recipient,
      source: "tab",
      given: x.sender.kind === "substrate",
      lockTx: lock.hash,
      lockBlock: lock.block,
      mint: mint ? { tx: mint.hash, block: mint.block, gas: mint.gasUsed } : null,
      beyond,
      // The block it proved the lock at carries the signatures an import counted, or none: mint(p) imports nothing.
      held: !mint || mint.gasUsed === null || !fin ? null : fin.signatures === null,
      relayed: x.relayed.map((r) => ({ tx: r.hash, block: r.block })),
      facts: liveFacts(x),
      // Finish mint: the lock came before this page followed it, so the transfer is not timed.
      timing:
        mint && fin && built !== null && !x.resumed
          ? {
              parts: [sec(lock.sentAt, lock.minedAt), sec(lock.minedAt, fin.at), sec(fin.at, built), sec(built, end)],
              total: sec(lock.sentAt, end),
            }
          : null,
      note: x.resumed && mint ? `Lock ${x.nonce ?? ""} was made on ${day(lock.minedAt)}, before this page followed it, and minted on ${day(mint.minedAt)}. A lock does not expire.` : null,
    };
  }
  const { burn, release, depth } = x;
  const run = release.run;
  if (burn.stage !== "mined" || !release.released) return null;
  const end = release.at ?? x.doneAt ?? burn.minedAt;
  const sec = (from: number, to: number) => Math.max(0, (to - from) / 1000);
  const q = depth.qualifiedAt;
  return {
    dir: "back",
    dest: x.dest,
    label: liveLabel(x),
    when: when(x.startedAt),
    amount: toTokens(x.amount),
    to: x.recipient,
    source: "tab",
    speed: x.speed,
    fallback: x.fallback,
    burnTx: burn.hash,
    burnBlock: burn.block,
    burnId: x.burnId,
    open: release.open ? { tx: release.open.extrinsic, block: release.open.block } : null,
    run: run ? { tx: run.extrinsic, block: run.block } : null,
    fast:
      x.speed === "fast"
        ? {
            mined: sec(x.startedAt, burn.minedAt),
            fromBlock: sec(burn.minedAt, end),
            fromSend: sec(x.startedAt, end),
            measure: `Timed in this browser, ${day(x.startedAt)}`,
          }
        : null,
    std:
      x.speed === "std"
        ? {
            total: sec(x.startedAt, end),
            split: q !== null ? [dur(sec(burn.minedAt, q)), dur(sec(q, end))] : null,
            grow: q !== null ? [sec(burn.minedAt, q), sec(q, end)] : null,
            measure: `${hhmm(x.startedAt)} → ${hhmm(end)} UTC · timed in this browser`,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// A lock or a burn read from the chains. When it was sent is not on chain, so no time block: the
// receipt says what the chains hold, and when its block was made.

function chainLockReceipt(x: ChainLock, authorities: number | null): InReceipt {
  const f = x.mint?.final ?? null;
  return {
    dir: "in",
    dest: x.dest,
    label: `Lock ${x.nonce}`,
    when: `${x.at !== null ? when(x.at) : `V3 #${num(x.block)}`} · read live`,
    amount: toTokens(x.amount),
    to: x.recipient,
    source: "chain",
    lockTx: x.tx,
    lockBlock: x.block,
    mint: x.mint ? { tx: x.mint.tx, block: x.mint.block, gas: x.mint.gasUsed } : null,
    beyond: x.mintBeyond,
    // The mint's receipt read: a HeaderImported of its block in it is importAndMint's; none, mint(p)'s.
    held: x.mint && x.mint.gasUsed !== null ? x.mint.final.block === null : null,
    relayed: [],
    facts: {
      finalBlock: f?.block ?? null,
      finalHash: f?.hash ?? null,
      setId: f?.setId ?? null,
      signatures: f?.signatures ?? null,
      authorities,
      commitment: x.commitment,
      nonce: x.nonce,
    },
    timing: null,
    note: null,
  };
}

function chainBurnReceipt(x: ChainBurn): BackReceipt {
  const d = destOf(x.dest);
  return {
    dir: "back",
    dest: x.dest,
    label: d.key === "sepolia" ? `Burn ${x.n}` : `Burn ${x.n} on ${d.short}`,
    when: `${x.at !== null ? when(x.at) : `${d.short} #${num(x.block)}`} · read live`,
    amount: toTokens(x.amount),
    to: x.payee,
    source: "chain",
    // Above the fast cap the watcher waits for finality; up to it, fast or not is its record, not the chain's.
    speed: toTokens(x.amount) > FAST_CAP ? "std" : null,
    fallback: false,
    burnTx: x.tx,
    burnBlock: x.block,
    burnId: x.burnId,
    open: null,
    run: null,
    fast: null,
    std: null,
  };
}

// ---------------------------------------------------------------------------------------------
// The page

const Tick = ({ trust = false }: { trust?: boolean }) => (
  <span class={`tick${trust ? " tick--trust" : ""}`} aria-hidden="true">
    <svg viewBox="0 0 52 52">
      <circle class="tick__ring" cx="26" cy="26" r="24" />
      <path class="tick__path" d="M15 27l7.5 7.5L38 19" />
    </svg>
  </span>
);

/** A headline time: seconds, or about so many minutes. */
function Big({ s }: { s: number }) {
  if (s < 120) {
    return (
      <span class="rc__big">
        {Math.round(s)}
        <span class="unit">s</span>
      </span>
    );
  }
  return (
    <span class="rc__big">
      <span class="rc__approx">≈</span>
      {Math.round(s / 60)}
      <span class="unit">min</span>
    </span>
  );
}

/**
 * A row's chain and where on it ("#323,534,868"). On small phones a rollup is named by its chain
 * button's first word, as the route is: "Arbitrum Sepolia #…" beside a transaction does not fit.
 */
function ChainAt({ d, at }: { d: Dest; at: string }) {
  if (d.key === "sepolia") return <>{`${d.short} ${at}`}</>;
  return (
    <>
      <span class="rc__wide">{`${d.short} ${at}`}</span>
      <span class="rc__tight">{`${d.name} ${at}`}</span>
    </>
  );
}

function InMain({ m, whose }: { m: InReceipt; whose: string }) {
  const t = m.timing;
  const d = destOf(m.dest);
  // A transfer this tab followed draws its bar from its own times; the recorded run's are the stylesheet's.
  const grow = (i: number) => (m.source === "tab" && t ? String(t.parts[i] ?? 0) : null);
  return (
    <>
      <div class="rc__hero">
        <Tick />
        <h1 class="rc__title" id="rc-title">
          {fmt(m.amount)} wtPOT <span class="rc__soft">arrived on {d.short}</span>
        </h1>
        <p class="rc__sub">
          <span>
            {m.label} · {m.when}
          </span>
          <Chip kind="verified" cls="badge--sm" icon="i-shield-check">
            Verified
          </Chip>
        </p>
      </div>
      {t ? (
        <div class="rc__time">
          <div class="rc__timehead">
            <Big s={t.total} />
            <span class="rc__timetext">from sending the lock to the mint's receipt</span>
          </div>
          <div class="segbar" aria-hidden="true">
            {[1, 2, 3, 4].map((n, i) => (
              <CssSpan key={n} cls={`segbar__s segbar__s--${n}`} prop="flex-grow" value={grow(i)} />
            ))}
          </div>
          <dl class="segkeys">
            {(["Lock", "Finality", "Proofs", "Mint"] as const).map((k, i) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{dur(t.parts[i] ?? 0)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : m.note ? (
        <p class="notice">
          <Icon id="i-info" />
          <span>{m.note}</span>
        </p>
      ) : null}
      <dl class="rc__rows">
        <div class="kv">
          <dt class="kv__k">Route</dt>
          <dd class="kv__v rc__route">
            <span class="pairmark pairmark--sm" aria-hidden="true">
              <ChainMark mark="portaldot" cls="mark--20" />
              <ChainMark mark={d.mark} cls="mark--20" />
            </span>
            {d.key === "sepolia" ? (
              `Portaldot V3 → ${d.short}`
            ) : (
              <>
                <span class="rc__wide">Portaldot V3 → {d.short}</span>
                <span class="rc__tight">V3 → {d.name}</span>
              </>
            )}
          </dd>
        </div>
        <div class="kv">
          <dt class="kv__k">Recipient</dt>
          <dd class="kv__v">
            <span class="mono">{short(checksum(m.to))}</span> <span class="kv__note">· {whose}</span>
          </dd>
        </div>
        <div class="kv">
          <dt class="kv__k kv__stack">
            Lock<span class="kv__small">V3 #{num(m.lockBlock)}</span>
          </dt>
          <dd class="kv__v">
            <Addr full={m.lockTx} href={nodeConsoleBlock(m.lockBlock)} label="lock transaction" cls="addr--tx" />
          </dd>
        </div>
        {m.relayed.map((r, i) => (
          <div class="kv" key={r.tx}>
            <dt class="kv__k kv__stack">
              Set changes{m.relayed.length > 1 ? ` ${i + 1}` : ""}
              <span class="kv__small">{r.block ? <ChainAt d={d} at={`#${num(r.block)}`} /> : d.short}</span>
            </dt>
            <dd class="kv__v">
              <Addr full={r.tx} href={explorerTx(d, r.tx)} label="set changes imported" cls="addr--tx" />
            </dd>
          </div>
        ))}
        {m.mint ? (
          <>
            <div class="kv">
              <dt class="kv__k kv__stack">
                Mint<span class="kv__small">
                  <ChainAt d={d} at={`#${num(m.mint.block)}`} />
                </span>
              </dt>
              <dd class="kv__v">
                <Addr full={m.mint.tx} href={explorerTx(d, m.mint.tx)} label="mint transaction" cls="addr--tx" />
              </dd>
            </div>
            <div class="kv">
              <dt class="kv__k">Mint gas</dt>
              <dd class="kv__v">
                {m.mint.gas !== null ? <span class="mono">{num(m.mint.gas)}</span> : <span class="kv__note">could not read</span>}{" "}
                <span class="kv__note">· bridge fee none</span>
              </dd>
            </div>
          </>
        ) : m.beyond ? (
          <div class="kv">
            <dt class="kv__k">Mint</dt>
            <dd class="kv__v">
              <span class="mono">used({m.facts.nonce ?? ""})</span> <span class="kv__note">· true on {d.short}; its transaction is older than the nodes here search ·</span>{" "}
              <a class="text-link" href={`${explorerAddress(d, deployed(d).minter)}#events`} target="_blank" rel="noopener">
                {d.explorer.name}
              </a>
            </dd>
          </div>
        ) : (
          <div class="kv">
            <dt class="kv__k">Mint</dt>
            <dd class="kv__v">
              <span class="mono">used({m.facts.nonce ?? ""})</span> <span class="kv__note">· true on {d.short}; its transaction could not be read yet</span>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

function BackMain({ m, whose }: { m: BackReceipt; whose: string }) {
  const f = m.fast;
  const s = m.std;
  const tab = m.source === "tab";
  const d = destOf(m.dest);
  return (
    <>
      <div class="rc__hero rc__hero--trust">
        <Tick trust />
        <h1 class="rc__title" id="rc-title">
          {fmt(m.amount)} tPOT <span class="rc__soft">released on V3</span>
        </h1>
        <p class="rc__sub">
          <span>
            {m.label} · {m.when}
          </span>
          <Chip kind="trusted" cls="badge--sm" icon="i-users">
            Trusted · 2-of-3
          </Chip>
        </p>
      </div>
      {/* The coloured part of each bar is the headline's time; what comes before it is a neutral track. */}
      {f ? (
        <div class="rc__time">
          <div class="rc__timehead">
            <span class="rc__big">
              {Math.round(f.fromBlock)}
              <span class="unit">s</span>
            </span>
            <span class="rc__timetext">from the burn's {d.short} block to the release · Fast</span>
          </div>
          <div class="segbar segbar--trust segbar--fast" aria-hidden="true">
            <CssSpan cls="segbar__s segbar__s--1" prop="flex-grow" value={tab ? String(f.mined) : null} />
            <CssSpan cls="segbar__s segbar__s--3" prop="flex-grow" value={tab ? String(f.fromBlock) : null} />
          </div>
          <dl class="segkeys segkeys--fast">
            <div class="segkeys__pre">
              <dt>Burn mined</dt>
              <dd>{secs(f.mined)}</dd>
            </div>
            <div>
              <dt>Confirmations and release</dt>
              <dd>{secs(f.fromBlock)}</dd>
            </div>
            <div class="segkeys__end">
              <dt>From sending</dt>
              <dd>{secs(f.fromSend)}</dd>
            </div>
          </dl>
          <p class="rc__measure">
            <Icon id="i-check" cls="i--12" />
            <span>{f.measure}</span>
          </p>
        </div>
      ) : s ? (
        <div class="rc__time">
          <div class="rc__timehead">
            <Big s={s.total} />
            <span class="rc__timetext">from sending the burn to the release · {m.fallback ? "Standard (fallback)" : "Standard"}</span>
          </div>
          {s.split ? (
            <>
              <div class="segbar segbar--trust segbar--std" aria-hidden="true">
                <span class="segbar__s segbar__s--1" />
                <CssSpan cls="segbar__s segbar__s--2" prop="flex-grow" value={s.grow ? String(s.grow[0]) : null} />
                <CssSpan cls="segbar__s segbar__s--3" prop="flex-grow" value={s.grow ? String(s.grow[1]) : null} />
              </div>
              <dl class="segkeys segkeys--std">
                <div class="segkeys__pre">
                  <dt>Burn</dt>
                  <dd>mined</dd>
                </div>
                <div>
                  <dt>{d.short} finality</dt>
                  <dd>{s.split[0]}</dd>
                </div>
                <div>
                  <dt>Committee release</dt>
                  <dd>{s.split[1]}</dd>
                </div>
              </dl>
            </>
          ) : null}
          <p class="rc__measure">
            <Icon id="i-check" cls="i--12" />
            <span>{s.measure}</span>
          </p>
        </div>
      ) : null}
      <dl class="rc__rows">
        <div class="kv">
          <dt class="kv__k">Route</dt>
          <dd class="kv__v rc__route">
            <span class="pairmark pairmark--sm" aria-hidden="true">
              <ChainMark mark={d.mark} cls="mark--20" />
              <ChainMark mark="portaldot" cls="mark--20" />
            </span>
            {d.key === "sepolia" ? (
              `${d.short} → Portaldot V3`
            ) : (
              <>
                <span class="rc__wide">{d.short} → Portaldot V3</span>
                <span class="rc__tight">{d.name} → V3</span>
              </>
            )}
          </dd>
        </div>
        <div class="kv">
          <dt class="kv__k">Paid to</dt>
          <dd class="kv__v">
            <span class="mono">{short(checksum(m.to))}</span> <span class="kv__note">· {whose}, on V3</span>
          </dd>
        </div>
        <div class="kv">
          <dt class="kv__k kv__stack">
            Burn<span class="kv__small">
              <ChainAt d={d} at={`#${num(m.burnBlock)}`} />
            </span>
          </dt>
          <dd class="kv__v">
            <Addr full={m.burnTx} href={explorerTx(d, m.burnTx)} label="burn transaction" cls="addr--tx" />
          </dd>
        </div>
        {m.burnId ? (
          <div class="kv">
            <dt class="kv__k">Burn id</dt>
            <dd class="kv__v">
              <Addr full={m.burnId} label="burn id" />
            </dd>
          </div>
        ) : null}
        {m.speed === "fast" && m.open ? (
          <div class="kv">
            <dt class="kv__k kv__stack">
              Opened<span class="kv__small">V3 #{num(m.open.block)}</span>
            </dt>
            <dd class="kv__v">
              <Addr full={m.open.tx} href={nodeConsoleBlock(m.open.block)} label="opening extrinsic" cls="addr--tx" />
            </dd>
          </div>
        ) : null}
        {m.run ? (
          <div class="kv">
            <dt class="kv__k kv__stack">
              Release<span class="kv__small">V3 #{num(m.run.block)}</span>
            </dt>
            <dd class="kv__v">
              <Addr full={m.run.tx} href={nodeConsoleBlock(m.run.block)} label="release extrinsic" cls="addr--tx" />
            </dd>
          </div>
        ) : (
          <div class="kv">
            <dt class="kv__k">Release</dt>
            <dd class="kv__v">
              <span class="mono">released(burnId)</span> <span class="kv__note">· true on V3, read live</span>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

function ReceiptScreen({ m, me }: { m: Receipt; me: string | null }) {
  const d = destOf(m.dest);
  const from = fromOf(m.dir, m.dest);
  const to = toOf(m.dir, m.dest);
  // "You" only for a transfer this tab sent, or when the address paid is the connected wallet's. A
  // recorded run paid the project's test address; a lock or a burn read from the chains, its own recipient.
  const mine = me !== null && me.toLowerCase() === m.to.toLowerCase();
  const whose = mine
    ? "you"
    : m.given
      ? "the address you gave"
      : m.source === "tab"
        ? "you"
        : m.source === "chain"
          ? `the ${m.dir === "in" ? "lock" : "burn"}'s recipient`
          : "the project's test address";
  return (
    <div class="stage stage--tx" data-dir={m.dir}>
      <section class="intro intro--tx" aria-label={m.dir === "in" ? "What was checked" : "What was trusted"}>
        <a class="back-link" href="#/activity">
          <Icon id="i-arrow-left" cls="i--16" />
          Activity
        </a>
        <p class="intro__eyebrow">
          <span class="intro__dot" aria-hidden="true" />
          {/* On a phone the time wraps onto its own line, the dot ending the first. */}
          <span>
            <Nb>{m.label} ·</Nb> <Nb>{m.when}</Nb>
          </span>
        </p>
        <p class="intro__title intro__title--tx">
          {fmt(m.amount)} {from.token} <span class="intro__arrow" aria-hidden="true">→</span>
          <span class="visually-hidden"> to </span> {to.short}
        </p>
        <div class="side">
          {m.dir === "in" ? (
            <ChecksPanel states={ALL_PASSED} receipt facts={m.facts} held={m.held} chain={d.short} />
          ) : (
            <TrustPanel speed={m.speed} fallback={m.fallback} members={null} d={d} />
          )}
        </div>
      </section>
      <section class="card card--lit rccard" aria-labelledby="rc-title">
        {m.dir === "in" ? <InMain m={m} whose={whose} /> : <BackMain m={m} whose={whose} />}
        <div class="rc__actions">
          <a class="btn btn--primary btn--lg btn--block" href={`#/bridge/${m.dir}${m.dest === "sepolia" ? "" : `?dest=${m.dest}`}`}>
            New transfer
          </a>
          <div class="rc__secondary">
            {m.dir === "in" ? (
              // The route above names the chain; a longer label would not fit its half of the row.
              <button class="btn btn--secondary" type="button" title={`Add wtPOT on ${d.short} to your wallet`} onClick={() => void addWtpotToWallet(m.dest)}>
                <Icon id="i-plus" />
                Add wtPOT to wallet
              </button>
            ) : (
              <a class="btn btn--secondary" href="#/network">
                <Icon id="i-users" />
                The committee
              </a>
            )}
            <a class="btn btn--secondary" href="#/activity">
              <Icon id="i-activity" />
              View in Activity
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Settled for a receipt: the mint read with its receipt, or minted by a transaction older than the
 * nodes search (not looked for again), or the release read either way. Not minted: the page is then
 * the transfer.
 */
const receiptSettled = (x: ChainTransfer): boolean =>
  x.dir === "in" ? x.minted === false || (x.mint !== null && x.mint.gasUsed !== null) || x.mintBeyond : x.released !== null;

/** The receipt of a lock or a burn read from the chains: read again every 15 s until what it shows has settled. */
function ChainReceipt({ id, me }: { id: string; me: string | null }) {
  const read = useChainRead(id, receiptSettled);
  const set = useField("set.v3");
  if (read.state === "none") return <NotFound what="receipt" id={id} />;
  if (read.state !== "live") return <ChainWait id={id} read={read} />;
  const x = read.value;
  // Not minted or not released, or not known to be: its page is the transfer, which says which.
  if (x.dir === "in" ? x.minted !== true : x.released !== true) return <Redirect to={`#/tx/${id}`} />;
  if (x.dir === "back") return <ReceiptScreen m={chainBurnReceipt(x)} me={me} />;
  // How many keys the signing set has: the light client's set read, when it is the set that signed.
  const setId = x.mint?.final.setId ?? null;
  const keys = setId !== null && set.value?.setId === BigInt(setId) ? set.value.keys.length : null;
  return <ReceiptScreen m={chainLockReceipt(x, keys)} me={me} />;
}

export function ReceiptView({ route }: { route: Route }) {
  const id = route.parts[1] ?? "";
  const live = useBox(transfers).get(id);
  const me = useBox(wallet).address;
  if (live) {
    // Not done yet: its page is the transfer.
    if (!isDone(live)) return <Redirect to={`#/tx/${id}`} />;
    const m = liveReceipt(live);
    return m ? <ReceiptScreen m={m} me={me} /> : <NotFound what="receipt" id={id} />;
  }
  // A lock or a burn this browser followed: its receipt is the live one, with its own times.
  const follower = followerOf(id);
  if (follower) return <Redirect to={`#/receipt/${follower.id}`} />;
  const m = recordedReceipt(id, route.q.get("speed"));
  if (m) return <ReceiptScreen m={m} me={me} />;
  // Any other lock or burn is read from its chain: Activity lists a connected wallet's own.
  if (nonceOf(id)) return <ChainReceipt key={id} id={id} me={me} />;
  return <NotFound what="receipt" id={id} />;
}
