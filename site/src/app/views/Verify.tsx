// The Verify page: pick a transfer, and this browser checks it from the chains' public nodes, step
// by step, as the destination's contracts checked it: the header, V3's validator keys and their
// signatures, the lock's storage proof and its commitment, then the destination's own verdict, read
// again just now. The way back: the burn, its id and its release proven on V3, and the committee's
// decision, trusted. Nothing is signed or sent. The steps and their words are
// ../../lib/proof/verify.ts's; this page draws them.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { V3_EVM, VAULT, records } from "../../lib/chains.ts";
import { checksum } from "../../lib/display.ts";
import { signedChecked, verdictOf, waitingRun, type Line, type Run, type Step, type StepState, type Val, type VerdictKind } from "../../lib/proof/verdict.ts";
import type { History } from "../../lib/proof/verify.ts";
import { destOf, refOf, type Dest } from "../dests.ts";
import { fromOf, toOf, type ChainInfo } from "../facts.ts";
import { ChainMark } from "../marks.tsx";
import type { Route } from "../router.ts";
import { useBox } from "../store.ts";
import { chainIdOf, isDone, toTokens, transfers, type LiveTransfer } from "../transfers.ts";
import { Addr, Chip, CopyButton, Icon, Nb, announce, closeSheet, fmt, num, openSheet, short, toast } from "../ui.tsx";
import { bareMeta, commandsOf, dayTime, readField, type BeyondLock, type PickRow } from "../verify-model.ts";
import { BURNS, LOCKS, beyond, headOf, histories, leaveHistory, leaveVerify, lookupHash, runs, startBeyond, startHistory, startVerify, type VerifyHead } from "../verify-runs.ts";
import { Tick } from "./Receipt.tsx";
import { CssSpan, EmptyCard, Redirect } from "./Tx.tsx";

/** "Oct 27, 23:55 UTC". */
const whenOf = (at: number | null): string | null => (at === null ? null : `${dayTime(at)} UTC`);

/** A chain's name in the card's title on a small phone: a rollup's first word, as the transfer card shows it. */
const tightName = (c: ChainInfo): string => (c.key === "v3" || c.key === "sepolia" ? c.short : c.name);

/** The key that deployed the light clients and installed their checkpoints, as the records hold it. */
const DEPLOYER = records.sepolia.deployer;

/** The client's admin in words: admin() as the run read it, or the records' deployer until then. */
function adminText(admin: string | null): string {
  if (!admin) return `its deployer, ${short(checksum(DEPLOYER))}`;
  return admin === DEPLOYER ? `its deployer, ${short(checksum(admin))} (admin() read just now)` : `${short(checksum(admin))}, not its deployer (admin() read just now)`;
}

const still = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Brings a panel below the card into view: a # link would change the route. */
function scrollToPanel(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: still() ? "auto" : "smooth", block: "start" });
}

// ---------------------------------------------------------------------------------------------
// Picking a transfer

/** A transfer of this browser's journal that is done, as the picker lists it, by the id it goes by on the chains. */
function yourRow(t: LiveTransfer): PickRow | null {
  const id = chainIdOf(t);
  if (!id || !isDone(t)) return null;
  const n = t.dir === "in" ? t.nonce : t.burnNonce;
  const label = t.dir === "in" ? `Lock ${n ?? ""}` : t.dest === "sepolia" ? `Burn ${n ?? ""}` : `Burn ${n ?? ""} on ${destOf(t.dest).short}`;
  return { id, dir: t.dir, dest: t.dest, n: n ?? 0, amount: t.amount, at: t.startedAt, label, substrate: t.dir === "in" && t.sender.kind === "substrate", done: true };
}

type Whence = "recorded" | "this browser" | "read from V3";

function PickRowView({ r, whence, current }: { r: PickRow; whence: Whence; current: string | null }) {
  const from = fromOf(r.dir, r.dest);
  const to = toOf(r.dir, r.dest);
  const here = r.id === current;
  const when = Number.isFinite(r.at) ? ` · ${dayTime(r.at)}` : "";
  return (
    <li>
      <a class={`arow vrow${here ? " is-current" : ""}`} href={`#/verify/${r.id}`} aria-current={here ? "page" : undefined} onClick={() => closeSheet(true)}>
        <span class="pairmark pairmark--sm" aria-hidden="true">
          <ChainMark mark={from.mark} cls="mark--28" />
          <ChainMark mark={to.mark} cls="mark--28" />
        </span>
        <span class="arow__main">
          <span class="arow__title">
            {fmt(toTokens(r.amount))} {from.token} <span class="arow__to">→ {to.short}</span>
          </span>
          <span class="arow__meta">
            {r.label}
            {when}
            {r.substrate ? " · from a Polkadot wallet" : ""} · {whence}
          </span>
        </span>
        {/* A lock read from V3 whose used(n) was not answered gets no chip, rather than one that may be wrong. */}
        <span class="arow__status">
          {r.dir === "in" ? (
            r.done === null ? null : (
              <Chip kind="verified badge--sm" icon="i-shield-check">
                {r.done ? "Minted" : "Locked"}
              </Chip>
            )
          ) : (
            <Chip kind="trusted badge--sm" icon="i-users">
              {r.done ? "Released" : "Burned"}
            </Chip>
          )}
        </span>
        <span class="arow__chev" aria-hidden="true">
          <Icon id="i-chevron-right" cls="i--16" />
        </span>
      </a>
    </li>
  );
}

