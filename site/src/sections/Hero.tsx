import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArrowDown, ArrowRight, Check, Cross, Replay } from "../components/icons.tsx";
import { TransferLeg } from "../components/transfer.tsx";
import { Chain, ExtLink, Hash, reducedMotion, StatusBadge, Ticker } from "../components/ui.tsx";
import {
  DECIMALS,
  etherscanAddress,
  etherscanBlock,
  etherscanTx,
  LC,
  MINTER,
  nodeConsoleBlock,
  portalscanBlock,
  records,
  REPO,
  repoFile,
  TX_GAS_CAP,
  V3_CHAIN_ID,
  VAULT,
} from "../lib/chains.ts";
import { formatDay, formatDuration, formatInt, formatUnits, formatUtc, percent } from "../lib/format.ts";
import { useField, type ChainHead, type Field, type LcState } from "../lib/live.ts";
import { lockCommitment } from "../lib/proofs.ts";
import type { LatestRun, RelayEntry, RunStep } from "../lib/records-types.ts";

const amount = (units: string | bigint) => formatUnits(BigInt(units), DECIMALS);
/** "14:45:36", UTC */
const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);
/** A heading's anchor as GitHub writes it. */
const anchor = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
const NO_EXPLORER = "We found no indexed explorer for the V3 testnet: the Portaldot Node Console reads the V3 node";

// ---------------------------------------------------------------------------------------------
// The latest recorded transfer, as a card: from V3 to Sepolia, its measured steps, its links

const STEP_NAMES: Record<RunStep["key"], string> = { lock: "Lock", finality: "Finality", proofs: "Proofs", mint: "Mint" };

function stepNote(key: RunStep["key"], run: LatestRun): string {
  switch (key) {
    case "lock":
      return `V3 #${formatInt(run.lock.block)}`;
    case "finality":
      return `${run.bundle.signatures} of ${run.bundle.authorities}, set ${run.bundle.setId}`;
    case "proofs":
      return `read at #${formatInt(run.bundle.block.number)}`;
    case "mint":
      return `Sepolia #${formatInt(run.mint.block ?? 0)}`;
  }
}

/**
 * 0 to 1 over `ms`, once the element is in view, and again each time `replay` changes; straight
 * to 1 with reduced motion.
 */
function useProgressOnView(ms: number, replay: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  const seen = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion() || !("IntersectionObserver" in window)) {
      setP(1);
      return;
    }
    let raf = 0;
    const start = () => {
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        setP(k);
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    if (seen.current) {
      setP(0);
      start();
      return () => cancelAnimationFrame(raf);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          seen.current = true;
          start();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ms, replay]);
  return { ref, p };
}

/** The two blocks' timestamps, read again where the nodes answer: V3's Timestamp.set, Sepolia's blockTimestamp. */
function BlockStamps({ run }: { run: LatestRun }) {
  const v3 = useField("run.lockBlock");
  const rc = useField("run.receipt");
  const bt = run.timing?.blockTimes ?? null;
  const v3Live = v3.status === "live" && v3.value !== undefined;
  const rcTime = rc.status === "live" ? (rc.value?.blockTime ?? null) : null;
  const lockAt = v3Live ? v3.value!.at : bt ? Date.parse(bt.lock.at) : null;
  const mintAt = rcTime ?? (bt ? Date.parse(bt.mint.at) : null);
  if (lockAt === null || mintAt === null) return null;
  const secs = Math.round((mintAt - lockAt) / 1000);
  const loading = v3.status === "loading" || rc.status === "loading";
  const why = [v3Live ? "" : (v3.error ?? ""), rcTime !== null ? "" : rc.status === "live" ? "the receipt's logs carry no block time" : (rc.error ?? "")].filter(Boolean).join("; ");
  const field: Field<unknown> =
    v3Live && rcTime !== null
      ? { status: "live", value: true, endpoint: `${v3.endpoint} and ${rc.endpoint}`, at: Math.min(v3.at ?? Date.now(), rc.at ?? Date.now()) }
      : loading
        ? { status: "loading", value: true, from: run.timing?.from }
        : { status: "recorded", value: true, from: run.timing?.from, error: why || "no answer" };
  return (
    <p class="rtl__stamps">
      <span>
        Block stamps: the lock's V3 block <span class="num">{hms(lockAt)}</span> UTC, the mint's Sepolia block <span class="num">{hms(mintAt)}</span> (
        <span class="num">{secs}</span> s apart, inside the measured run). <StatusBadge field={field} compact />
      </span>
    </p>
  );
}

