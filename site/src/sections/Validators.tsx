import { useMemo, useState } from "preact/hooks";
import { Check, Signature } from "../components/icons.tsx";
import { Chain, ExtLink, Hash, SectionHead, SourceLine, StatusBadge } from "../components/ui.tsx";
import { etherscanAddress, etherscanTx, LC, portalscanBlock } from "../lib/chains.ts";
import { formatInt } from "../lib/format.ts";
import type { Hex } from "../lib/hex.ts";
import { checkSignatures, useField, type CountedSignature, type SignatureCheck } from "../lib/live.ts";
import { ss58 } from "../lib/ss58.ts";

const shortSs58 = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;

function safeSs58(key: Hex, prefix: number): string {
  try {
    return ss58(key, prefix);
  } catch {
    return "";
  }
}

/** The authority ring: one node per key, the counted signers lit. */
function AuthorityRing({ keys, counted, threshold, focus, onFocus }: { keys: Hex[]; counted: CountedSignature[]; threshold: number | null; focus: number | null; onFocus: (i: number | null) => void }) {
  const n = keys.length;
  const signed = new Map(counted.map((c) => [c.authorityIndex, c]));
  const R = 168;
  const pos = (i: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return { x: 220 + R * Math.cos(a), y: 220 + R * Math.sin(a) };
  };
  return (
    <figure class="aring">
      <svg viewBox="0 0 440 440" class="aring__svg" role="img" aria-label={`${counted.length} of ${n} validators' signatures counted in the latest import`}>
        <circle cx="220" cy="220" r={R} class="aring__orbit" />
        <circle cx="220" cy="220" r="118" class="aring__inner" />
        {keys.map((_, i) => {
          if (!signed.has(i)) return null;
          const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
          return (
            <line
              key={`l${i}`}
              x1={220 + 120 * Math.cos(a)}
              y1={220 + 120 * Math.sin(a)}
              x2={220 + (R - 26) * Math.cos(a)}
              y2={220 + (R - 26) * Math.sin(a)}
              class={`aring__spoke ${focus === i ? "is-focus" : ""}`}
            />
          );
        })}
        {keys.map((k, i) => {
          const p = pos(i);
          const on = signed.has(i);
          return (
            <g
              key={k}
              class={`aring__node ${on ? "is-on" : ""} ${focus === i ? "is-focus" : ""}`}
              transform={`translate(${p.x} ${p.y})`}
              onMouseEnter={() => onFocus(i)}
              onMouseLeave={() => onFocus(null)}
            >
              <circle r="25" class="aring__disc" />
              <text class="aring__idx" text-anchor="middle" dy="0.35em">
                {i}
              </text>
              {on && <circle r="31" class="aring__halo" />}
            </g>
          );
        })}
        <text x="220" y="206" text-anchor="middle" class="aring__big">
          {counted.length ? `${counted.length} / ${n}` : `${n}`}
        </text>
        <text x="220" y="240" text-anchor="middle" class="aring__cap">
          {counted.length ? "signatures counted" : "validators"}
        </text>
        {threshold !== null && (
          <text x="220" y="262" text-anchor="middle" class="aring__cap aring__cap--dim">
            threshold {threshold}
          </text>
        )}
      </svg>
    </figure>
  );
}

