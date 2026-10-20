import { Check, External } from "../components/icons.tsx";
import { Hash, SectionHead, SourceLine, StatusBadge } from "../components/ui.tsx";
import { DECIMALS, etherscanAddress, etherscanBlock, etherscanTx, HERO_TX, LC, MINTER, records, TOKEN, TX_GAS_CAP, VAULT } from "../lib/chains.ts";
import { formatInt, formatUnits, percent } from "../lib/format.ts";
import type { AbiValue, DecodedArg, DecodedLog } from "../lib/abi.ts";
import { useField } from "../lib/live.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

const NAMES: Record<string, string> = {
  [LC.v3.address]: "GrandpaLightClient #2",
  [LC.mainnet.address]: "GrandpaLightClient #1",
  [MINTER]: "BridgeMinter",
  [TOKEN]: "WrappedTPOT",
  [VAULT]: "PortaldotVault (V3)",
  [records.bridge.lock.recipient]: "lock 0's recipient",
  [ZERO]: "the zero address",
};

const nameOf = (a: string) => NAMES[a.toLowerCase()];

function argValue(log: DecodedLog, a: DecodedArg) {
  const v = a.value;
  if (a.type === "address" && typeof v === "string") {
    const n = nameOf(v);
    // The vault is a V3 address: Sepolia's explorer has nothing at it, so it is not linked there.
    const lower = v.toLowerCase();
    return (
      <span class="argv">
        <Hash value={v} href={lower === ZERO || lower === VAULT ? undefined : etherscanAddress(v)} head={4} tail={4} label={a.name} />
        {n && <span class="dim small">{n}</span>}
      </span>
    );
  }
  if (a.type === "bytes32" && typeof v === "string") return <Hash value={v} head={8} tail={6} label={a.name} />;
  if (typeof v === "bigint") {
    const isAmount = (log.name === "Transfer" && a.name === "value") || (log.name === "Minted" && a.name === "amount");
    return (
      <span class="argv">
        <span class="num">{formatInt(v)}</span>
        {isAmount && <span class="dim small">{formatUnits(v, DECIMALS)} wtPOT</span>}
        {log.name === "HeaderImported" && a.name === "number" && <span class="dim small">V3 block</span>}
      </span>
    );
  }
  return <span class="num">{String(v as AbiValue)}</span>;
}

function get(log: DecodedLog, name: string): AbiValue | undefined {
  return log.args.find((a) => a.name === name)?.value;
}

function proves(log: DecodedLog): string {
  switch (log.name) {
    case "HeaderImported":
      return `V3 block #${formatInt(get(log, "number") as bigint)} is final: ${get(log, "signatures")} validators of set ${get(log, "setId")} signed it, and the light client checked each signature and the header's hash before it stored the block's state root.`;
    case "VaultBound":
      return "The minter proved the vault's Revive.AccountInfoOf entry under that state root: a contract with the vault's code hash. It stored the vault's trie id, once, for every later mint.";
    case "Transfer":
      return `${formatUnits(get(log, "value") as bigint, DECIMALS)} wtPOT created, from the zero address. Only the minter can mint wtPOT.`;
    case "Minted":
      return `Lock ${get(log, "nonce")} is minted to the recipient its proven commitment names, and nonce ${get(log, "nonce")} is used: the same proof sent again reverts (row 38).`;
    default:
      return "";
  }
}