/** Where the measured intervals come from: the README's section when it states them, else the data file. */
function TimingSource({ t }: { t: NonNullable<LatestRun["timing"]> }) {
  return (
    <span class="rtl__src">
      measured by the tools, {formatDay(t.measuredOn)} ·{" "}
      {t.inReadme && t.readmeHeading ? (
        <a class="rtl__srclink" href={`${REPO}#${anchor(t.readmeHeading)}`} target="_blank" rel="noopener noreferrer">
          README, “{t.readmeHeading}”<span class="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <a class="rtl__srclink" href={repoFile(t.from)} target="_blank" rel="noopener noreferrer">
          {t.from}
          <span class="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </span>
  );
}

function RunTimeline({ run }: { run: LatestRun }) {
  const t = run.timing;
  const [replay, setReplay] = useState(0);
  // Ten times faster than it ran: 48 s plays in 4.8 s.
  const { ref, p } = useProgressOnView(t ? Math.max(2400, t.totalSeconds * 100) : 1200, replay);
  if (!t) {
    return (
      <div class="rtl" ref={ref}>
        <ol class="rtl__steps rtl__steps--plain">
          {(["lock", "finality", "proofs", "mint"] as const).map((k) => (
            <li key={k} class="is-done">
              <span class="rtl__name">{STEP_NAMES[k]}</span>
              <span class="rtl__note">{stepNote(k, run)}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  const total = t.totalSeconds;
  const elapsed = p * total;
  const label = `${t.steps.map((s) => `${STEP_NAMES[s.key]} ${s.seconds} s`).join(", ")}: ${total} s from sending the lock to the mint's receipt`;
  let acc = 0;
  const bounds = t.steps.map((s) => {
    const from = acc;
    acc += s.seconds;
    return { ...s, from, to: acc };
  });
  return (
    <div class="rtl" ref={ref}>
      <div class="rtl__head">
        <p class="rtl__total">
          <span class="rtl__secs num">
            {total}
            <span class="rtl__unit">s</span>
          </span>
          <span class="rtl__what">
            from sending the lock to the mint's receipt
            <TimingSource t={t} />
          </span>
        </p>
        <button type="button" class="rtl__replay" onClick={() => setReplay((n) => n + 1)} title="Play the timing again, ten times faster" aria-label="Play the timing again, ten times faster">
          <Replay />
        </button>
      </div>
      <div class="rtl__bar" role="img" aria-label={label}>
        {bounds.map((s) => (
          <span key={s.key} class={`rtl__seg rtl__seg--${s.key}`} style={{ flexGrow: s.seconds }}>
            <span class="rtl__segfill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, (elapsed - s.from) / s.seconds))})` }} />
          </span>
        ))}
      </div>
      <ol class="rtl__steps" style={{ gridTemplateColumns: bounds.map((s) => `minmax(0, ${s.seconds}fr)`).join(" ") }}>
        {bounds.map((s) => {
          const reached = elapsed >= s.to - 0.01;
          const active = elapsed > s.from && !reached;
          return (
            <li key={s.key} class={`${reached ? "is-done" : ""} ${active ? "is-active" : ""}`} title={s.what}>
              <span class="rtl__name">
                {STEP_NAMES[s.key]} <span class="rtl__sec num">{s.seconds} s</span>
              </span>
              <span class="rtl__note">{stepNote(s.key, run)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function CheckChip({ field, ok, name, value, title }: { field: Field<unknown>; ok: boolean | null; name: string; value: string; title: string }) {
  // A recorded value is shown as recorded, not as a check that passed: nothing was read again.
  const state = field.status === "recorded" || field.status === "error" ? "rec" : field.status === "loading" || ok === null ? "wait" : ok ? "ok" : "bad";
  const how =
    field.status === "live" ? `read live from ${field.endpoint ?? "the chain"}` : field.status === "recorded" ? `recorded (${field.from ?? "deployments/"}): the live read failed` : "reading…";
  return (
    <li class={`cchip cchip--${state} cchip--${field.status}`} title={`${title}. ${how}`}>
      <span class="cchip__icon" aria-hidden="true">
        {state === "ok" ? <Check /> : state === "bad" ? <Cross /> : state === "rec" ? <span class="cchip__rec" /> : <span class="cchip__wait" />}
      </span>
      <code class="cchip__name">{name}</code>
      <span class="cchip__value">{state === "rec" ? "recorded" : value}</span>
      <span class="sr-only">. {how}</span>
    </li>
  );
}

function RunCard({ run }: { run: LatestRun }) {
  const minter = useField("run.minter");
  const vault = useField("run.vault");
  const receipt = useField("run.receipt");
  const lockLog = useField("run.lock");
  const n = run.lock.nonce;
  const recomputed = useMemo(
    () =>
      lockCommitment({
        v3ChainId: V3_CHAIN_ID,
        vault: VAULT,
        dstChainId: BigInt(run.lock.dstChainId),
        minter: run.lock.dstMinter,
        recipient: run.lock.recipient,
        amountNative: BigInt(run.lock.amountNative),
        nonce: BigInt(n),
      }),
    [run, n],
  );
  const commitmentOk = vault.value ? vault.value.commitment === run.lock.commitment && recomputed === run.lock.commitment : null;
  const logOk = lockLog.value
    ? lockLog.value.txHash === run.lock.txHash && lockLog.value.commitment === run.lock.commitment && lockLog.value.amountNative === BigInt(run.lock.amountNative)
    : null;
  const fields = [minter, vault, receipt, lockLog];
  const live = fields.every((f) => f.status === "live");
  const loading = fields.some((f) => f.status === "loading");
  const none = fields.every((f) => f.status === "recorded" || f.status === "error");
  const worst = fields.find((f) => f.status === "error") ?? fields.find((f) => f.status === "recorded") ?? fields.find((f) => f.status === "loading") ?? receipt;
  const rows = run.lockRow && run.row ? `rows ${run.lockRow} and ${run.row}` : run.row ? `row ${run.row}` : null;
  return (
    <article class="runcard spot" aria-labelledby="runcard-title">
      <span class="runcard__edge" aria-hidden="true" />
      <header class="runcard__head">
        <span class="pill">
          <span class="pill__dot" />
          Recorded run
        </span>
        <time class="runcard__when" dateTime={run.lock.signedAt}>
          {formatUtc(run.lock.signedAt)}
        </time>
      </header>
      <div class="runcard__titles">
        <h2 class="runcard__title" id="runcard-title">
          Lock {n}, V3 testnet to Sepolia
        </h2>
        <p class="runcard__sub">A record of the run, read back from both chains. This page has no wallet and signs nothing.</p>
      </div>
      <p class="runcard__links">
        <span class="runcard__link">
          <span class="runcard__linkk">Mint tx</span>
          <Hash value={run.mint.txHash} href={etherscanTx(run.mint.txHash)} head={6} tail={4} label="mint transaction hash" />
        </span>
        <span class="runcard__link">
          <span class="runcard__linkk">Lock tx</span>
          <Hash value={run.lock.txHash} head={6} tail={4} label="lock transaction hash" />
        </span>
      </p>

      <div class="xfer">
        <TransferLeg
          dir="From"
          state="locked"
          chain="v3"
          net="Portaldot V3 testnet"
          contract="PortaldotVault"
          address={VAULT}
          value={amount(run.lock.amountNative)}
          unit="tPOT"
          where={
            <ExtLink href={nodeConsoleBlock(run.lock.block)} title={NO_EXPLORER}>
              block <span class="num">#{formatInt(run.lock.block)}</span>
            </ExtLink>
          }
        />
        <div class="transfer__via is-done">
          <span class="transfer__line" aria-hidden="true" />
          <span class="transfer__label">
            <ArrowDown />
            <span>
              one Sepolia transaction checked {run.bundle.signatures} of {run.bundle.authorities} validator signatures and the lock's proofs
            </span>
          </span>
        </div>
        <TransferLeg
          dir="To"
          state="minted"
          chain="sepolia"
          net="Ethereum Sepolia"
          contract="BridgeMinter"
          address={MINTER}
          value={amount(run.mint.amountNative)}
          unit="wtPOT"
          where={
            <ExtLink href={etherscanBlock(run.mint.block ?? 0)}>
              block <span class="num">#{formatInt(run.mint.block ?? 0)}</span>
            </ExtLink>
          }
        />
      </div>

      <RunTimeline run={run} />

      <div class="runcard__checks">
        <p class="runcard__checkhead">
          <span class="micro">{live ? "Read back just now" : loading ? "Reading back…" : none ? "Not read back: no node answered, recorded values" : "Read back where nodes answered"}</span>
          <StatusBadge field={worst} compact />
        </p>
        <ul class="cchips">
          <CheckChip
            field={lockLog}
            ok={logOk}
            name={`Locked(${n})`}
            value={logOk === null ? "…" : logOk ? "on V3" : "differs"}
            title={`The vault's Locked event for nonce ${n}, from the V3 EVM RPC: the same transaction, amount and commitment as the record`}
          />
          <CheckChip
            field={vault}
            ok={commitmentOk}
            name={`commitments(${n})`}
            value={commitmentOk === null ? "…" : commitmentOk ? "matches" : "differs"}
            title={`The vault's commitments(${n}) on V3, against lock ${n}'s commitment recomputed in this browser (${recomputed.slice(0, 10)}…)`}
          />
          <CheckChip
            field={minter}
            ok={minter.value ? minter.value.used : null}
            name={`used(${n})`}
            value={minter.value ? String(minter.value.used) : "…"}
            title={`BridgeMinter.used(${n}) on Sepolia: true once lock ${n} is minted; a second mint of it reverts`}
          />
          <CheckChip
            field={receipt}
            ok={receipt.value ? receipt.value.status === 1 : null}
            name="receipt"
            value={receipt.value ? (receipt.value.status === 1 ? "success" : "reverted") : "…"}
            title={`The mint's receipt on Sepolia${receipt.value?.events.length ? `: ${receipt.value.events.join(", ")}` : ""}`}
          />
        </ul>
      </div>

      <details class="runcard__more">
        <summary>
          <span>Run details</span>
          <span class="runcard__moresub">recipient, commitment, finality, gas{rows ? `, README ${rows}` : ""}</span>
        </summary>
        <dl class="runfacts">
          <div>
            <dt>Recipient</dt>
            <dd>
              <Hash value={run.mint.recipient} href={etherscanAddress(run.mint.recipient)} head={4} tail={4} label="recipient" />
              <span class="runfacts__note">named in the lock</span>
            </dd>
          </div>
          <div>
            <dt>Commitment</dt>
            <dd>
              <Hash value={run.lock.commitment} head={6} tail={4} label="the lock's commitment" />
              <span class="runfacts__note">commitments[{n}] on V3</span>
            </dd>
          </div>
          <div>
            <dt>Finality</dt>
            <dd>
              <span class="runfacts__v">
                <span class="num">{run.bundle.signatures}</span> of <span class="num">{run.bundle.authorities}</span>, set <span class="num">{run.bundle.setId}</span>
              </span>
              <span class="runfacts__note">
                V3 block{" "}
                <ExtLink href={nodeConsoleBlock(run.bundle.block.number)} title={NO_EXPLORER}>
                  <span class="num">#{formatInt(run.bundle.block.number)}</span>
                </ExtLink>
              </span>
            </dd>
          </div>
          <div>
            <dt>Gas</dt>
            <dd>
              <span class="runfacts__v num">{formatInt(run.mint.gasUsed ?? 0)}</span>
              <span class="runfacts__note" title={run.bound ? "This mint also bound the vault from its account entry" : "Lock 0's mint bound the vault, so this mint carried no account-entry proof"}>
                {percent(run.mint.gasUsed ?? 0, TX_GAS_CAP)} of the cap{run.bound ? ", with the bind" : ", no bind"}
              </span>
            </dd>
          </div>
        </dl>
        <BlockStamps run={run} />
        {rows ? (
          <p class="runcard__rows">
            Evidence {rows} of the{" "}
            <a class="link" href={`${REPO}#evidence`} target="_blank" rel="noopener noreferrer">
              README<span class="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </p>
        ) : null}
      </details>
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// Both light clients, live

function lagText(lc: LcState | undefined, head: ChainHead | undefined, blockTimeSec: number) {
  if (!lc || !head) return null;
  const blocks = Math.max(0, head.number - lc.latestNumber);
  const sets = head.setId !== null ? Number(head.setId - lc.setId) : null;
  return { blocks, time: formatDuration(blocks * blockTimeSec), sets };
}

/** A block of the chain a client follows: V3 blocks on the Node Console, old-mainnet blocks on its explorer. */
function ChainBlock({ which, n }: { which: "v3" | "mainnet"; n: number }) {
  return (
    <ExtLink href={which === "v3" ? nodeConsoleBlock(n) : portalscanBlock(n)} title={which === "v3" ? NO_EXPLORER : "The old mainnet's explorer"}>
      <span class="num">#{formatInt(n)}</span>
    </ExtLink>
  );
}

/** The Sepolia side of relayed imports: one transaction's link, or the span of blocks of several. */
function SepoliaSide({ entries }: { entries: RelayEntry[] }) {
  const blocks = entries.map((e) => e.sepoliaBlock).filter((b): b is number => b !== null);
  if (entries.length === 1 && entries[0]) {
    const e = entries[0];
    return (
      <span class="dim nowrap">
        (
        <ExtLink href={etherscanTx(e.txHash)} class="link-dim">
          Sepolia{e.sepoliaBlock !== null ? <span class="num"> #{formatInt(e.sepoliaBlock)}</span> : " tx"}
        </ExtLink>
        )
      </span>
    );
  }
  if (!blocks.length) return null;
  const lo = Math.min(...blocks);
  const hi = Math.max(...blocks);
  return (
    <span class="dim nowrap">
      (Sepolia <span class="num">#{formatInt(lo)}</span>
      {hi !== lo ? (
        <>
          {" "}
          to <span class="num">#{formatInt(hi)}</span>
        </>
      ) : null}
      )
    </span>
  );
}

function RelayLine({ which }: { which: "v3" | "mainnet" }) {
  const run = records.relayRuns[which];
  if (!run || !run.entries.length) return null;
  const changes = run.entries.filter((e) => e.setAfter !== e.setBefore);
  const head = run.entries.filter((e) => e.method === "importFinalityProof").at(-1) ?? null;
  const first = changes[0];
  const last = changes.at(-1);
  return (
    <div class="lcp__relay">
      <p class="micro">
        Relayer's last run{run.settledAt ? <span class="lcp__relaywhen"> · {formatUtc(run.settledAt)}</span> : null}
      </p>
      <ul class="lcp__relayv">
        {first && last ? (
          <li>
            set <span class="num">{first.setBefore}</span> → <span class="num">{last.setAfter}</span>{" "}
            {changes.length === 1 ? (
              <>
                at <ChainBlock which={which} n={first.block.number} />
              </>
            ) : (
              <>in {changes.length} changes</>
            )}{" "}
            <SepoliaSide entries={changes} />
          </li>
        ) : null}
        {head ? (
          <li>
            head <ChainBlock which={which} n={head.block.number} /> <SepoliaSide entries={[head]} />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** When the client's latest block is a mint's bundle block, the mint imported it, not the relayer. */
function importedBy(which: "v3" | "mainnet", hash: string | undefined): string | null {
  if (which !== "v3" || !hash) return null;
  const run = records.latestRun;
  if (run && run.bundle.block.hash === hash.toLowerCase()) return `by lock ${run.lock.nonce}'s mint`;
  if (records.bridge.finality.block.hash === hash.toLowerCase()) return "by lock 0's mint";
  return null;
}

function ClientPanel({ which }: { which: "v3" | "mainnet" }) {
  const facts = LC[which];
  const lc = useField(which === "v3" ? "lc.v3" : "lc.mainnet");
  const head = useField(which === "v3" ? "chain.v3" : "chain.mainnet");
  const lag = lagText(lc.value, head.value, facts.blockTimeSec);
  const n = facts.fixtureSet.keys.length;
  const by = importedBy(which, lc.value?.latestHash);
  return (
    <article class="lcp card spot" aria-labelledby={`lcp-${which}`}>
      <header class="lcp__head">
        <Chain which={which} />
        <StatusBadge field={lc} />
      </header>
      <p class="lcp__sub" id={`lcp-${which}`}>
        {facts.name} on Sepolia <Hash value={facts.address} href={etherscanAddress(facts.address)} label={`${facts.name} address`} head={4} tail={4} />
      </p>
      <div class="lcp__grid">
        <div class="lcp__cell">
          <span class="micro">Light client holds</span>
          <span class="lcp__big">
            #<Ticker value={lc.value?.latestNumber} />
          </span>
          <span class="lcp__set num">{lc.value ? `set ${lc.value.setId}${by ? ` · ${by}` : ""}` : " "}</span>
        </div>
        <div class="lcp__cell">
          <span class="micro">
            Chain finalized <StatusBadge field={head} compact />
          </span>
          <span class="lcp__big">
            {head.status === "error" ? (
              <span class="dim" aria-label="unknown">
                —
              </span>
            ) : (
              <>
                #<Ticker value={head.value?.number} />
              </>
            )}
          </span>
          <span class="lcp__set num">{head.value ? (head.value.setId !== null ? `set ${head.value.setId}` : "set unknown") : head.status === "error" ? "node unreachable" : " "}</span>
        </div>
      </div>
      <div class="lcp__lag" role="status">
        {lag ? (
          <>
            <span class="lcp__lagv">
              <span class="num">{formatInt(lag.blocks)}</span> blocks behind <span class="dim">≈ {lag.time}</span>
              {lc.status !== "live" ? <span class="lcp__lagnote">the client's side from the records</span> : null}
            </span>
            {lag.sets === null ? null : lag.sets <= 0 ? (
              <span class="badge badge--verify">same validator set</span>
            ) : (
              <span class="badge badge--brand">
                {lag.sets} set change{lag.sets === 1 ? "" : "s"} to import
              </span>
            )}
          </>
        ) : head.status === "error" ? (
          <span class="dim small">The {facts.chain} node did not answer: the lag is unknown.</span>
        ) : (
          <span class="skel" style={{ width: "16ch" }} aria-hidden="true" />
        )}
      </div>
      <footer class="lcp__foot">
        <span>
          <span class="num">{lc.value ? `${lc.value.threshold} of ${n}` : `${n}`}</span> signatures per import · <span class="dim">{facts.blockTimeSec} s blocks</span>
        </span>
        <RelayLine which={which} />
      </footer>
    </article>
  );
}

function Strip() {
  const sepolia = useField("sepolia.head");
  return (
    <div class="strip" aria-labelledby="strip-title">
      <div class="strip__head">
        <p class="strip__title">
          <span class="h3" id="strip-title">
            Both light clients, on Sepolia
          </span>
          <span class="small dim">
            {sepolia.status === "live"
              ? "read live, every 30 seconds"
              : sepolia.status === "loading"
                ? "reading the chains…"
                : "a Sepolia node did not answer: the records' latest imports are shown"}
          </span>
        </p>
        <p class="source">
          {sepolia.value !== undefined ? (
            <>
              Sepolia #<span class="num">{formatInt(sepolia.value)}</span> · {sepolia.endpoint}
            </>
          ) : sepolia.status === "error" ? (
            "Sepolia RPC unreachable"
          ) : (
            "reading Sepolia…"
          )}
        </p>
      </div>
      <div class="strip__grid">
        <ClientPanel which="v3" />
        <ClientPanel which="mainnet" />
      </div>
      <p class="strip__note small dim">
        A light client holds what was imported into it. The relayer brings it to the chain's finalized head when it runs, a mint imports the block it proves, and anyone can
        send an import: each one carries the validators' signatures, checked on chain.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function Hero() {
  const run = records.latestRun;
  const committee = records.returnPath.committee;
  return (
    <section id="top" class="hero" aria-labelledby="hero-title">
      <div class="container">
        <div class={`hero__grid ${run ? "" : "hero__grid--solo"}`}>
          <div class="hero__intro">
            <h1 class="hero__title" id="hero-title">
              A Portaldot light client <br class="hero__br" />
              <span class="grad">on Ethereum</span>.
            </h1>
            <p class="hero__claim">No trusted relayer. Trust rests on the Portaldot validator set.</p>
            <p class="hero__lead">
              Contracts on Sepolia, Base Sepolia and Arbitrum Sepolia check Portaldot's GRANDPA finality and storage proofs. The light client's first app is a token bridge, tPOT to wtPOT and back.
            </p>
            <div class="hero__ctas">
              <a class="btn btn--primary" href="app/">
                Open the bridge app
                <ArrowRight />
              </a>
              <a class="btn btn--ghost" href="#bridge">
                See the proof
                <ArrowDown />
              </a>
              <a class="btn btn--ghost" href="#verify">
                Verify it yourself
                <ArrowRight />
              </a>
            </div>
          </div>
          <dl class="hero__trust" aria-label="What is checked on chain, and what is trusted">
            <div>
              <dt>
                <span class="badge badge--verify">
                  <Check /> verified
                </span>
              </dt>
              <dd>validator signatures, the header hash, storage proofs, the commitment, the nonce</dd>
            </div>
            <div>
              <dt>
                <span class="badge badge--trust">trusted</span>
              </dt>
              <dd>
                the validator set, each chain's sudo key, each light client's admin, and the {committee.threshold}-of-{committee.members.length} committee on the way back{" "}
                <span class="nowrap">
                  (
                  <a class="link" href="#trust">
                    the trust map
                  </a>
                  )
                </span>
              </dd>
            </div>
          </dl>
          {run && (
            <div class="hero__stage">
              <RunCard run={run} />
            </div>
          )}
        </div>
        <Strip />
      </div>
    </section>
  );
}
