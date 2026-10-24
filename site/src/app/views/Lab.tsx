// The attack lab: the five tampered mints and the replay recorded on Sepolia (README rows 33 to 38),
// the check that caught each one, and each one called again live: the recorded transaction's own
// input, sent to BridgeMinter with eth_call. Nothing is signed.

import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatValue, type DecodedError } from "../../lib/abi.ts";
import { DECIMALS, MINTER, REPO, etherscanBlock, etherscanTx, records } from "../../lib/chains.ts";
import { checksum, shortAddr } from "../../lib/display.ts";
import { formatUnits } from "../../lib/format.ts";
import { shortHex } from "../../lib/hex.ts";
import { checkAttack, registry, type AttackCheck } from "../../lib/live.ts";
import type { Attack } from "../../lib/records-types.ts";
import type { Route } from "../router.ts";
import { Box, useBox } from "../store.ts";
import { Addr, Icon, announce, num, short, toast } from "../ui.tsx";

type Part = Attack["part"];
type CheckKey = "header" | "sigs" | "proof" | "commit" | "nonce";

/** A mint's checks, in the order the contracts make them: the light client (header, then signatures), then the minter. */
const CHECKS: readonly { key: CheckKey; short: string }[] = [
  { key: "header", short: "Header" },
  { key: "sigs", short: "Signatures" },
  { key: "proof", short: "Storage proof" },
  { key: "commit", short: "Commitment" },
  { key: "nonce", short: "Nonce" },
];

/** What a mint sends BridgeMinter. */
const BUNDLE = ["Header", "Finality proof", "Storage proof", "Lock details"] as const;

/** The real mint every attack starts from: lock 0's (README row 32). */
const BASE = records.bridge;
const LOCK = BASE.lock.nonce;
const LOCK_AMOUNT = formatUnits(BASE.lock.amountNative, DECIMALS);

/** The README's Status line (327 forge tests, 213 relayer tests, 295 fixture checks) and the 35 tests in site/test. */
const TESTS: readonly (readonly [number, string])[] = [
  [327, "contract"],
  [213, "relayer"],
  [295, "proof-check"],
  [35, "page"],
];
/** The evidence link's second line: the total, then each suite. */
const TEST_LINE = [[TESTS.reduce((n, [t]) => n + t, 0), "tests"] as const, ...TESTS];

/** The README's evidence table, numbered across V3 and Sepolia. */
const TXS = records.evidence.at(-1)?.n ?? records.evidence.length;

// ---------------------------------------------------------------------------------------------
// The words for each attack

interface Ctx {
  a: Attack;
  /** The recorded revert, decoded with the contracts' error signatures. */
  rev: DecodedError | null;
  /** The recorded revert as the lab names it. */
  label: string;
}

interface AttackCopy {
  title: (c: Ctx) => string;
  /** The part of the bundle it changes. */
  part: (typeof BUNDLE)[number] | "Nothing";
  check: CheckKey;
  changed: (c: Ctx) => string;
  from: (c: Ctx) => string;
  to: (c: Ctx) => string;
  why: (c: Ctx) => string;
}

/** A record's description as a sentence. */
function sentence(s: string): string {
  const t = s.trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
}

/** The recorded revert's i-th value, hashes shortened: decoded from its data, or as the records write it. */
function revArg(c: Ctx, i: number): string {
  const v = c.rev?.args[i]?.value;
  if (v !== undefined) return formatValue(v, (h) => shortHex(h));
  return /\((.*)\)$/.exec(c.a.expectedRevert.name)?.[1]?.split(",")[i]?.trim() ?? "";
}

/** `next` in the casing of `was` wherever their digits agree, so the diff shows only the flipped byte. */
function sameCase(was: string, next: string): string {
  return [...next.toLowerCase()].map((ch, i) => (was[i]?.toLowerCase() === ch ? (was[i] ?? ch) : ch)).join("");
}