export function Receipt() {
  const r = useField("receipt.hero");
  const v = r.value;
  return (
    <section id="receipt" class="section section--alt" aria-labelledby="receipt-title">
      <div class="container">
        <SectionHead
          id="receipt"
          n="02"
          eyebrow="Proof receipt"
          title={
            <>
              One transaction, four events. <em>Each one a check that passed.</em>
            </>
          }
          lead={`Row ${records.bridge.row} of the evidence table, decoded from its receipt with the event signatures in the contract sources. The contracts write an event only after the check it reports.`}
        />
        <div class="receipt reveal">
          <aside class="receipt__card card" aria-label="The transaction">
            <div class="receipt__perf" aria-hidden="true" />
            <header class="receipt__head">
              <span class="micro">Sepolia transaction</span>
              <StatusBadge field={r} />
            </header>
            <div class={`receipt__status ${v && v.status === 1 ? "is-ok" : ""}`}>
              {v ? (
                v.status === 1 ? (
                  <>
                    <Check /> Success
                  </>
                ) : (
                  "Reverted"
                )
              ) : (
                <span class="skel" style={{ width: "9ch" }} />
              )}
              <span class="dim small">row {records.bridge.row}</span>
            </div>
            <dl class="kv receipt__kv">
              <dt>Hash</dt>
              <dd>
                <Hash value={HERO_TX} href={etherscanTx(HERO_TX)} head={10} tail={8} label="transaction hash" />
              </dd>
              <dt>Block</dt>
              <dd>{v ? <a class="link num" href={etherscanBlock(v.blockNumber)} target="_blank" rel="noopener noreferrer">#{formatInt(v.blockNumber)}</a> : <span class="skel" />}</dd>
              <dt>From</dt>
              <dd>{v ? <Hash value={v.from} href={etherscanAddress(v.from)} head={4} tail={4} label="sender" /> : <span class="skel" />}</dd>
              <dt>To</dt>
              <dd>
                {v ? (
                  <span class="argv">
                    <Hash value={v.to} href={etherscanAddress(v.to)} head={4} tail={4} label="contract" />
                    <span class="dim small">{nameOf(v.to) ?? ""}.importAndMint</span>
                  </span>
                ) : (
                  <span class="skel" />
                )}
              </dd>
              <dt>Gas used</dt>
              <dd>
                {v ? (
                  <span class="gasline">
                    <span class="num">{formatInt(v.gasUsed)}</span>
                    <span class="gasbar" aria-hidden="true">
                      <span style={{ width: percent(v.gasUsed, TX_GAS_CAP, 2) }} />
                    </span>
                    <span class="dim small">{percent(v.gasUsed, TX_GAS_CAP)} of the per-transaction cap</span>
                  </span>
                ) : (
                  <span class="skel" />
                )}
              </dd>
              <dt>Gas price</dt>
              <dd>{v && v.effectiveGasPrice !== null ? <span class="num">{formatInt(v.effectiveGasPrice)} wei</span> : <span class="dim">—</span>}</dd>
            </dl>
            <a class="btn btn--ghost btn--sm receipt__ext" href={etherscanTx(HERO_TX)} target="_blank" rel="noopener noreferrer">
              Open on Etherscan <External />
            </a>
            <SourceLine field={r} live="eth_getTransactionReceipt" />
          </aside>
          <ol class="events" aria-label="The transaction's events">
            {v
              ? v.logs.map((log, i) => (
                  <li class="event card spot" key={i}>
                    <header class="event__head">
                      <span class="event__idx num">{i}</span>
                      <span class="event__name">{log.name}</span>
                      <span class="event__from small dim">
                        emitted by {nameOf(log.address) ?? "a contract"} <Hash value={log.address} href={etherscanAddress(log.address)} head={4} tail={4} label="emitter" copy={false} />
                      </span>
                    </header>
                    <dl class="event__args">
                      {log.args.map((a) => (
                        <div class="event__arg" key={a.name}>
                          <dt>
                            <span class="mono">{a.name}</span> <span class="dim">{a.type}</span>
                          </dt>
                          <dd>{argValue(log, a)}</dd>
                        </div>
                      ))}
                    </dl>
                    <p class="event__proves">
                      <Check />
                      <span>{proves(log)}</span>
                    </p>
                  </li>
                ))
              : [0, 1, 2, 3].map((i) => (
                  <li class="event card event--skel" key={i} aria-hidden="true">
                    <span class="skel" style={{ width: "40%" }} />
                    <span class="skel" style={{ width: "80%" }} />
                    <span class="skel" style={{ width: "65%" }} />
                  </li>
                ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