/** A lock past the records whose Locked log is not read yet, could not be read, or has none (a Substrate extrinsic's): its nonce only, and its check a click away. */
function BareRow({ n, read, current }: { n: number; read: BeyondLock["read"]; current: string | null }) {
  const id = `lock-${n}`;
  const here = id === current;
  return (
    <li>
      <a class={`arow vrow${here ? " is-current" : ""}`} href={`#/verify/${id}`} aria-current={here ? "page" : undefined} onClick={() => closeSheet(true)}>
        <span class="pairmark pairmark--sm" aria-hidden="true">
          <ChainMark mark={fromOf("in", "sepolia").mark} cls="mark--28" />
        </span>
        <span class="arow__main">
          <span class="arow__title">Lock {n}</span>
          <span class="arow__meta">{bareMeta(read)}</span>
        </span>
        <span class="arow__status" />
        <span class="arow__chev" aria-hidden="true">
          <Icon id="i-chevron-right" cls="i--16" />
        </span>
      </a>
    </li>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ComponentChildren }) {
  if (!count) return null;
  return (
    <section class="agroup" aria-label={title}>
      <h2 class="agroup__title">
        {title}
        <span class="mono">{count}</span>
      </h2>
      <ul class="alist">{children}</ul>
    </section>
  );
}

/** "Another lock or burn": lock-7, 7, burn-base-sepolia-0, or a transaction hash looked up on V3 and each destination. */
function Field() {
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ err: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (id: string) => {
    closeSheet(true);
    location.hash = `#/verify/${id}`;
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const f = readField(text);
    if (f.kind === "bad") return setNote({ err: true, text: f.why });
    if (f.kind === "id") return go(f.id);
    setBusy(true);
    setNote({ err: false, text: "Looking it up on V3, then on each chain it bridges to…" });
    void lookupHash(f.hash)
      .catch(() => null)
      .then((id) => {
        setBusy(false);
        if (id) go(id);
        else setNote({ err: true, text: "No lock, mint or burn of this bridge has that hash on V3, Sepolia, Base Sepolia or Arbitrum Sepolia." });
      });
  };
  return (
    <form class="vfield" onSubmit={submit}>
      <label class="vfield__label" for="vf-input">
        A lock, a burn or a transaction hash
      </label>
      <div class="vfield__row">
        <input
          id="vf-input"
          class={`recip__input mono${note?.err ? " is-error" : ""}`}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellcheck={false}
          placeholder="lock-7, 7, burn-base-sepolia-0 or 0x…"
          value={text}
          aria-describedby={note ? "vf-note" : undefined}
          onInput={(e) => {
            setText(e.currentTarget.value);
            if (note?.err) setNote(null);
          }}
        />
        <button class="btn btn--secondary" type="submit" disabled={busy} aria-busy={busy ? "true" : undefined}>
          {busy ? <span class="tl__spin" aria-hidden="true" /> : null}
          Check
        </button>
      </div>
      {note ? (
        <p class={`recip__note${note.err ? " recip__note--err" : ""}`} id="vf-note" role="status">
          <Icon id={note.err ? "i-alert" : "i-info"} cls="i--14" />
          <span>{note.text}</span>
        </p>
      ) : null}
    </form>
  );
}

/**
 * The picker: the field first, as the list's search row; then this browser's finished transfers,
 * the locks (the records', and the ones past them read from V3) and the burns. `current`: the
 * transfer on screen, marked when the list opens in the sheet.
 */
