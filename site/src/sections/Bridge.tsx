import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArrowDown, Check, Chevron, Lock, Play, Replay as ReplayIcon, Signature, Tree, Coins } from "../components/icons.tsx";
import { TransferLeg } from "../components/transfer.tsx";
import { Chain, ExtLink, Hash, SectionHead, SourceLine, StatusBadge, reducedMotion, When } from "../components/ui.tsx";
import { DECIMALS, etherscanAddress, etherscanBlock, etherscanTx, MINTER, nodeConsoleBlock, records, SEPOLIA_CHAIN_ID, TOKEN, TX_GAS_CAP, V3_CHAIN_ID, VAULT } from "../lib/chains.ts";
import { formatInt, formatUnits, percent } from "../lib/format.ts";
import { shortHex } from "../lib/hex.ts";
import { shortAddr } from "../lib/display.ts";
import { checkSignatures, useField, type SignatureCheck } from "../lib/live.ts";
import { childTrieKey, commitmentSlot, headerHash, lockCommitment } from "../lib/proofs.ts";

const B = records.bridge;
const LATEST = records.latestRun;
const LOCK = B.lock;
const FIN = B.finality;
const PROOFS = B.proofs;
const MINT = B.mint;

/** Lock 0's commitment, recomputed here from the lock's fields, as the vault computed it and as the minter does. */
const RECOMPUTED = lockCommitment({
  v3ChainId: V3_CHAIN_ID,
  vault: VAULT,
  dstChainId: BigInt(LOCK.dstChainId),
  minter: LOCK.dstMinter,
  recipient: LOCK.recipient,
  amountNative: BigInt(LOCK.amountNative),
  nonce: BigInt(LOCK.nonce),
});

const amount = (units: string | bigint) => formatUnits(BigInt(units), DECIMALS);
const hintPairs = () => {
  const out: { position: number; authorityIndex: number }[] = [];
  const h = FIN.signers.hint.slice(2);
  for (let i = 0; i < h.length; i += 4) out.push({ position: parseInt(h.slice(i, i + 2), 16), authorityIndex: parseInt(h.slice(i + 2, i + 4), 16) });
  return out;
};

interface StepDef {
  key: string;
  chain: "v3" | "sepolia";
  icon: ComponentChildren;
  title: string;
  summary: string;
  meta: ComponentChildren;
  checks: string[];
}

const STEPS: StepDef[] = [
  {
    key: "lock",
    chain: "v3",
    icon: <Lock />,
    title: "Lock on V3",
    summary: `${amount(LOCK.amountNative)} tPOT sent to PortaldotVault.lock, naming Sepolia, the minter and the recipient. The vault stores one commitment for the lock.`,
    meta: (
      <>
        block <span class="num">#{formatInt(LOCK.block.number)}</span> · nonce <span class="num">{LOCK.nonce}</span>
      </>
    ),
    checks: [`${amount(LOCK.amountNative)} tPOT received by the vault`, "commitment written to commitments[0]"],
  },
  {
    key: "finality",
    chain: "v3",
    icon: <Signature />,
    title: `Finality: ${FIN.signers.count} of ${FIN.authorities.length} signatures`,
    summary: `V3 block #${formatInt(FIN.block.number)}, whose state holds the lock's commitment, finalized by the validators of set ${FIN.setId}. The light client rebuilds the signed message on chain and checks each ed25519 signature against the key it stores.`,
    meta: (
      <>
        block <span class="num">#{formatInt(FIN.block.number)}</span> · set <span class="num">{FIN.setId}</span> · round <span class="num">{formatInt(FIN.round)}</span>
      </>
    ),
    checks: [
      ...hintPairs().map((p) => `signature of validator ${p.authorityIndex} (precommit ${p.position}): valid`),
      `${FIN.signers.count} of ${FIN.authorities.length}, threshold ${FIN.signers.threshold}: met`,
      "header hash = the block they signed",
    ],
  },
  {
    key: "proofs",
    chain: "v3",
    icon: <Tree />,
    title: "Three storage proofs",
    summary: "Under that block's state root: the vault's account entry, the root of its child trie, and commitments[0] inside that trie. Each is a trie walk that has to end at the root.",
    meta: (
      <>
        <span class="num">{PROOFS.account.items + PROOFS.childRoot.items + PROOFS.slot.items}</span> proof items ·{" "}
        <span class="num">{formatInt(PROOFS.account.bytes + PROOFS.childRoot.bytes + PROOFS.slot.bytes)}</span> bytes
      </>
    ),
    checks: ["account entry: a contract with the vault's code hash", "child-trie root, under the trie id", "commitments[0] holds the commitment"],
  },
  {
    key: "mint",
    chain: "sepolia",
    icon: <Coins />,
    title: "Mint on Sepolia",
    summary: "One importAndMint transaction does all of it: imports the block, binds the vault, proves the slot, recomputes the commitment, and mints to the recipient the commitment names.",
    meta: (
      <>
        <span class="num">{formatInt(MINT.gasUsed ?? 0)}</span> gas · <span class="num">{percent(MINT.gasUsed ?? 0, TX_GAS_CAP)}</span> of the cap
      </>
    ),
    checks: ["commitment recomputed by the minter: equal", "nonce 0 not used yet: marked used", `${amount(MINT.amountNative)} wtPOT minted to ${shortAddr(MINT.recipient)}`],
  },
];