export function Validators() {
  const set = useField("set.mainnet");
  const lc = useField("lc.mainnet");
  const imp = useField("import.mainnet");
  const v3set = useField("set.v3");
  const [focus, setFocus] = useState<number | null>(null);
  const [checks, setChecks] = useState<SignatureCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = set.value?.keys ?? [];
  const view = imp.value;
  const counted = view?.counted ?? [];
  const decoded = !!view?.decoded;
  const byIndex = useMemo(() => new Map(counted.map((c) => [c.authorityIndex, c])), [counted]);
  const checkByIndex = new Map((checks ?? []).map((c) => [c.authorityIndex, c]));
  const signingKeys = view?.signingKeys ?? (view && set.value && view.setId === set.value.setId ? set.value.keys : null);
  const prefix = LC.mainnet.ss58Prefix;

  const verify = async () => {
    if (!view || view.round === null || !signingKeys) return;
    setBusy(true);
    setError(null);
    try {
      setChecks(await checkSignatures(view.counted, signingKeys, view.round, view.setId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="validators" class="section section--alt" aria-labelledby="validators-title">
      <div class="container">
        <SectionHead
          id="validators"
          n="04"
          eyebrow="A real validator set"
          title={
            <>
              Ten validators, seven signatures. <em>Checked on chain at every import.</em>
            </>
          }
          lead="The V3 testnet has 2 validators, probably development keys. The same light client code follows the old Portaldot mainnet, whose 10 validators are a real set: every import there needs 7 of their signatures."
        />
        <div class="vset reveal">
          <div class="vset__ring card">
            <header class="vset__head">
              <Chain which="mainnet" />
              <StatusBadge field={set} />
            </header>
            <AuthorityRing keys={keys} counted={counted} threshold={lc.value?.threshold ?? null} focus={focus} onFocus={setFocus} />
            <p class="small dim vset__legend">
              <span>
                <span class="dot dot--on" />
                counted in the latest import
              </span>
              <span>
                <span class="dot" />
                not counted
              </span>
            </p>
          </div>
          <div class="vset__info">
            <dl class="kv">
              <dt>Light client</dt>
              <dd>
                {LC.mainnet.name} <Hash value={LC.mainnet.address} href={etherscanAddress(LC.mainnet.address)} head={4} tail={4} label="light client address" />
              </dd>
              <dt>Current set</dt>
              <dd>
                {set.value ? (
                  <>
                    set <span class="num">{String(set.value.setId)}</span>, <span class="num">{set.value.keys.length}</span> keys
                    {lc.value ? (
                      <>
                        , <span class="num">{lc.value.threshold}</span> signatures needed
                      </>
                    ) : null}
                    {set.status === "recorded" && <span class="dim small"> (recorded: {set.from}; the old mainnet's set ids move on with the same 10 keys)</span>}
                  </>
                ) : (
                  <span class="skel" />
                )}
              </dd>
              <dt>Latest import</dt>
              <dd>
                {view ? (
                  <>
                    old-mainnet block{" "}
                    <ExtLink href={portalscanBlock(view.number)}>
                      <span class="num">#{formatInt(view.number)}</span>
                    </ExtLink>{" "}
                    {view.method && <code class="inline">{view.method}</code>}
                    <br />
                    <Hash value={view.txHash} href={etherscanTx(view.txHash)} head={6} tail={4} label="import transaction" />
                    {view.sepoliaBlock !== null && (
                      <span class="dim small">
                        {" "}
                        Sepolia block <span class="num">#{formatInt(view.sepoliaBlock)}</span>
                      </span>
                    )}
                  </>
                ) : (
                  <span class="skel" />
                )}
              </dd>
              <dt>Signed under</dt>
              <dd>
                {view ? (
                  <>
                    set <span class="num">{String(view.setId)}</span>
                    {view.round !== null && (
                      <>
                        , round <span class="num">{formatInt(view.round)}</span>
                      </>
                    )}
                    {view.precommitCount !== null && (
                      <span class="dim small">
                        {" "}
                        · the justification holds {view.precommitCount} precommits; the hint counts {view.counted.length}
                      </span>
                    )}
                  </>
                ) : (
                  <span class="skel" />
                )}
              </dd>
            </dl>
            <div class="authtable" role="table" aria-label="The validator set and who was counted">
              <div class="authtable__row authtable__row--head" role="row">
                <span role="columnheader">#</span>
                <span role="columnheader">Key</span>
                <span role="columnheader">SS58</span>
                <span role="columnheader">Latest import</span>
              </div>
              {keys.map((k, i) => {
                const c = byIndex.get(i);
                const res = checkByIndex.get(i);
                return (
                  <div
                    class={`authtable__row ${c ? "is-on" : ""} ${focus === i ? "is-focus" : ""}`}
                    role="row"
                    key={k}
                    onMouseEnter={() => setFocus(i)}
                    onMouseLeave={() => setFocus(null)}
                  >
                    <span role="cell" class="num">
                      {i}
                    </span>
                    <span role="cell">
                      <Hash value={k} head={6} tail={4} label={`key ${i}`} />
                    </span>
                    <span role="cell" class="mono small dim" title={safeSs58(k, prefix)}>
                      {shortSs58(safeSs58(k, prefix))}
                    </span>
                    <span role="cell">
                      {!decoded ? (
                        <span class="dim small">—</span>
                      ) : c ? (
                        res ? (
                          res.valid && res.keyMatches ? (
                            <span class="badge badge--verify">
                              <Check /> valid here
                            </span>
                          ) : (
                            <span class="badge badge--revert">invalid</span>
                          )
                        ) : (
                          <span class="ok-text small">
                            <Check /> <span class="hide-sm">counted,</span> precommit {c.position}
                          </span>
                        )
                      ) : (
                        <span class="dim small">not counted</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div class="vset__actions">
              <button type="button" class="btn btn--ghost btn--sm" onClick={verify} disabled={busy || !view?.decoded || !signingKeys} aria-busy={busy}>
                <Signature />
                {busy ? "Checking…" : `Check the ${counted.length || "counted"} signatures in this browser`}
              </button>
              {view?.decoded && (
                <span class="small dim">
                  hint <code class="inline">{hintHex(view.counted)}</code>: 2 bytes per counted precommit, its position then the validator's index
                </span>
              )}
            </div>
            {checks && (
              <p class="small muted" role="status">
                ed25519 in this browser (@noble/curves): {checks.filter((c) => c.valid && c.keyMatches).length} of {checks.length} signatures valid for set {String(view?.setId)}'s keys,
                over the message each precommit signs.
              </p>
            )}
            {error && <p class="small bad-text">{error}</p>}
            {view && !decoded && (
              <p class="small dim" role="status">
                The latest import's calldata could not be read just now, so its signers are not shown. It carried {view.signatures} signatures under set{" "}
                {String(view.setId)}, by {view.foundBy === "log" ? "its HeaderImported log" : "the relayer's record"}.
              </p>
            )}
            {view?.note && <p class="small dim">{view.note}</p>}
            <SourceLine field={imp} live={imp.value?.foundBy === "record" ? "transaction from the relayer's record, calldata live" : "found by its HeaderImported log, calldata live"} />
          </div>
        </div>
        <aside class="v3note card reveal" aria-label="The V3 testnet's validators">
          <div class="v3note__text">
            <Chain which="v3" />
            <h3 class="h3">
              {v3set.value ? `${v3set.value.keys.length} validators` : "The V3 validators"}, both needed. <em>Probably development keys.</em>
              <span class="badge badge--trust">trusted</span>
            </h3>
            <p class="small muted">
              The V3 testnet finalizes with {v3set.value?.keys.length ?? 2} GRANDPA validators, and every V3 block the bridge uses carries both of their signatures. They are
              probably development keys, as the README says; the repository's node probe flags a set of only 2 (neither key is //Alice). So the V3 path shows the mechanics,
              and the 10 keys above are the old mainnet's real validator set, checked by the same contract code.
            </p>
          </div>
          <ul class="v3note__keys">
            {(v3set.value?.keys ?? []).map((k, i) => (
              <li key={k}>
                <span class="micro">validator {i}</span>
                <Hash value={k} head={8} tail={6} label={`V3 key ${i}`} />
                <span class="mono small dim">{shortSs58(safeSs58(k, LC.v3.ss58Prefix))}</span>
              </li>
            ))}
            <li class="v3note__src">
              <StatusBadge field={v3set} /> <span class="source">authorities({v3set.value ? String(v3set.value.setId) : "set"}) on {LC.v3.name}</span>
            </li>
          </ul>
        </aside>
      </div>
    </section>
  );
}

function hintHex(counted: CountedSignature[]): string {
  return "0x" + counted.map((c) => c.position.toString(16).padStart(2, "0") + c.authorityIndex.toString(16).padStart(2, "0")).join("");
}