// What each attack changed is read from its record's words (tamper.what in deployments/sepolia-bridge.json),
// so the title, the sentence and the diff cannot disagree; words the record no longer has fall back to plain ones.
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** "byte 0 of R in precommit 1, signed by key 0, …": the byte of R, and the precommit it is in. */
function forged(c: Ctx): { byte: string; precommit: string } | null {
  const [, byte, precommit] = /\bbyte (\d+) of R in precommit (\d+)\b/.exec(c.a.what) ?? [];
  return byte && precommit ? { byte, precommit } : null;
}

/** "byte 33 of the slot proof's first item flipped": the byte, the proof, and the item, counted from 0. */
function corrupted(c: Ctx): { byte: string; proof: string; item: number } | null {
  const [, byte, proof, nth] = /\bbyte (\d+) of the (\w+) proof['’]s (\w+) item\b/.exec(c.a.what) ?? [];
  const item = nth ? ORDINALS.indexOf(nth) : -1;
  return byte && proof && item >= 0 ? { byte, proof, item } : null;
}

/** "the amount 1 wtPOT made 1,000 wtPOT": what the tampered mint claims. */
const claimed = (c: Ctx): string | undefined => /\bmade ([\d,.]+ wtPOT)\b/.exec(c.a.what)?.[1];

const COPY: Record<Part, AttackCopy> = {
  signature: {
    title: () => "A forged validator signature",
    part: "Finality proof",
    check: "sigs",
    changed: (c) => sentence(c.a.what),
    from: (c) => {
      const f = forged(c);
      return f ? `precommit ${f.precommit} · R[${f.byte}]` : "the signature";
    },
    to: (c) => {
      const f = forged(c);
      return f ? `R[${f.byte}] flipped` : "another signature";
    },
    why: (c) => {
      const on = forged(c)?.precommit;
      return `The light client checks the ed25519 signatures in key order, against V3's validator set. The first one it checks, key ${revArg(c, 1)}'s${on ? ` on precommit ${on}` : ""}, no longer verifies: ${c.label} means signature ${revArg(c, 0)}, from key ${revArg(c, 1)}.`;
    },
  },
  header: {
    title: () => "A rewritten state root",
    part: "Header",
    check: "header",
    // The record calls the bundle's block B.
    changed: (c) => sentence(c.a.what.replace(/\bB(?=['’]s\b)/, `block #${num(BASE.finality.block.number)}`)),
    from: (c) => `header hash ${revArg(c, 0)}`,
    to: (c) => `header hash ${revArg(c, 1)}`,
    why: (c) => `The header now hashes to a block nobody signed. The signatures finalize ${revArg(c, 0)}, so the import stops before any proof is read.`,
  },
  proof: {
    title: () => "A corrupted storage proof",
    part: "Storage proof",
    check: "proof",
    changed: (c) => sentence(c.a.what),
    from: (c) => {
      const p = corrupted(c);
      return p ? `${p.proof} proof · item ${p.item}` : "the storage proof";
    },
    to: (c) => {
      const p = corrupted(c);
      return p ? `byte ${p.byte} flipped` : "another proof";
    },
    why: () => `The proof no longer hashes up to the verified state root, so the walk to commitments[${LOCK}] cannot finish.`,
  },
  amount: {
    title: (c) => `${cap(claimed(c) ?? "another amount")} for a ${LOCK_AMOUNT} tPOT lock`,
    part: "Lock details",
    check: "commit",
    changed: (c) => sentence(c.a.what),
    from: () => `${LOCK_AMOUNT} wtPOT`,
    to: (c) => claimed(c) ?? "another amount",
    why: (c) => `The minter recomputes the commitment as ${revArg(c, 0)}, but the vault stored ${revArg(c, 1)} for this lock.`,
  },
  recipient: {
    title: () => "Someone else's address",
    part: "Lock details",
    check: "commit",
    // The diff shows the address the record names, so the sentence leaves it out.
    changed: (c) => sentence(c.a.what.replace(/\s*\(0x[0-9a-fA-F]{40}\)/, "")),
    from: () => short(checksum(BASE.lock.recipient)),
    to: (c) => {
      const sent = /0x[0-9a-fA-F]{40}/.exec(c.a.what)?.[0];
      return sent ? short(sameCase(checksum(BASE.lock.recipient), sent)) : "another address";
    },
    why: (c) => `The minter recomputes the commitment as ${revArg(c, 0)}, which is not what the vault stored, ${revArg(c, 1)}.`,
  },
  replay: {
    title: () => "The same mint, sent twice",
    part: "Nothing",
    check: "nonce",
    changed: () => `Nothing. The real mint of lock ${LOCK}, sent again.`,
    from: () => `lock ${LOCK}, already minted`,
    to: () => "the same bundle again",
    why: () => `Every check passes until the last: lock ${LOCK}'s nonce was spent by the first mint, so a second one is refused.`,
  },
};

/** How the lab names a revert: Error(string) by its reason, one with only numbers in full, any other by its name. */
function revertLabel(d: DecodedError): string {
  const reason = d.args[0]?.value;
  if (d.name === "Error" && typeof reason === "string") return reason;
  if (d.args.length && d.args.every((x) => typeof x.value === "bigint")) return `${d.name}(${d.args.map((x) => String(x.value)).join(", ")})`;
  return d.name;
}

function recordedLabel(a: Attack, rev: DecodedError | null): string {
  if (rev) return revertLabel(rev);
  const n = a.expectedRevert.name;
  const reason = /^Error\("(.*)"\)$/.exec(n)?.[1];
  if (reason) return reason;
  return n.includes("0x") ? n.replace(/\(.*$/, "") : n;
}

function liveLabel(r: AttackCheck): string | null {
  if (r.decoded) return revertLabel(r.decoded);
  return r.data ? `unknown error ${r.data.slice(0, 10)}` : null;
}

/** "Oct 19", from a recorded UTC timestamp. */
function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number): string => WORDS[n] ?? String(n);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

interface Row extends Ctx {
  copy: AttackCopy;
  /** Its name in the list, the detail and what is announced. */
  title: string;
}

const ROWS: Row[] = records.attacks.map((a) => {
  const rev = registry.decodeError(a.expectedRevert.data);
  const c: Ctx = { a, rev, label: recordedLabel(a, rev) };
  const copy = COPY[a.part];
  return { ...c, copy, title: copy.title(c) };
});

const N = ROWS.length;
/** Status 0: reverted on chain, as recorded. */
const REVERTED = ROWS.filter((r) => r.a.status === 0).length;
const DAY = day(ROWS[0]?.a.signedAt ?? null);
const AS_RECORDED = DAY ? `as on ${DAY}` : "as recorded";

// ---------------------------------------------------------------------------------------------
// The live checks

type Outcome = "same" | "other" | "bare" | "passed" | "failed";

interface Live {
  busy: boolean;
  /** Sepolia's last answer; a later call that fails leaves it here. */
  result: AttackCheck | null;
  /** Why the latest call failed, when it did. */
  error: string | null;
}

interface LabState {
  sel: Part;
  live: Partial<Record<Part, Live>>;
  /** "Check all" is going through the attacks. */
  running: boolean;
}

/** Kept across pages, as the prototype's was: the selected attack and the answers so far. */
const lab = new Box<LabState>({ sel: ROWS[0]?.a.part ?? "signature", live: {}, running: false });

const setLab = (p: Partial<LabState>) => lab.set((s) => ({ ...s, ...p }));
const setLive = (part: Part, l: Live) => lab.set((s) => ({ ...s, live: { ...s.live, [part]: l } }));

function outcomeOf(r: AttackCheck): Outcome {
  if (!r.reverted) return "passed";
  if (!r.data) return "bare";
  return r.sameAsRecord ? "same" : "other";
}

function said(r: Row, o: Outcome, res: AttackCheck | null): string {
  const t = r.title;
  const got = res ? liveLabel(res) : null;
  switch (o) {
    case "same":
      return `${t}: reverted with ${got ?? r.label}, the same as recorded.`;
    case "other":
      return `${t}: reverted with ${got ?? "other data"}, not the same data as recorded.`;
    case "bare":
      return `${t}: reverted, with no revert data to compare.`;
    case "passed":
      return `${t}: did not revert. That would be a failure of the contract.`;
    case "failed":
      return `${t}: no Sepolia node answered; the recorded revert stands.`;
  }
}

async function check(r: Row): Promise<Outcome> {
  const part = r.a.part;
  setLive(part, { busy: true, result: lab.get().live[part]?.result ?? null, error: null });
  try {
    const result = await checkAttack(r.a);
    setLive(part, { busy: false, result, error: null });
    const o = outcomeOf(result);
    announce(said(r, o, result));
    return o;
  } catch (e) {
    setLive(part, { busy: false, result: lab.get().live[part]?.result ?? null, error: e instanceof Error ? e.message : String(e) });
    announce(said(r, "failed", null));
    return "failed";
  }
}

const inflight = new Map<Part, Promise<Outcome>>();

/** Calls one attack again; asking again while it is on its way waits for the same call. */
function runOne(r: Row): Promise<Outcome> {
  const on = inflight.get(r.a.part);
  if (on) return on;
  const p = check(r).finally(() => inflight.delete(r.a.part));
  inflight.set(r.a.part, p);
  return p;
}

/** Bumped when the lab leaves the page: a "check all" in progress stops after its current call. */
let visit = 0;

function summarize(outcomes: Outcome[]): void {
  const count = (...os: Outcome[]) => outcomes.filter((o) => os.includes(o)).length;
  const title = `${count("same", "other", "bare")} of ${N} reverted, just now`;
  const passed = count("passed");
  const failed = count("failed");
  const same = count("same");
  if (passed) toast("revert", title, `${passed} did not revert. That would be a failure of the contract; please report it.`);
  else if (failed) toast("info", title, `${failed} could not be checked: no Sepolia node answered. Try again in a minute.`);
  else if (same === N) toast("verify", title, `Each named the same error ${AS_RECORDED}.`);
  else {
    // A revert with no data has nothing to compare, so it is not counted as one that differs from the record.
    const kinds: readonly (readonly [number, string])[] = [
      [same, `named the same error ${AS_RECORDED}`],
      [count("other"), "reverted with other data"],
      [count("bare"), "reverted with no data to compare"],
    ];
    toast("verify", title, `${kinds.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`).join("; ")}.`);
  }
}

/** Checks the attacks in turn, each selected as it runs; true when it got through all of them on this visit. */
async function runAll(): Promise<boolean> {
  if (lab.get().running) return false;
  const v = visit;
  // A fresh round, so the count starts from 0; a call already on its way keeps its spinner.
  lab.set((s) => {
    const live: LabState["live"] = {};
    for (const r of ROWS) if (s.live[r.a.part]?.busy) live[r.a.part] = { busy: true, result: null, error: null };
    return { ...s, running: true, live };
  });
  const outcomes: Outcome[] = [];
  for (const r of ROWS) {
    if (visit !== v) break;
    setLab({ sel: r.a.part });
    outcomes.push(await runOne(r));
  }
  setLab({ running: false });
  if (visit !== v) return false;
  summarize(outcomes);
  return true;
}

// ---------------------------------------------------------------------------------------------
// The page

const NARROW = "(max-width: 767px)";

/** Below 768 px the list is an accordion, with the detail under the open attack. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function LiveCheck({ r, live, onRun }: { r: Row; live: Live | undefined; onRun: () => void }) {
  const res = live?.result ?? null;
  const when = day(r.a.signedAt);
  const recorded = when ? `recorded on ${when}` : "recorded";
  if (!live?.busy && res?.reverted) {
    const got = liveLabel(res);
    const at = `eth_call at Sepolia #${num(res.block)}, via ${res.endpoint}.`;
    const how = !res.data
      ? `The node sent no revert data, so it cannot be matched with the revert ${recorded}. ${at}`
      : res.sameAsRecord
        ? `The same revert data, byte for byte, as ${recorded}. ${at}`
        : `Not the same revert data as ${recorded}, which was ${r.label}. ${at}`;
    return (
      <div class="livecheck is-done">
        <p class="livecheck__res">
          <Icon id="i-check-circle" cls="i--16" />
          <span>
            <strong>
              Reverted just now
              {got ? (
                <>
                  {" "}
                  with <span class="mono">{got}</span>
                </>
              ) : null}
            </strong>
            {how}
            {live?.error ? " Checking it again failed: no Sepolia node answered." : ""}
          </span>
        </p>
        <button class="btn btn--secondary btn--lilac" type="button" onClick={onRun}>
          <Icon id="i-refresh" />
          Check it again
        </button>
      </div>
    );
  }
  if (!live?.busy && res) {
    return (
      <div class="livecheck">
        <p class="livecheck__text">
          <strong>Did not revert at Sepolia #{num(res.block)}.</strong> That would be a failure of the contract; please report it. eth_call via {res.endpoint}.
          {live?.error ? " Checking it again failed: no Sepolia node answered." : ""}
        </p>
        <button class="btn btn--secondary btn--lilac" type="button" onClick={onRun}>
          <Icon id="i-refresh" />
          Check it again
        </button>
      </div>
    );
  }
  if (!live?.busy && live?.error) {
    return (
      <div class="livecheck">
        <p class="livecheck__text" title={live.error}>
          No Sepolia node answered, so it could not be checked again just now. The revert above is the recorded one.
        </p>
        <button class="btn btn--secondary btn--lilac" type="button" onClick={onRun}>
          <Icon id="i-refresh" />
          <span>Try again</span>
        </button>
      </div>
    );
  }
  const busy = !!live?.busy;
  return (
    <div class="livecheck">
      <p class="livecheck__text">Your browser sends this exact call to BridgeMinter as a read, and shows what Sepolia answers. Nothing is signed or sent.</p>
      <button class="btn btn--secondary btn--lilac" type="button" disabled={busy} aria-busy={busy ? "true" : undefined} onClick={onRun}>
        {busy ? (
          <>
            <span class="tl__spin" aria-hidden="true" />
            <span>Calling BridgeMinter…</span>
          </>
        ) : (
          <>
            <Icon id="i-play" />
            <span>Check it live</span>
          </>
        )}
      </button>
    </div>
  );
}

function Detail({ r, live }: { r: Row; live: Live | undefined }) {
  const { a, copy } = r;
  const ci = CHECKS.findIndex((k) => k.key === copy.check);
  const when = day(a.signedAt);
  return (
    <section class="card labdetail" id="lab-detail" aria-live="polite">
      <header class="labdetail__head">
        <span class="labdetail__n mono">
          Sepolia{a.block !== null ? ` #${num(a.block)}` : ""}
          {when ? ` · ${when}` : ""}
        </span>
        <h2 class="labdetail__title">{r.title}</h2>
      </header>

      <div class="labsec">
        <p class="labsec__label">What changed</p>
        <p
          class="bundle"
          role="img"
          aria-label={`The mint bundle: header, finality proof, storage proof and lock details. ${copy.part === "Nothing" ? "No part changed." : `Changed part: ${copy.part.toLowerCase()}.`}`}
        >
          {BUNDLE.map((p, i) => (
            <Fragment key={p}>
              {i ? (
                <span class="bundle__plus" aria-hidden="true">
                  +
                </span>
              ) : null}
              <span class={`bundle__part${p === copy.part ? " is-hit" : ""}`}>{p}</span>
            </Fragment>
          ))}
        </p>
        <p class="labsec__text">{copy.changed(r)}</p>
        <div class="diff">
          <span class="diff__from">
            <span class="diff__k">was</span>
            <span class="mono">{copy.from(r)}</span>
          </span>
          <span class="diff__arrow" aria-hidden="true">
            <Icon id="i-arrow-right" cls="i--14" />
          </span>
          <span class="diff__to">
            <span class="diff__k">sent</span>
            <span class="mono">{copy.to(r)}</span>
          </span>
        </div>
      </div>

      <div class="labsec">
        <p class="labsec__label">Which check caught it</p>
        <ol class="pipe">
          {CHECKS.map((k, i) => {
            const st = i < ci ? "pass" : i === ci ? "catch" : "skip";
            return (
              <li key={k.key} class={`pipe__step is-${st}`}>
                <span class="pipe__node">{st === "pass" ? <Icon id="i-check" cls="i--14" /> : st === "catch" ? <Icon id="i-x" cls="i--14" /> : null}</span>
                <span class="pipe__name">{k.short}</span>
                <span class="pipe__st">{st === "pass" ? "passed" : st === "catch" ? "caught it" : "not reached"}</span>
              </li>
            );
          })}
        </ol>
        <p class="labsec__text">{copy.why(r)}</p>
      </div>

      <div class="revert">
        <div class="revert__head">
          <span class="revert__label">Reverts with</span>
          <code class="revert__code mono">{r.label}</code>
        </div>
        <dl class="revert__rec">
          <div>
            <dt>Recorded</dt>
            <dd>
              Sepolia{" "}
              {a.block !== null ? (
                <a class="tl__link" href={etherscanBlock(a.block)} target="_blank" rel="noopener">
                  #{num(a.block)}
                  <Icon id="i-external" cls="i--12" />
                </a>
              ) : null}
              {a.gasUsed !== null ? ` · ${num(a.gasUsed)} gas used` : ""}
            </dd>
          </div>
          <div>
            <dt>Transaction</dt>
            <dd>
              <Addr full={a.txHash} href={etherscanTx(a.txHash)} label="recorded transaction" cls="addr--tx" />
            </dd>
          </div>
        </dl>
      </div>

      <LiveCheck r={r} live={live} onRun={() => void runOne(r)} />

      <p class="labdetail__base">
        Base: the real mint of lock {LOCK} · V3 block #{num(BASE.finality.block.number)}, set {BASE.finality.setId}{" "}
        <Addr full={BASE.mint.txHash} href={etherscanTx(BASE.mint.txHash)} label="the real mint's transaction" cls="addr--tx" />
      </p>
    </section>
  );
}

export function LabView({ route }: { route: Route }) {
  const s = useBox(lab);
  const narrow = useNarrow();
  const [ranAll, setRanAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const scrollPart = useRef<Part | null>(null);

  // Deep link: #/lab?a=<signature|header|proof|amount|recipient|replay>.
  const query = route.q.toString();
  useEffect(() => {
    const want = new URLSearchParams(query).get("a");
    const row = ROWS.find((r) => r.a.part === want);
    if (row) setLab({ sel: row.a.part });
  }, [query]);

  useEffect(
    () => () => {
      visit++;
    },
    [],
  );

  // Phones: the detail opens under the tapped attack, so that attack comes to the top once it has moved.
  useEffect(() => {
    const part = scrollPart.current;
    if (!part) return;
    scrollPart.current = null;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.current?.querySelector(`[data-attack="${part}"]`)?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  });

  const sel = ROWS.find((r) => r.a.part === s.sel) ?? ROWS[0];
  const count = s.running ? ROWS.filter((r) => s.live[r.a.part]?.result?.reverted).length : REVERTED;

  const pick = (part: Part) => {
    if (narrow) scrollPart.current = part;
    setLab({ sel: part });
  };

  // Wide: a listbox, moved through with the arrow keys.
  const onListKey = (e: KeyboardEvent) => {
    if (narrow || !sel || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const i = ROWS.indexOf(sel);
    const next = ROWS[(i + (e.key === "ArrowDown" ? 1 : N - 1)) % N];
    if (!next) return;
    setLab({ sel: next.a.part });
    list.current?.querySelector<HTMLElement>(`[data-attack="${next.a.part}"]`)?.focus();
  };

  const detail = sel ? <Detail r={sel} live={s.live[sel.a.part]} /> : null;

  return (
    <div class="page page--lab">
      <header class="labhero">
        <div class="labhero__text">
          <p class="eyebrow page__eyebrow">Attack lab · recorded on Sepolia{DAY ? `, ${DAY}` : ""}</p>
          <h1 class="page__title labhero__title">
            {cap(word(N))} ways to cheat the mint.
            <br />
            <span class="labhero__grad">{cap(word(N))} reverts, on chain.</span>
          </h1>
          <p class="page__lead">
            Each attack is the real mint of lock {LOCK} with one thing changed, sent to BridgeMinter on Sepolia{DAY ? ` on ${DAY}` : ""}. Each one reverted with
            the error that names what was wrong. Check any of them again now: your browser sends the same call as a read. Nothing is signed.
          </p>
        </div>
        <div class="labhero__stat">
          <div class="labstat">
            <span class="labstat__num">
              <span id="lab-count">{count}</span>
              <span class="labstat__of">/{N}</span>
            </span>
            <span class="labstat__label">reverted on chain</span>
          </div>
          <button
            class={`btn btn--primary btn--lg${s.running ? " is-loading" : ""}`}
            type="button"
            id="lab-all"
            disabled={s.running}
            aria-busy={s.running ? "true" : undefined}
            onClick={() => {
              void runAll().then((done) => {
                if (done) setRanAll(true);
              });
            }}
          >
            <Icon id={ranAll ? "i-refresh" : "i-play"} />
            <span>{ranAll ? `Check all ${word(N)} again` : `Check all ${word(N)} live`}</span>
          </button>
          <p class="labhero__note">
            eth_call to <span class="mono">{shortAddr(MINTER)}</span> · free, no wallet
          </p>
          <a class="labhero__evidence" href={`${REPO}#evidence`} target="_blank" rel="noopener">
            <span class="labhero__ev1">
              {TXS} numbered transactions on V3 and{" "}
              <span class="nowrap">
                Sepolia
                <Icon id="i-arrow-right" cls="i--14" />
              </span>
            </span>
            <span class="labhero__ev2">
              {TEST_LINE.map(([n, what], i) => (
                <Fragment key={what}>
                  {i ? " · " : ""}
                  <span class="nowrap">
                    {num(n)} {what}
                  </span>
                </Fragment>
              ))}
            </span>
          </a>
        </div>
      </header>

      <div class="labgrid">
        <div class="alist2" id="lab-list" ref={list} role={narrow ? undefined : "listbox"} aria-label={narrow ? undefined : "Attacks"} onKeyDown={onListKey}>
          {ROWS.map((r, i) => {
            const on = r === sel;
            const l = s.live[r.a.part];
            const res = l?.result ?? null;
            const held = !!res && !res.reverted;
            return (
              <Fragment key={r.a.part}>
                <button
                  class={`atk${on ? " is-on" : ""}`}
                  type="button"
                  role={narrow ? undefined : "option"}
                  aria-selected={narrow ? undefined : on}
                  tabIndex={narrow ? undefined : on ? 0 : -1}
                  aria-expanded={narrow ? on : undefined}
                  aria-controls={narrow ? "lab-detail" : undefined}
                  data-attack={r.a.part}
                  onClick={() => pick(r.a.part)}
                >
                  <span class="atk__n mono">{String(i + 1).padStart(2, "0")}</span>
                  <span class="atk__main">
                    <span class="atk__title">{r.title}</span>
                    <span class="atk__meta">Caught by: {CHECKS.find((k) => k.key === r.copy.check)?.short}</span>
                  </span>
                  <span class="atk__state">
                    {l?.busy ? (
                      <>
                        <span class="tl__spin" aria-hidden="true" />
                        <span class="visually-hidden">Checking</span>
                      </>
                    ) : (
                      <span class="atk__rev">
                        <Icon id={held ? "i-alert" : "i-x-circle"} cls="i--14" />
                        <span>
                          {held ? "Did not revert" : "Reverted"}
                          {res ? <span class="atk__now"> · now</span> : null}
                        </span>
                      </span>
                    )}
                    {narrow ? <Icon id="i-chevron-down" cls="i--16 atk__chev" /> : null}
                  </span>
                </button>
                {narrow && on ? detail : null}
              </Fragment>
            );
          })}
        </div>
        {narrow ? null : detail}
      </div>
    </div>
  );
}