// ---------------------------------------------------------------------------------------------
// Replay: walks the steps of the recorded run

interface ReplayState {
  playing: boolean;
  /** The step being shown, 0 to 3; 4 when the run is complete; -1 before it starts. */
  stage: number;
  /** Checks shown so far, per step. */
  shown: number[];
}

const IDLE: ReplayState = { playing: false, stage: -1, shown: STEPS.map(() => 0) };
const DONE: ReplayState = { playing: false, stage: STEPS.length, shown: STEPS.map((s) => s.checks.length) };

function useReplay() {
  const [state, setState] = useState<ReplayState>(IDLE);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clear, []);
  const start = () => {
    clear();
    if (reducedMotion()) {
      setState(DONE);
      return;
    }
    let t = 0;
    const at = (ms: number, s: ReplayState) => timers.current.push(setTimeout(() => setState(s), ms));
    const shown = STEPS.map(() => 0);
    at(0, { playing: true, stage: 0, shown: [...shown] });
    STEPS.forEach((step, i) => {
      t += 520;
      for (let c = 0; c < step.checks.length; c++) {
        t += 430;
        shown[i] = c + 1;
        at(t, { playing: true, stage: i, shown: [...shown] });
      }
      t += 380;
      if (i < STEPS.length - 1) at(t, { playing: true, stage: i + 1, shown: [...shown] });
    });
    at(t + 200, { playing: false, stage: STEPS.length, shown: [...shown] });
  };
  const stop = () => {
    clear();
    setState(DONE);
  };
  return { state, start, stop };
}

// ---------------------------------------------------------------------------------------------
// Step details

