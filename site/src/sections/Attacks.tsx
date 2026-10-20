import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Check, Coins, HashSign, Play, Replay, Signature, Tree, User } from "../components/icons.tsx";
import { ExtLink, Hash, SectionHead, When } from "../components/ui.tsx";
import { etherscanBlock, etherscanTx, records } from "../lib/chains.ts";
import { formatInt } from "../lib/format.ts";
import { formatError, type DecodedError } from "../lib/abi.ts";
import { shortHex } from "../lib/hex.ts";
import { checkAttack, registry, type AttackCheck } from "../lib/live.ts";
import type { Attack } from "../lib/records-types.ts";

const COPY: Record<Attack["part"], { title: string; icon: ComponentChildren; why: string }> = {
  signature: {
    title: "Flip a signature byte",
    icon: <Signature />,
    why: "The light client rebuilds the message each validator signed and checks the ed25519 signature against the key it holds. One changed byte and the first signature fails.",
  },
  header: {
    title: "Flip a header byte",
    icon: <HashSign />,
    why: "A changed state root changes the header's blake2b hash, so the header is no longer the block the validators signed.",
  },
  proof: {
    title: "Flip a storage-proof byte",
    icon: <Tree />,
    why: "Every proof item is found by its hash on the walk from the state root. A changed item has another hash, and the walk cannot complete.",
  },
  amount: {
    title: "Claim 1,000 wtPOT",
    icon: <Coins />,
    why: "The minter recomputes the commitment from the amount it is given. The proven word is the commitment of 1 wtPOT, not of 1,000.",
  },
  recipient: {
    title: "Mint to another recipient",
    icon: <User />,
    why: "The recipient is inside the commitment too. Another address gives another word than the one the vault stored.",
  },
  replay: {
    title: "Send it again",
    icon: <Replay />,
    why: "The valid mint, unchanged. Every proof still holds, so it gets as far as the replay guard: nonce 0 is used.",
  },
};

type Live = { state: "idle" } | { state: "busy" } | { state: "done"; result: AttackCheck } | { state: "failed"; error: string };

function decodedText(d: DecodedError | null, data: string | null): string {
  if (d) return formatError(d, (h) => (h.length > 20 ? shortHex(h, 8, 8) : h));
  return data ? `unknown error ${data.slice(0, 10)}` : "reverted without data";
}

function Result({ live, attack }: { live: Live; attack: Attack }) {
  if (live.state === "idle") return null;
  if (live.state === "busy")
    return (
      <p class="attack__result is-busy" role="status">
        <span class="spinner" aria-hidden="true" /> Fetching the transaction's input, then calling BridgeMinter with it…
      </p>
    );
  if (live.state === "failed")
    return (
      <div class="attack__result is-fail" role="status">
        <p>No Sepolia node answered, so it could not be called again just now; the revert above is the recorded transaction's.</p>
        <p class="attack__why small">{live.error}</p>
      </div>
    );
  const r = live.result;
  if (!r.reverted)
    return (
      <p class="attack__result is-fail" role="status">
        The call did not revert at block #{formatInt(r.block)}. That would be a failure of the contract; please report it.
      </p>
    );
  return (
    <div class="attack__result is-ok" role="status">
      <p class="attack__refused">
        <Check class="inline-check" />
        <span>
          Refused just now,{" "}
          <span class="nowrap">
            at Sepolia block <span class="num">#{formatInt(r.block)}</span>
          </span>
        </span>
      </p>
      {r.sameAsRecord ? null : <code class="attack__err">{decodedText(r.decoded, r.data)}</code>}
      <p class="small dim">
        {r.sameAsRecord ? "the same revert data, byte for byte, as the recorded transaction" : `the recorded transaction reverted with ${attack.expectedRevert.name}`} · eth_call via{" "}
        {r.endpoint}
      </p>
    </div>
  );
}