function PickList({ current = null }: { current?: string | null }) {
  const mine = [...useBox(transfers).values()].map(yourRow).filter((r): r is PickRow => r !== null).sort((a, b) => b.at - a.at);
  const more = useBox(beyond);
  useEffect(startBeyond, []);
  return (
    <div class="vpick">
      <Field />
      <Group title="Yours, in this browser" count={mine.length}>
        {mine.map((r) => (
          <PickRowView key={r.id} r={r} whence="this browser" current={current} />
        ))}
      </Group>
      <Group title="The way in · light client" count={LOCKS.length + more.length}>
        {more.map((x) => (x.row ? <PickRowView key={x.n} r={x.row} whence="read from V3" current={current} /> : <BareRow key={x.n} n={x.n} read={x.read} current={current} />))}
        {LOCKS.map((r) => (
          <PickRowView key={r.id} r={r} whence="recorded" current={current} />
        ))}
      </Group>
      <Group title="The way back · committee" count={BURNS.length}>
        {BURNS.map((r) => (
          <PickRowView key={r.id} r={r} whence="recorded" current={current} />
        ))}
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The panels below the card

function RailHead({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div class="rail-card__head">
      <span class="rail-card__icon" aria-hidden="true">
        <Icon id={icon} />
      </span>
      <div>
        <h2 class="rail-card__title">{title}</h2>
        <p class="rail-card__sub">{sub}</p>
      </div>
    </div>
  );
}

function WhatChecks() {
  const items: readonly (readonly [string, string])[] = [
    ["V3's validators signed the block", "2 of 2 ed25519 signatures, under the keys the destination's light client holds, by its own rules"],
    ["The lock is in that block's state", "the vault's child trie, walked to the block's state root, and the commitment recomputed from the lock"],
    ["The destination took the same proof", "its receipt, and the same mint sent again just now as a read, which stops only at the nonce"],
  ];
  return (
    <div class="rail-card vpanel">
      <RailHead icon="i-shield-check" title="What your browser checks" sub="The checks the contracts make, run here on the bytes they took." />
      <ol class="rail">
        {items.map(([t, m], i) => (
          <li key={t} class="rail__item">
            <span class="rail__node">
              <span class="mono rail__n">{i + 1}</span>
            </span>
            <div class="rail__body">
              <p class="rail__title">{t}</p>
              <p class="rail__meta">{m}</p>
            </div>
            <span />
          </li>
        ))}
      </ol>
    </div>
  );
}

function DoesNotProve({ dir, d, admin = null }: { dir: "in" | "back" | null; d: Dest | null; admin?: string | null }) {
  const chain = d ? `${d.short}'s` : "The destinations'";
  return (
    <div class="rail-card rail-card--trust vpanel" id="vf-limits">
      <RailHead icon="i-alert" title="What this does not prove" sub="A check that passes here is only as good as these." />
      <ul class="vlist">
        <li>
          <strong>V3's 2 validators</strong>, probably development keys on this testnet, and V3's sudo key, which can change any of its storage.
        </li>
        <li>
          <strong>The light client's admin</strong>, {adminText(admin)}: it installed the checkpoint the keys come from, and can pause and reinitialize the client.
        </li>
        <li>
          <strong>{chain} public RPCs</strong>: this page reads their answers and does not check that chain's consensus. Two RPCs answer where they can, and the explorer is a third view.
        </li>
        <li>
          <strong>This page's own code</strong>: served by its host, open source, and able to reach only the RPC nodes its Content-Security-Policy lists.{" "}
          {d ? "The commands below check the same without it." : "Each transfer's checks end with commands that check the same without it."}
        </li>
        {dir !== "in" ? (
          <li>
            <strong>The committee</strong>: nothing on V3 checks a burn before the vault pays. 2 of its 3 keys release, and on the testnet one operator holds all three.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

const HSTATE: Record<History["changes"][number]["state"], string> = { waiting: "waiting", checking: "checking", passed: "passed", failed: "failed", skipped: "skipped" };

/** The admin's initialize of `d`'s V3 light client, which installed its checkpoint, as the records hold it. */
const initOf = (d: Dest) => (d.key === "sepolia" ? records.lightClients.v3.init : (records.rollups[d.key]?.init ?? null));

/**
 * "Where the keys come from": the checkpoint, the set changes the client imported since, any V3
 * made after its last import (carried forward here), and the set that signed, ticked once its
 * signatures passed; on demand, every change checked here. `focus`: the page was opened at it.
 */
function KeysPanel({ d, run, focus }: { d: Dest; run: Run; focus: boolean }) {
  const h = useBox(histories).get(d.key);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => () => leaveHistory(d.key), [d.key]);
  useEffect(() => {
    if (!focus) return;
    // After the app's own scroll to the top of a new page.
    const t = setTimeout(() => ref.current?.scrollIntoView({ behavior: "auto", block: "start" }), 0);
    return () => clearTimeout(t);
  }, [focus]);
  const f = run.facts;
  const cp = f.checkpoint;
  const walk = h && h !== "loading" && h !== "failed" ? h : null;
  const total = walk ? walk.changes.length : (cp?.changes ?? null);
  const ok = walk ? walk.changes.filter((c) => c.state === "passed").length : 0;
  const allOk = !!walk?.done && ok === total;
  // The set that signed is checked once its signatures passed: step 3 on the way in, B3 on the way back.
  const signedOk = signedChecked(run);
  // Changes V3 made after the client's last import, carried forward here: in step 2 on the way in (a lock read from V3 now), in B3 on the way back.
  const carriedIn = run.dir === "in" ? "step 2" : "B3";
  const carriedOk = run.steps.some((s) => (s.key === "keys" && s.state === "passed") || (s.key === "released" && (s.state === "passed" || s.state === "open")));
  const sigStep = run.dir === "in" ? "Step 3" : "B3";
  const readIn = run.dir === "in" ? "step 2" : "B3";
  // The chain's own Initialized log once the walk has read it, else the records' initialize.
  const init = walk?.init ?? initOf(d);
  const signed = run.dir === "in" ? "this block" : `V3's head #${f.block ? num(f.block.number) : "…"}`;
  return (
    <div class="rail-card vpanel vkeys" id="vf-keys" ref={ref}>
      <RailHead icon="i-key" title="Where the keys come from" sub={`The keys that signed ${signed}, traced to the checkpoint of the light client on ${d.short}.`} />
      <ol class="rail">
        <li class={`rail__item${cp ? " is-trusted" : ""}`}>
          <span class="rail__node">
            <Icon id="i-key" />
          </span>
          <div class="rail__body">
            <p class="rail__title">{cp ? `Checkpoint · set ${cp.setId} at V3 #${num(cp.at)}` : "The checkpoint"}</p>
            <p class="rail__meta">
              Installed with initialize by the client's admin, {adminText(f.admin)}
              {init ? (
                <>
                  {" "}
                  · {d.short} tx{" "}
                  <a class="text-link mono" href={`${d.explorer.url}/tx/${init.tx}`} target="_blank" rel="noopener">
                    {short(init.tx)}
                  </a>
                </>
              ) : null}
            </p>
          </div>
          <span class="rail__state">Trusted</span>
        </li>
        <li class={`rail__item${allOk ? " is-passed" : walk && !walk.done ? " is-checking" : ""}`}>
          <span class="rail__node">{allOk ? <Icon id="i-check" /> : walk && !walk.done ? <span class="tl__spin" aria-hidden="true" /> : <Icon id="i-link" />}</span>
          <div class="rail__body">
            <p class="rail__title">{total !== null ? `${num(total)} set change${total === 1 ? "" : "s"} since, each signed by the set before` : "The set changes since"}</p>
            <p class="rail__meta">
              {walk
                ? walk.done
                  ? walk.summary
                  : `${ok} of ${total ?? 0} checked here`
                : cp?.latest != null
                  ? `Up to set ${cp.latest}, the client's latest. Each change can be checked again here.`
                  : "Read with the keys"}
            </p>
            {walk ? (
              <div class="vkeys__bar" aria-hidden="true">
                {walk.changes.map((c) => (
                  <span key={String(c.setId)} class={`vkeys__seg is-${HSTATE[c.state]}`} />
                ))}
              </div>
            ) : null}
          </div>
          <span class="rail__state">{walk ? (walk.done ? `${ok}/${total ?? 0}` : "Checking") : ""}</span>
        </li>
        {f.carried > 0 ? (
          <li class={`rail__item vkeys__carried${carriedOk ? " is-passed" : ""}`}>
            <span class="rail__node">
              <Icon id={carriedOk ? "i-check" : "i-link"} />
            </span>
            <div class="rail__body">
              <p class="rail__title">
                +{f.carried} change{f.carried === 1 ? "" : "s"} V3 signed after the client's last import
              </p>
              <p class="rail__meta">
                Checked here in {carriedIn}: each signed by the set before, up to set {String(f.setId)}
              </p>
            </div>
            <span class="rail__state">{carriedOk ? (run.dir === "back" ? "B3" : "Step 2") : ""}</span>
          </li>
        ) : null}
        <li class={`rail__item${signedOk ? " is-passed" : ""}`}>
          <span class="rail__node">
            <Icon id={signedOk ? "i-check" : "i-key"} />
          </span>
          <div class="rail__body">
            <p class="rail__title">{f.setId !== null ? `Set ${f.setId}, which signed ${signed}` : `The set that signed ${signed}`}</p>
            <p class="rail__meta">
              {cp ? (
                <>
                  keys hash <span class="mono">{short(cp.keysHash)}</span>
                  {cp.same ? ` · the same ${cp.keys} keys as the checkpoint's (set ${cp.setId})` : " · other keys than the checkpoint's: each change on the way names them"}
                </>
              ) : (
                "Read with the keys"
              )}
              {f.setId !== null && !signedOk ? ` · read in ${readIn}; its signatures are not checked` : ""}
            </p>
          </div>
          <span class="rail__state">{signedOk ? sigStep : ""}</span>
        </li>
      </ol>
      {walk ? (
        <div class="vkeys__out" aria-live="polite">
          <p class="vkeys__sum">{walk.summary}</p>
          <ul class="vchecks">
            {[...(walk.checkpoint?.lines ?? []), ...(walk.events ? [walk.events] : [])].map((l) => (
              <CheckLine key={l.text} l={l} />
            ))}
          </ul>
          {walk.done ? (
            <details class="vraw">
              <summary class="vraw__sum">
                <Icon id="i-chevron-down" cls="i--14 vraw__chev" />
                Each set change <span class="vraw__n">{walk.changes.length}</span>
              </summary>
              <ul class="vchecks vchecks--list">
                {walk.changes.map((c) => (
                  <CheckLine key={String(c.setId)} l={{ ok: c.state === "passed" ? true : c.state === "failed" ? false : null, text: `Set ${c.setId} · ${c.text}` }} />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      {h === "failed" ? (
        <p class="recip__note recip__note--err">
          <Icon id="i-alert" cls="i--14" />
          <span>The key history could not be read: try again.</span>
        </p>
      ) : null}
      {!walk || walk.done ? (
        <button class="btn btn--secondary btn--lilac" type="button" disabled={h === "loading"} onClick={() => startHistory(d.key)}>
          {h === "loading" ? <span class="tl__spin" aria-hidden="true" /> : <Icon id={walk ? "i-refresh" : "i-play"} />}
          <span>{walk ? "Check them all again" : cp?.changes != null ? `Check all ${num(cp.changes)} in this browser` : "Check every set change in this browser"}</span>
        </button>
      ) : null}
    </div>
  );
}

function WithoutPage({ d, run }: { d: Dest; run: Run }) {
  const rpc = d.rpcs[0]?.url ?? "";
  const cmds = commandsOf(run.facts, d, rpc, { vault: VAULT, rpc: V3_EVM[0]?.url ?? "" });
  return (
    <details class="rail-card vpanel vfold">
      <summary class="vfold__sum">
        <span class="rail-card__icon" aria-hidden="true">
          <Icon id="i-doc" />
        </span>
        <span class="vfold__title">
          <span class="rail-card__title">Check it without this page</span>
          <span class="rail-card__sub">Read-only, with Foundry's cast and coreutils, against {d.short}'s public RPC.</span>
        </span>
        <Icon id="i-chevron-down" cls="i--16 vfold__chev" />
      </summary>
      {cmds.length ? (
        <ul class="vcmds">
          {cmds.map((c) => (
            <li key={c.cmd}>
              <p class="vcmds__what">{c.what}</p>
              <div class="vcmds__cmd">
                <code class="mono">{c.cmd}</code>
                <CopyButton value={c.cmd} label="the command" />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p class="rail-card__sub">The commands fill in as the checks read the transfer.</p>
      )}
    </details>
  );
}

// ---------------------------------------------------------------------------------------------
// The check list

const STATE_LABEL: Record<StepState, string> = {
  waiting: "Waiting",
  checking: "Checking",
  passed: "Passed",
  failed: "Failed",
  skipped: "Not checked",
  unreached: "Not reached",
  trusted: "Trusted",
  open: "Not yet",
};

const STATE_CLS: Record<StepState, string> = {
  waiting: "is-pending",
  checking: "is-active",
  passed: "is-done",
  failed: "is-failed",
  skipped: "is-skipped",
  unreached: "is-skipped is-unreached",
  trusted: "is-done is-trusted",
  open: "is-skipped",
};

function nodeIcon(st: StepState) {
  if (st === "checking") return <span class="tl__spin" aria-hidden="true" />;
  if (st === "passed") return <Icon id="i-check" />;
  if (st === "failed") return <Icon id="i-x" />;
  if (st === "trusted") return <Icon id="i-users" />;
  if (st === "skipped") return <Icon id="i-server" />;
  if (st === "open") return <Icon id="i-clock" />;
  return null;
}

const msText = (ms: number): string => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

/** A failure's expected or found value: a long hash shortened, words as they are. */
const diffText = (s: string): string => (/^0x[0-9a-fA-F]{24,}$/.test(s) ? short(s, 10, 6) : s);

function ValView({ v }: { v: Val }) {
  if (v.t === "text") return <span>{v.text}</span>;
  if (v.t === "mono") return <span class="mono">{v.text}</span>;
  if (v.t === "tag") return <span class="vtag">{v.text}</span>;
  if (v.t === "hash") return <Addr full={v.full} href={v.href ?? undefined} label={v.label} cls="vaddr" />;
  const kind = v.kind === "recorded" ? "trusted" : "muted";
  return (
    <Chip kind={kind} cls="badge--sm vsrc" icon={v.kind === "read" ? "i-server" : v.kind === "recorded" ? "i-doc" : "i-alert"}>
      {v.text}
    </Chip>
  );
}

function CheckLine({ l }: { l: Line }) {
  return (
    <li class={`kv__check vcheck ${l.ok === true ? "is-ok" : l.ok === false ? "is-bad" : "is-na"}`}>
      <Icon id={l.ok === true ? "i-check" : l.ok === false ? "i-alert" : "i-info"} cls="i--14" />
      <span>{l.text}</span>
    </li>
  );
}

/**
 * One step: its node, title and state, and its one-line result, which opens the step's evidence
 * (the values, the cross-checks, the trust line, the raw data). The evidence starts open for a step
 * that failed or was not checked, and for one with a cross-check that disagreed or could not be made.
 */
function StepView({ s, i, onRetry }: { s: Step; i: number; onRetry: () => void }) {
  const time = s.state === "passed" && s.ms !== null ? `${STATE_LABEL.passed} · ${msText(s.ms)}` : STATE_LABEL[s.state];
  const settled = s.state !== "waiting" && s.state !== "checking";
  const fold = settled && !!s.sub && (s.ev.length > 0 || s.lines.length > 0 || !!s.trust || s.raw.length > 0 || !!s.diff || s.retry);
  const open = s.state === "failed" || s.state === "skipped" || s.state === "open" || s.lines.some((l) => l.ok !== true);
  const head = (
    <>
      {s.diff ? (
        <div class="diff vdiff">
          <span class="diff__from">
            <span class="diff__k">expected</span>
            <span class="mono">{diffText(s.diff.expected)}</span>
          </span>
          <span class="diff__arrow" aria-hidden="true">
            <Icon id="i-arrow-right" cls="i--14" />
          </span>
          <span class="diff__to">
            <span class="diff__k">found</span>
            <span class="mono">{diffText(s.diff.found)}</span>
          </span>
        </div>
      ) : null}
      {s.retry ? (
        <button class="btn btn--secondary btn--sm vretry" type="button" onClick={onRetry}>
          <Icon id="i-refresh" />
          Try again
        </button>
      ) : null}
    </>
  );
  return (
    <li class={`tl__step ${STATE_CLS[s.state]}`} data-step={s.key}>
      <span class="tl__node">{nodeIcon(s.state)}</span>
      <div class="tl__body">
        <div class="tl__top">
          <p class="tl__title">
            <span class="vstep__n mono">{i + 1}</span>
            {s.title}
          </p>
          <span class="tl__time">{time}</span>
        </div>
        {fold ? (
          <details class="vev" open={open}>
            <summary class="vev__sum">
              <Icon id="i-chevron-down" cls="i--14 vev__chev" />
              <span>{s.sub}</span>
            </summary>
            <div class="vev__body">
              {head}
              {s.from.length ? (
                <p class="vfrom">
                  <Chip kind="muted" cls="badge--sm vsrc" icon="i-server">
                    Read now · {s.from.join(", ")}
                  </Chip>
                </p>
              ) : null}
              {s.ev.length ? (
                <dl class="vk">
                  {s.ev.map((e) => (
                    <div key={e.k} class={`kv${e.wide ? " kv--full" : ""}`}>
                      <dt class="kv__k">{e.k}</dt>
                      <dd class="kv__v">
                        {e.v.map((v, j) => (
                          <ValView key={j} v={v} />
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {s.lines.length ? (
                <ul class="vchecks">
                  {s.lines.map((l, j) => (
                    <CheckLine key={j} l={l} />
                  ))}
                </ul>
              ) : null}
              {s.trust && s.state !== "failed" && s.state !== "unreached" ? (
                <p class={`tl__trust tl__trust--${s.trust.kind}`}>
                  <Icon id={s.trust.kind === "trust" ? "i-users" : "i-shield-check"} cls="i--14" />
                  <span>{s.trust.text}</span>
                </p>
              ) : null}
              {s.raw.length ? (
                <details class="vraw">
                  <summary class="vraw__sum">
                    <Icon id="i-chevron-down" cls="i--14 vraw__chev" />
                    Raw data <span class="vraw__n">{s.raw.length}</span>
                  </summary>
                  {s.raw.map((r, j) => (
                    <div key={j} class="vraw__item">
                      <div class="vraw__head">
                        <span class="vraw__label">{r.label}</span>
                        <CopyButton value={r.value} label={r.label} />
                      </div>
                      <p class="vraw__call mono">{r.call}</p>
                      <pre class="vraw__pre">{r.value || "—"}</pre>
                    </div>
                  ))}
                </details>
              ) : null}
            </div>
          </details>
        ) : (
          <>
            {s.sub ? (
              <p class="tl__sub">{s.sub}</p>
            ) : s.state === "checking" ? (
              <p class="tl__sub" aria-hidden="true">
                <span class="skel skel--line" />
              </p>
            ) : null}
            {head}
          </>
        )}
      </div>
    </li>
  );
}

const CHIP: Record<VerdictKind, readonly [string, string]> = {
  checking: ["progress", "dot"],
  verified: ["verified", "i-shield-check"],
  partial: ["muted", "i-server"],
  failed: ["revert", "i-alert"],
  trusted: ["trusted", "i-users"],
  unminted: ["needs", "dot"],
  disagree: ["trusted", "i-alert"],
};

function VerdictMark({ kind }: { kind: VerdictKind }) {
  if (kind === "verified") return <Tick />;
  if (kind === "trusted") return <Tick trust />;
  return (
    <span class={`vmark vmark--${kind}`} aria-hidden="true">
      {kind === "checking" ? <span class="tl__spin" /> : <Icon id={kind === "failed" ? "i-x" : kind === "unminted" ? "i-clock" : kind === "disagree" ? "i-alert" : "i-server"} />}
    </span>
  );
}

/** The run's raw data and words as JSON, for "Copy all raw data". */
const allRaw = (id: string, run: Run): string =>
  JSON.stringify(
    {
      id,
      url: location.href,
      checkedAt: new Date().toISOString(),
      reads: run.reads,
      endpoints: run.endpoints,
      steps: run.steps.map((s) => ({ step: s.title, state: s.state, result: s.sub, read: s.from, checks: s.lines, raw: s.raw })),
    },
    null,
    1,
  );

function copyAll(id: string, run: Run): void {
  navigator.clipboard?.writeText(allRaw(id, run)).then(
    () => toast("info", "Copied", "Every step's raw data and words, as JSON."),
    () => toast("revert", "Not copied", "This browser did not allow it."),
  );
}

function openPicker(id: string): void {
  openSheet({ title: "Check another transfer", body: <PickList current={id} />, cls: "vsheet" });
}

function CheckPage({ id, panel }: { id: string; panel: string | null }) {
  const state = useBox(runs).get(id);
  useEffect(() => {
    startVerify(id);
    return () => leaveVerify(id);
  }, [id]);
  const head: VerifyHead | null = state && state.status !== "none" ? state.head : headOf(id);
  const run = state?.status === "run" ? state.run : null;

  // The polite announcer says each step once as it settles, then the verdict.
  const said = useRef(-1);
  const d0 = head ? destOf(head.dest) : null;
  const shown = run ?? (head && d0 ? waitingRun(head.dir, "minted", d0.short) : null);
  const settled = shown ? shown.steps.findIndex((s) => s.state === "waiting" || s.state === "checking") : -1;
  const upTo = shown ? (settled < 0 ? shown.steps.length : settled) : 0;
  useEffect(() => {
    if (!run || !d0) return;
    while (said.current + 1 < upTo) {
      said.current++;
      const s = run.steps[said.current];
      if (s) announce(`${s.title}: ${STATE_LABEL[s.state]}. ${s.sub}`);
    }
    if (run.done && said.current < run.steps.length) {
      said.current = run.steps.length;
      announce(verdictOf(run, d0.short).title);
    }
  }, [run, upTo]);

  if (state?.status === "none") return <NothingToVerify id={id} why={state.why} />;
  if (!head || !d0 || !shown) {
    const k = refOf(id);
    return (
      <EmptyCard title={state?.status === "error" ? `Could not read ${id}` : `Reading ${k?.dir === "in" ? `lock ${k.n}` : id}`} status action={{ href: "#/verify", text: "Pick a transfer" }}>
        {state?.status === "error" ? state.why : "From the vault's Locked log on V3, then what came of it on the chain it names."}
      </EmptyCard>
    );
  }
  const d = d0;
  const dir = head.dir;
  const from = fromOf(dir, d.key);
  const to = toOf(dir, d.key);
  const v = state?.status === "error" ? { kind: "partial" as const, chip: "Not all checked", title: "The checks stopped", sub: state.why, failedAt: null } : verdictOf(shown, d.short);
  const [chipKind, chipIcon] = CHIP[v.kind];
  const again = () => {
    said.current = -1;
    startVerify(id, true);
  };
  const when = whenOf(head.at);
  const lockN = refOf(id);
  // The transfer's own next step, right under the verdict: its mint, or its release, followed on its page.
  const next =
    shown.route === "unminted" && lockN?.dir === "in" ? "Go to the mint" : dir === "back" && shown.steps.some((s) => s.key === "released" && s.state === "open") ? "Follow the release" : null;
  return (
    <div class="stage stage--tx stage--verify" data-dir={dir}>
      <section class="intro intro--tx" aria-labelledby="vf-title">
        <a class="back-link" href="#/verify">
          <Icon id="i-arrow-left" cls="i--16" />
          Verify
        </a>
        <p class="intro__eyebrow">
          <span class="intro__dot" aria-hidden="true" />
          <span>
            <Nb>
              {head.label}
              {when ? " ·" : ""}
            </Nb>{" "}
            {when ? <Nb>{when}</Nb> : null}
          </span>
        </p>
        <h1 class="intro__title intro__title--tx" id="vf-title">
          {head.amount !== null ? `${fmt(toTokens(head.amount))} ${from.token}` : from.token} <span class="intro__arrow" aria-hidden="true">→</span>
          <span class="visually-hidden"> to </span> <span class="txcard__wide">{to.short}</span>
          <span class="txcard__tight">{tightName(to)}</span>
        </h1>
        <p class="replay-note replay-note--sample">
          <Icon id="i-shield-check" cls="i--14" />
          Checked in this browser, from public nodes. Nothing is signed or sent.
        </p>
        <div class="side">
          <DoesNotProve dir={dir} d={d} admin={shown.facts.admin} />
          <KeysPanel d={d} run={shown} focus={panel === "keys"} />
          <WithoutPage d={d} run={shown} />
        </div>
      </section>

      <section class="card card--lit txcard vcard" aria-labelledby="vf-title" data-verdict={v.kind}>
        <div class="txcard__head">
          <span class="pairmark" aria-hidden="true">
            <ChainMark mark={from.mark} cls="mark--32" />
            <ChainMark mark={to.mark} cls="mark--32" />
          </span>
          <div class="txcard__titles">
            <p class="txcard__title">
              <span class="txcard__wide">
                {from.short} → {to.short}
              </span>
              <span class="txcard__tight">
                {tightName(from)} → {tightName(to)}
              </span>
            </p>
            <p class="txcard__sub">
              {dir === "in" ? (
                "Light-client route"
              ) : (
                <>
                  Committee route<span class="txcard__long"> · 2-of-3</span>
                </>
              )}
            </p>
          </div>
          <Chip kind={`${chipKind} badge--sm`} icon={chipIcon}>
            {v.chip}
          </Chip>
          <button class="btn btn--ghost btn--sm vchange" type="button" onClick={() => openPicker(id)} aria-label="Change the transfer to check">
            <Icon id="i-swap-v" cls="i--16" />
            <span class="vchange__text">Change</span>
          </button>
        </div>

        <div class={`rc__hero vhero${dir === "back" ? " rc__hero--trust" : ""}`}>
          <VerdictMark kind={v.kind} />
          <p class="rc__title vhero__title">{v.title}</p>
          <p class="rc__sub vhero__sub">{v.sub}</p>
          <p class="vhero__foot">
            <Icon id="i-info" cls="i--14" />
            {dir === "in"
              ? "Only as good as V3's 2 testnet validators, its sudo key and the client admin's checkpoint."
              : "The release is only as good as the committee: 2 of its 3 keys, all one operator's on the testnet."}{" "}
            <button class="text-link vhero__more" type="button" onClick={() => scrollToPanel("vf-limits")}>
              What this does not prove ↓
            </button>
          </p>
        </div>

        {next ? (
          <a class="btn btn--primary btn--lg btn--block" href={`#/tx/${id}`}>
            <span>{next}</span>
            <Icon id="i-arrow-right" />
          </a>
        ) : null}

        <div class="progress txprog" aria-hidden="true">
          {shown.steps.map((s) => (
            <CssSpan
              key={s.key}
              cls={`progress__seg${s.state === "passed" ? " is-done" : ""}${s.state === "trusted" ? " is-done is-trusted" : ""}${s.state === "failed" ? " is-failed" : ""}${s.state === "checking" ? " is-active" : ""}`}
              prop="--fill"
              value={s.state === "passed" || s.state === "trusted" || s.state === "failed" ? "100%" : "0%"}
            />
          ))}
        </div>

        <ol class="tl vtl" aria-live="off">
          {shown.steps.map((s, i) => (
            <StepView key={s.key} s={s} i={i} onRetry={again} />
          ))}
        </ol>

        <div class="txcard__foot vfoot">
          <div class="vfoot__btns">
            <button class="btn btn--secondary" type="button" onClick={again} disabled={!!run && !run.done}>
              <Icon id="i-refresh" />
              Check again
            </button>
            <button class="btn btn--secondary" type="button" onClick={() => run && copyAll(id, run)} disabled={!run}>
              <Icon id="i-copy" />
              <span class="vfoot__long">Copy all raw data</span>
              <span class="vfoot__short">Copy JSON</span>
            </button>
            <CopyButton value={location.href} label="this check's link" cls="btn btn--secondary vfoot__link" icon="i-link" text="Link" />
          </div>
          <p class="txcard__close">
            <Icon id="i-server" cls="i--14" />
            <span>
              {run && run.endpoints.length
                ? `Read ${run.readsFloor ? "at least " : ""}${run.reads} times from ${[...new Set(run.endpoints)].join(", ")}. Nothing was signed or sent.`
                : "Reads V3's node and the destination's public RPCs. Nothing is signed or sent."}
            </span>
          </p>
        </div>
      </section>
    </div>
  );
}

function NothingToVerify({ id, why }: { id: string; why?: string }) {
  const name = id.length > 32 ? short(id, 14, 8) : id;
  return (
    <EmptyCard title="Nothing to verify" action={{ href: "#/verify", text: "Pick a transfer" }}>
      No lock or burn goes by <span class="mono">{name}</span>. {why || "The page checks a lock (lock-7), a burn on Sepolia (burn-0) or on a rollup (burn-base-sepolia-0)."}
    </EmptyCard>
  );
}

function PickPage() {
  return (
    <div class="stage stage--tx stage--verify" data-dir="in">
      <section class="intro intro--tx" aria-labelledby="vf-title">
        <p class="intro__eyebrow">
          <span class="intro__dot" aria-hidden="true" />
          Verify · in your browser
        </p>
        <h1 class="intro__title intro__title--tx" id="vf-title">
          Check a transfer yourself
        </h1>
        <p class="intro__lead vf__lead">Your browser checks V3's validator signatures and the lock's storage proof, then the destination's own verdict. Nothing is signed or sent.</p>
        <div class="side">
          <WhatChecks />
          <DoesNotProve dir={null} d={null} />
        </div>
      </section>
      <section class="card card--lit vcard vcard--pick" aria-labelledby="vf-title">
        <PickList />
      </section>
    </div>
  );
}

/** #/verify: pick a transfer. #/verify/<id>: its checks (?panel=keys opens it at its keys); a transfer of this browser goes by its chain id once it has one. */
export function VerifyView({ route }: { route: Route }) {
  const id = route.parts[1] ?? "";
  const live = useBox(transfers).get(id);
  if (!id) return <PickPage />;
  if (live) {
    const cid = chainIdOf(live);
    if (cid) return <Redirect to={`#/verify/${cid}`} />;
    return (
      <EmptyCard title="Nothing to verify yet" action={{ href: `#/tx/${id}`, text: "Go to the transfer" }}>
        This transfer has no lock or burn on chain yet: its page here opens once its {live.dir === "in" ? "lock" : "burn"} is mined.
      </EmptyCard>
    );
  }
  if (!refOf(id)) return <NothingToVerify id={id} />;
  return <CheckPage key={id} id={id} panel={route.q.get("panel")} />;
}