function Row({ k, children }: { k: string; children: ComponentChildren }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function LockDetail() {
  const log = useField("v3.lock0");
  const vault = useField("v3.vault");
  const [shown, setShown] = useState(false);
  const live = vault.value?.commitment0;
  return (
    <div class="detail">
      <dl class="kv">
        <Row k="Transaction">
          <Hash value={LOCK.txHash} label="lock transaction hash" /> <span class="dim small">we found no indexed explorer for the V3 testnet</span>
        </Row>
        <Row k="Block">
          <ExtLink href={nodeConsoleBlock(LOCK.block.number)} title="The Portaldot Node Console reads the V3 node directly">
            <span class="num">#{formatInt(LOCK.block.number)}</span>
          </ExtLink>{" "}
          <Hash value={LOCK.block.hash} label="EVM block hash" head={6} tail={6} /> <span class="dim small">the hash the V3 EVM RPC gives the block; the Node Console shows its Substrate hash</span>
        </Row>
        <Row k="Call">
          <code class="inline">
            lock({LOCK.dstChainId}, {shortAddr(LOCK.dstMinter)}, {shortAddr(LOCK.recipient)})
          </code>{" "}
          <span class="dim small">with {amount(LOCK.amountNative)} tPOT</span>
        </Row>
        <Row k="Amount">
          <span class="num">{formatInt(BigInt(LOCK.amountNative))}</span> base units <span class="dim">(14 decimals: {amount(LOCK.amountNative)} tPOT)</span>
        </Row>
        <Row k="Signed">
          <When iso={LOCK.signedAt} />
        </Row>
        <Row k="Cost on V3">
          <span class="num">{formatUnits(BigInt(LOCK.cost), 18, 4)}</span> tPOT <span class="dim small">the storage deposit for the vault's new storage items, and the fee</span>
        </Row>
        <Row k="Commitment">
          <Hash value={LOCK.commitment} label="commitment" />
        </Row>
      </dl>
      <pre class="formula" aria-label="How the commitment is computed">
        <code>
          {`commitment = keccak256(abi.encode(
  keccak256("BridgeZero.Lock.v1"), ${V3_CHAIN_ID}, vault,
  ${SEPOLIA_CHAIN_ID}, minter, recipient, amountNative, nonce))`}
        </code>
      </pre>
      <div class="detail__actions">
        <button type="button" class="btn btn--ghost btn--sm" onClick={() => setShown(true)} aria-expanded={shown}>
          <Check />
          Recompute it in this browser
        </button>
      </div>
      {shown && (
        <ul class="checks" aria-live="polite">
          <li class={RECOMPUTED === LOCK.commitment ? "is-ok" : "is-bad"}>
            {RECOMPUTED === LOCK.commitment ? <Check /> : <span class="x">×</span>}
            <span>
              keccak-256 here gives <Hash value={RECOMPUTED} copy={false} /> {RECOMPUTED === LOCK.commitment ? "= the lock's recorded commitment" : "≠ the recorded commitment"}
            </span>
          </li>
          <li class={live ? (live === RECOMPUTED ? "is-ok" : "is-bad") : "is-wait"}>
            {live === RECOMPUTED ? <Check /> : <span class="x">{live ? "×" : "…"}</span>}
            <span>
              {live ? (
                <>
                  the vault's <code class="inline">commitments(0)</code> on V3 is <Hash value={live} copy={false} /> ({vault.status === "live" ? "read live" : "recorded"}):{" "}
                  {live === RECOMPUTED ? "equal" : "different"}
                </>
              ) : (
                "reading commitments(0) from the vault…"
              )}
            </span>
          </li>
        </ul>
      )}
      <div class="detail__live">
        <p class="micro">
          The vault's Locked event <StatusBadge field={log} />
        </p>
        {log.value ? (
          <p class="small muted">
            nonce <span class="num">{String(log.value.nonce)}</span> · {amount(log.value.amountNative)} tPOT for <Hash value={log.value.recipient} copy={false} head={4} tail={4} /> on chain{" "}
            <span class="num">{String(log.value.dstChainId)}</span> via <Hash value={log.value.dstMinter} copy={false} head={4} tail={4} /> · block{" "}
            <span class="num">#{formatInt(log.value.blockNumber)}</span>
          </p>
        ) : null}
        <SourceLine field={log} live="eth_getLogs on the vault" />
      </div>
    </div>
  );
}

function FinalityDetail() {
  const [sigs, setSigs] = useState<SignatureCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [hashShown, setHashShown] = useState(false);
  const computedHash = useMemo(() => (hashShown ? headerHash(FIN.block.scale) : null), [hashShown]);
  const pairs = hintPairs();
  const verify = async () => {
    setBusy(true);
    try {
      const counted = pairs.map((p) => {
        const pc = FIN.precommits[p.position]!;
        return { position: p.position, authorityIndex: p.authorityIndex, id: pc.authorityId, signature: pc.signature, targetHash: pc.targetHash, targetNumber: pc.targetNumber };
      });
      setSigs(await checkSignatures(counted, FIN.authorities, BigInt(FIN.round), BigInt(FIN.setId)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="detail">
      <dl class="kv">
        <Row k="Block">
          <ExtLink href={nodeConsoleBlock(FIN.block.number)}>
            <span class="num">#{formatInt(FIN.block.number)}</span>
          </ExtLink>{" "}
          <Hash value={FIN.block.hash} label="block hash" />
        </Row>
        <Row k="State root">
          <Hash value={FIN.block.stateRoot} label="state root" />
        </Row>
        <Row k="Validator set">
          set <span class="num">{FIN.setId}</span>, <span class="num">{FIN.authorities.length}</span> keys, threshold <span class="num">{FIN.signers.threshold}</span> (N − ⌊(N − 1) / 3⌋)
        </Row>
        <Row k="Signers hint">
          <code class="inline">{FIN.signers.hint}</code> <span class="dim small">2 bytes per counted precommit: its position, then the validator's index</span>
        </Row>
      </dl>
      <div class="sigtable" role="table" aria-label="The precommits the mint counted">
        <div class="sigtable__row sigtable__row--head" role="row">
          <span role="columnheader">Precommit</span>
          <span role="columnheader">Validator</span>
          <span role="columnheader">Key</span>
          <span role="columnheader">Signature</span>
          <span role="columnheader">In this browser</span>
        </div>
        {pairs.map((p, i) => {
          const pc = FIN.precommits[p.position]!;
          const res = sigs?.[i];
          return (
            <div class="sigtable__row" role="row" key={p.position}>
              <span role="cell" class="num">
                {p.position}
              </span>
              <span role="cell" class="num">
                {p.authorityIndex}
              </span>
              <span role="cell">
                <Hash value={pc.authorityId} head={6} tail={4} label="validator key" />
              </span>
              <span role="cell">
                <Hash value={pc.signature} head={6} tail={4} label="signature" />
              </span>
              <span role="cell">
                {res ? (
                  res.valid && res.keyMatches ? (
                    <span class="badge badge--verify">
                      <Check /> valid
                    </span>
                  ) : (
                    <span class="badge badge--revert">invalid</span>
                  )
                ) : (
                  <span class="dim small">not checked</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <pre class="formula" aria-label="The message each precommit signs">
        <code>{`signed message = 0x01 ‖ target hash ‖ u32le(${FIN.block.number}) ‖ u64le(round ${FIN.round}) ‖ u64le(set ${FIN.setId})   53 bytes`}</code>
      </pre>
      <div class="detail__actions">
        <button type="button" class="btn btn--ghost btn--sm" onClick={verify} disabled={busy} aria-busy={busy}>
          <Signature />
          {busy ? "Checking…" : sigs ? "Check again" : `Check the ${pairs.length} signatures in this browser`}
        </button>
        <button type="button" class="btn btn--ghost btn--sm" onClick={() => setHashShown(true)}>
          <Check />
          Hash the header
        </button>
      </div>
      {hashShown && computedHash && (
        <ul class="checks" aria-live="polite">
          <li class={computedHash === FIN.block.hash ? "is-ok" : "is-bad"}>
            {computedHash === FIN.block.hash ? <Check /> : <span class="x">×</span>}
            <span>
              blake2b-256 of the {FIN.block.headerBytes}-byte header is <Hash value={computedHash} copy={false} />: {computedHash === FIN.block.hash ? "the block hash the validators signed" : "not the signed hash"}
            </span>
          </li>
        </ul>
      )}
      {sigs && (
        <p class="small muted" aria-live="polite">
          ed25519 (@noble/curves) in this browser, on the recorded bundle: {sigs.filter((s) => s.valid && s.keyMatches).length} of {sigs.length} valid under set{" "}
          {FIN.setId}'s keys.
        </p>
      )}
      <p class="source">
        recorded · {B.bundleFile} · captured <When iso={FIN.capturedAt} />
      </p>
    </div>
  );
}

function ProofsDetail() {
  const [shown, setShown] = useState(false);
  const slot = commitmentSlot(0n);
  const key = childTrieKey(0n);
  const rows = [
    { name: "Account entry", trie: "main trie", key: "twox128(Revive) ++ twox128(AccountInfoOf) ++ vault", bytes: PROOFS.account.keyBytes, value: `the vault's AccountInfo, ${PROOFS.account.valueBytes} bytes`, items: PROOFS.account.items, size: PROOFS.account.bytes },
    { name: "Child root", trie: "main trie", key: ":child_storage:default: ++ trie id", bytes: PROOFS.childRoot.keyBytes, value: `the child trie's root ${shortHex(PROOFS.childRoot.root, 4, 4)}`, items: PROOFS.childRoot.items, size: PROOFS.childRoot.bytes },
    { name: "Slot", trie: "the vault's child trie", key: "blake2_256(keccak256(abi.encode(0, 0)))", bytes: 32, value: `commitments[0] = ${shortHex(PROOFS.slot.value, 4, 4)}`, items: PROOFS.slot.items, size: PROOFS.slot.bytes },
  ];
  return (
    <div class="detail">
      <div class="prooftable" role="table" aria-label="The three storage proofs">
        {rows.map((r) => (
          <div class="prooftable__row" role="row" key={r.name}>
            <div role="cell" class="prooftable__name">
              <span class="h4">{r.name}</span>
              <span class="dim small">{r.trie}</span>
            </div>
            <div role="cell" class="prooftable__key">
              <code class="inline">{r.key}</code>
              <span class="dim small">{r.bytes}-byte key</span>
            </div>
            <div role="cell" class="prooftable__val small">{r.value}</div>
            <div role="cell" class="prooftable__n num small">
              {r.items} items · {formatInt(r.size)} B
            </div>
          </div>
        ))}
      </div>
      <dl class="kv">
        <Row k="Trie id">
          <Hash value={PROOFS.account.trieId} label="trie id" />
        </Row>
        <Row k="Code hash">
          <Hash value={PROOFS.account.codeHash} label="code hash" /> <span class="dim small">keccak-256 of the vault's {B.vault.runtimeBytes} bytes of code</span>
        </Row>
        <Row k="Bound">once, by the first mint: later mints carry the child-root and slot proofs only</Row>
      </dl>
      <div class="detail__actions">
        <button type="button" class="btn btn--ghost btn--sm" onClick={() => setShown(true)}>
          <Check />
          Derive the slot key in this browser
        </button>
      </div>
      {shown && (
        <ul class="checks" aria-live="polite">
          <li class={slot === PROOFS.slot.index ? "is-ok" : "is-bad"}>
            {slot === PROOFS.slot.index ? <Check /> : <span class="x">×</span>}
            <span>
              keccak256(abi.encode(0, 0)) = <Hash value={slot} copy={false} />, the EVM slot of commitments[0]
            </span>
          </li>
          <li class={key === PROOFS.slot.key ? "is-ok" : "is-bad"}>
            {key === PROOFS.slot.key ? <Check /> : <span class="x">×</span>}
            <span>
              blake2_256 of it = <Hash value={key} copy={false} />, {key === PROOFS.slot.key ? "the key the slot proof walks to" : "not the proof's key"}
            </span>
          </li>
        </ul>
      )}
      <p class="source">recorded · {B.bundleFile}</p>
    </div>
  );
}

function MintDetail() {
  return (
    <div class="detail">
      <dl class="kv">
        <Row k="Transaction">
          <Hash value={MINT.txHash} href={etherscanTx(MINT.txHash)} label="mint transaction hash" />
        </Row>
        <Row k="Block">
          <ExtLink href={etherscanBlock(MINT.block ?? 0)}>
            <span class="num">#{formatInt(MINT.block ?? 0)}</span>
          </ExtLink>{" "}
          {MINT.signedAt && (
            <span class="dim small">
              signed <When iso={MINT.signedAt} />
            </span>
          )}
        </Row>
        <Row k="Gas">
          <span class="num">{formatInt(MINT.gasUsed ?? 0)}</span> <span class="dim small">{percent(MINT.gasUsed ?? 0, TX_GAS_CAP)} of Sepolia's 16,777,216 cap · {MINT.effectiveGasPrice} wei per gas</span>
        </Row>
        <Row k="Sender">
          <Hash value={MINT.sender} href={etherscanAddress(MINT.sender)} head={4} tail={4} label="sender" /> <span class="dim small">anyone can send it; nothing is taken from the sender</span>
        </Row>
        <Row k="Minted">
          {amount(MINT.amountNative)} wtPOT to <Hash value={MINT.recipient} href={etherscanAddress(MINT.recipient)} head={4} tail={4} label="recipient" />
        </Row>
        <Row k="Evidence">
          row <span class="num">{B.row}</span> of the README's evidence table · <a class="link" href="#receipt">the receipt, decoded</a>
        </Row>
      </dl>
    </div>
  );
}

const DETAILS = [LockDetail, FinalityDetail, ProofsDetail, MintDetail];

// ---------------------------------------------------------------------------------------------

function Step({ i, open, onToggle, replay }: { i: number; open: boolean; onToggle: () => void; replay: ReplayState }) {
  const s = STEPS[i]!;
  const Detail = DETAILS[i]!;
  const state = replay.stage < 0 ? "idle" : replay.stage === i ? "active" : replay.stage > i ? "done" : "todo";
  const shown = replay.shown[i] ?? 0;
  return (
    <li class={`step step--${state}`}>
      <div class="step__rail" aria-hidden="true">
        <span class="step__node">{state === "done" ? <Check /> : <span class="num">{i + 1}</span>}</span>
        {i < STEPS.length - 1 && <span class="step__line" />}
      </div>
      <div class="step__card card spot">
        <button type="button" class="step__head" aria-expanded={open} aria-controls={`step-${s.key}`} onClick={onToggle}>
          <span class="step__icon">{s.icon}</span>
          <span class="step__titles">
            <span class="step__chain">
              <Chain which={s.chain} small />
            </span>
            <span class="h3 step__title">{s.title}</span>
            <span class="step__summary">{s.summary}</span>
            <span class="step__meta small dim">{s.meta}</span>
          </span>
          <Chevron class="step__chev" />
        </button>
        {replay.stage >= 0 && shown > 0 && (
          <ul class="step__checks" aria-live="polite">
            {s.checks.slice(0, shown).map((c) => (
              <li key={c}>
                <Check />
                {c}
              </li>
            ))}
          </ul>
        )}
        <div id={`step-${s.key}`} class="step__detail" hidden={!open}>
          {open && <Detail />}
        </div>
      </div>
    </li>
  );
}

function Ledger() {
  const vault = useField("v3.vault");
  const minter = useField("sepolia.minter");
  const token = useField("sepolia.token");
  const c0 = vault.value?.commitment0;
  const rows = (
    entries: { k: string; v: ComponentChildren; note: ComponentChildren }[],
  ) =>
    entries.map((e) => (
      <div class="ledger__row" key={e.k}>
        <dt>
          <code class="inline">{e.k}</code>
        </dt>
        <dd>
          <span class="ledger__v">{e.v}</span>
          <span class="ledger__note">{e.note}</span>
        </dd>
      </div>
    ));
  const sk = <span class="skel" style={{ width: "10ch" }} aria-hidden="true" />;
  return (
    <div class="ledger">
      <section class="ledger__col card" aria-label="State on the Portaldot V3 testnet">
        <header class="ledger__head">
          <Chain which="v3">PortaldotVault on V3</Chain>
          <StatusBadge field={vault} />
        </header>
        <dl>
          {rows([
            {
              k: "outstanding()",
              v: vault.value ? <span class="num">{amount(vault.value.outstanding)} tPOT</span> : sk,
              note: "locked and not released",
            },
            {
              k: "commitments(0)",
              v: c0 ? <Hash value={c0} head={6} tail={6} label="commitments(0)" /> : sk,
              note:
                c0 && vault.status === "live" ? (
                c0 === RECOMPUTED ? (
                  <span class="ok-text">
                    <Check /> lock 0's commitment, recomputed in this browser
                  </span>
                ) : (
                  <span class="bad-text">differs from the recomputed commitment</span>
                )
              ) : (
                "lock 0's commitment"
              ),
            },
            {
              k: "slot 1 (nextNonce)",
              v: vault.value ? <span class="num">{String(vault.value.nextNonce)}</span> : sk,
              note: "locks so far, the next lock's nonce",
            },
          ])}
        </dl>
        <SourceLine field={vault} live="V3 EVM RPC" />
      </section>
      <section class="ledger__col card" aria-label="State on Sepolia">
        <header class="ledger__head">
          <Chain which="sepolia">BridgeMinter and wtPOT</Chain>
          <StatusBadge field={minter.status !== "live" ? minter : token} />
        </header>
        <dl>
          {rows([
            {
              k: "used(0)",
              v: minter.value ? <span class={`num ${minter.value.used0 ? "ok-text" : ""}`}>{String(minter.value.used0)}</span> : sk,
              note: "lock 0 minted; a copy reverts",
            },
            {
              k: "vaultTrieId()",
              v: minter.value ? <Hash value={minter.value.trieId} head={6} tail={6} label="vaultTrieId" /> : sk,
              note:
                minter.status === "live" && minter.value && minter.value.trieId === PROOFS.account.trieId ? (
                  <span class="ok-text">
                    <Check /> the trie id in the proven account entry
                  </span>
                ) : (
                  "bound from the proven account entry"
                ),
            },
            {
              k: "totalSupply()",
              v: token.value ? <span class="num">{amount(token.value.totalSupply)} wtPOT</span> : sk,
              note: <ExtLink href={etherscanAddress(TOKEN)}>WrappedTPOT, 14 decimals</ExtLink>,
            },
            {
              k: `balanceOf(${shortAddr(LOCK.recipient)})`,
              v: token.value ? <span class="num">{amount(token.value.recipientBalance)} wtPOT</span> : sk,
              note: LATEST && LATEST.mint.recipient === LOCK.recipient && LATEST.lock.nonce !== LOCK.nonce ? `the recipient of locks ${LOCK.nonce} and ${LATEST.lock.nonce}` : "lock 0's recipient",
            },
          ])}
        </dl>
        <SourceLine field={minter} live="eth_call" />
      </section>
      {vault.value && token.value && (
        <p class="ledger__sum small">
          <span class="num">{amount(token.value.totalSupply)}</span> wtPOT in circulation, <span class="num">{amount(vault.value.outstanding)}</span> tPOT outstanding in the vault. Every
          mint is a proven lock; releases are the committee's (trusted), so this is a reading, not a guarantee.
        </p>
      )}
    </div>
  );
}

export function Bridge() {
  const [open, setOpen] = useState<number | null>(null);
  const { state, start, stop } = useReplay();
  const minter = useField("sepolia.minter");
  const minted = state.stage >= STEPS.length || (state.stage < 0 && minter.value?.used0 === true);
  const stepsRef = useRef<HTMLOListElement>(null);
  // While the run replays, the step being shown stays on screen as its checks appear (on a phone the
  // steps are below the card).
  const shownNow = state.stage >= 0 && state.stage < STEPS.length ? (state.shown[state.stage] ?? 0) : 0;
  useEffect(() => {
    if (!state.playing || state.stage < 0 || state.stage >= STEPS.length) return;
    const li = stepsRef.current?.children[state.stage];
    if (li instanceof HTMLElement) li.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [state.playing, state.stage, shownNow]);
  return (
    <section id="bridge" class="section" aria-labelledby="bridge-title">
      <div class="container">
        <SectionHead
          id="bridge"
          n="01"
          eyebrow="The bridge, step by step"
          title={
            <>
              One lock, one proof, one mint. <em>No one reports the lock.</em>
            </>
          }
          lead={`Lock 0, the first proven mint (row ${B.row}): ${amount(LOCK.amountNative)} tPOT locked on the V3 testnet, minted as ${amount(MINT.amountNative)} wtPOT on Sepolia by one transaction that also bound the vault. The tampered copies below are copies of it.${LATEST && LATEST.lock.nonce !== LOCK.nonce ? ` Lock ${LATEST.lock.nonce}, above, took the same path without the bind.` : ""}`}
        />
        <div class="bridge reveal">
          <aside class="transfer card" aria-label="Lock 0">
            <header class="transfer__head">
              <span class="transfer__title">
                <span class="h3">Lock 0</span>
                <span class="dim small">tPOT → wtPOT</span>
              </span>
              {minted ? (
                <span class="badge badge--verify">
                  <Check /> minted
                </span>
              ) : (
                <span class="badge">{state.playing ? "replaying" : "locked"}</span>
              )}
            </header>
            <div class="xfer">
              <TransferLeg
                dir="From"
                state="locked"
                chain="v3"
                net="Portaldot V3 testnet"
                contract="PortaldotVault"
                address={VAULT}
                value={amount(LOCK.amountNative)}
                unit="tPOT"
                where={
                  <ExtLink href={nodeConsoleBlock(LOCK.block.number)} title="We found no indexed explorer for the V3 testnet: the Portaldot Node Console reads the V3 node">
                    block <span class="num">#{formatInt(LOCK.block.number)}</span>
                  </ExtLink>
                }
              />
              <div class={`transfer__via ${state.playing ? "is-playing" : ""} ${minted ? "is-done" : ""}`}>
                <span class="transfer__line" aria-hidden="true">
                  <span class="transfer__packet" />
                </span>
                <span class="transfer__label">
                  <ArrowDown />
                  one Sepolia transaction, {formatInt(MINT.gasUsed ?? 0)} gas: the proof, not a report
                </span>
              </div>
              <TransferLeg
                dir="To"
                state="minted"
                chain="sepolia"
                net="Ethereum Sepolia"
                contract="BridgeMinter"
                address={MINTER}
                value={amount(MINT.amountNative)}
                unit="wtPOT"
                where={
                  <ExtLink href={etherscanBlock(MINT.block ?? 0)}>
                    block <span class="num">#{formatInt(MINT.block ?? 0)}</span>
                  </ExtLink>
                }
              />
            </div>
            <dl class="kv transfer__kv">
              <Row k="Recipient">
                <Hash value={LOCK.recipient} href={etherscanAddress(LOCK.recipient)} head={4} tail={4} label="recipient" /> <span class="dim small">named in the lock, on Sepolia</span>
              </Row>
              <Row k="Token">
                <Hash value={TOKEN} href={etherscanAddress(TOKEN)} head={4} tail={4} label="wtPOT address" /> <span class="dim small">wtPOT, minted only by the minter</span>
              </Row>
            </dl>
            <div class="transfer__actions">
              {state.playing ? (
                <button type="button" class="btn btn--ghost" onClick={stop}>
                  Skip to the end
                </button>
              ) : (
                <button type="button" class="btn btn--ghost" onClick={start}>
                  {state.stage >= STEPS.length ? <ReplayIcon /> : <Play />}
                  {state.stage >= STEPS.length ? "Replay again" : "Replay the run"}
                </button>
              )}
              <p class="small dim">A replay of the recorded run, step by step. The checks it lists are the ones the contracts made on chain.</p>
            </div>
          </aside>
          <ol class="steps" aria-label="The four steps of lock 0" ref={stepsRef}>
            {STEPS.map((_, i) => (
              <Step key={i} i={i} open={open === i} onToggle={() => setOpen(open === i ? null : i)} replay={state} />
            ))}
          </ol>
        </div>
        <div class="ledger-wrap reveal">
          <div class="subhead">
            <h3 class="h3">Right now, on both chains</h3>
            <p class="small dim">Read when this page loaded and refreshed every two minutes.</p>
          </div>
          <Ledger />
        </div>
      </div>
    </section>
  );
}