function AttackCard({ a, live, onCheck }: { a: Attack; live: Live; onCheck: () => void }) {
  const c = COPY[a.part];
  const recorded = registry.decodeError(a.expectedRevert.data);
  return (
    <article class={`attack card spot ${live.state === "done" ? "is-checked" : ""}`} aria-labelledby={`atk-${a.part}`}>
      <header class="attack__head">
        <span class="attack__icon">{c.icon}</span>
        <span class="attack__row micro">row {a.row ?? "?"}</span>
      </header>
      <h3 class="h3" id={`atk-${a.part}`}>
        {c.title}
      </h3>
      <p class="attack__what small">
        <span class="dim">{a.part === "replay" ? "Sent:" : "Changed:"}</span> {a.what}
      </p>
      <p class="attack__why small muted">{c.why}</p>
      <div class="attack__rec">
        <div class="attack__recline">
          <span class="badge badge--revert">reverted</span>
          <code class="attack__err">{decodedText(recorded, a.expectedRevert.data)}</code>
        </div>
        <p class="small dim">
          <Hash value={a.txHash} href={etherscanTx(a.txHash)} head={6} tail={4} label="transaction hash" /> · block{" "}
          <ExtLink href={etherscanBlock(a.block ?? 0)}>
            <span class="num">#{formatInt(a.block ?? 0)}</span>
          </ExtLink>{" "}
          · <span class="num">{formatInt(a.gasUsed ?? 0)}</span> gas
          {a.signedAt ? (
            <>
              {" "}
              · <When iso={a.signedAt} />
            </>
          ) : null}
        </p>
      </div>
      <div class="attack__live">
        <button type="button" class="btn btn--ghost btn--sm" onClick={onCheck} disabled={live.state === "busy"} aria-busy={live.state === "busy"}>
          <Play />
          {live.state === "done" ? "Check again" : "Check it live"}
        </button>
        <Result live={live} attack={a} />
      </div>
    </article>
  );
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number) => WORDS[n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function Attacks() {
  const attacks = records.attacks;
  const tampered = attacks.filter((a) => a.part !== "replay").length;
  const [live, setLive] = useState<Record<string, Live>>({});
  const run = async (a: Attack) => {
    setLive((s) => ({ ...s, [a.part]: { state: "busy" } }));
    try {
      const result = await checkAttack(a);
      setLive((s) => ({ ...s, [a.part]: { state: "done", result } }));
    } catch (error) {
      setLive((s) => ({ ...s, [a.part]: { state: "failed", error: (error as Error).message } }));
    }
  };
  const runAll = () => {
    for (const a of attacks) void run(a);
  };
  const doneCount = attacks.filter((a) => live[a.part]?.state === "done").length;
  const refused = attacks.filter((a) => {
    const l = live[a.part];
    return l?.state === "done" && l.result.reverted;
  }).length;
  return (
    <section id="break" class="section" aria-labelledby="break-title">
      <div class="container">
        <SectionHead
          id="break"
          n="03"
          eyebrow="Try to break it"
          title={
            <>
              Change one thing, and it reverts. <em>Check it now, from this page.</em>
            </>
          }
          lead={`${cap(word(tampered))} cop${tampered === 1 ? "y" : "ies"} of the mint with one part changed, and the mint sent again: all ${word(attacks.length)} reverted on Sepolia (rows ${attacks[0]?.row} to ${attacks.at(-1)?.row}). "Check it live" calls BridgeMinter with the same input now, read-only.`}
        >
          <div class="shead__actions">
            <button type="button" class="btn btn--primary" onClick={runAll}>
              <Play />
              Check all {attacks.length} live
            </button>
            {doneCount > 0 && (
              <p class="small muted" role="status">
                {refused} of {attacks.length} refused just now{doneCount < attacks.length ? `, ${attacks.length - doneCount} running` : ""}.
              </p>
            )}
          </div>
        </SectionHead>
        <div class="attacks">
          {attacks.map((a) => (
            <AttackCard key={a.part} a={a} live={live[a.part] ?? { state: "idle" }} onCheck={() => void run(a)} />
          ))}
        </div>
        <p class="small dim attacks__note">
          The calls use each transaction's own sender, input and gas limit, and run on a public Sepolia node with eth_call: nothing is signed or sent. The errors are decoded with the
          error signatures in the contract sources; <code class="inline">Incomplete Proof!</code> is the trie walk's own revert reason.
        </p>
      </div>
    </section>
  );
}
