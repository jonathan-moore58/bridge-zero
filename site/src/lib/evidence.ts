// The chains the README's evidence rows are on, in one table for the build's parser
// (build/records.ts, parseEvidence) and the status page's list (sections/Verify.tsx): each chain's
// word in the README's Block column and the explorer its rows link to. A row on an EVM chain links
// its transaction on that chain's explorer; a V3 row prints a shortened hash and links its block on
// the Node Console, as no indexed explorer for the V3 testnet was found. Apart from the build's
// records, so that the tests import it.

import { shortHex } from "./hex.ts";
import type { EvidenceRow } from "./records-types.ts";

export type EvidenceChain = EvidenceRow["chain"];

export interface EvidenceChainInfo {
  /** The chain's name: "Base Sepolia". */
  name: string;
  /** In running text, as the README counts the rows: "22 on V3, 24 on Base Sepolia". */
  short: string;
  /** Its word in the README's Block column: "Base 50,885,111", "V3 #173,057". */
  word: string;
  /** Where its rows link: an EVM chain's transactions, V3's blocks. */
  explorer: string;
}

/**
 * In the order the evidence starts on each: Sepolia, V3, then the rollups. And the BNB Smart Chain
 * testnet, whose rows the README has once its first round trip is recorded (hidden in the app until
 * then: ../app/dests.ts, HIDDEN); a chain with no row is not counted.
 */
export const EVIDENCE_CHAINS: Readonly<Record<EvidenceChain, EvidenceChainInfo>> = {
  sepolia: { name: "Sepolia", short: "Sepolia", word: "Sepolia", explorer: "https://sepolia.etherscan.io" },
  v3: { name: "Portaldot V3 testnet", short: "V3", word: "V3", explorer: "https://node-console.portaldot.dev" },
  "base-sepolia": { name: "Base Sepolia", short: "Base Sepolia", word: "Base", explorer: "https://sepolia.basescan.org" },
  "arbitrum-sepolia": { name: "Arbitrum Sepolia", short: "Arbitrum Sepolia", word: "Arbitrum", explorer: "https://sepolia.arbiscan.io" },
  "bsc-testnet": { name: "BNB Smart Chain testnet", short: "BNB Smart Chain testnet", word: "BSC", explorer: "https://testnet.bscscan.com" },
};

/** How many rows are on each chain, as the README counts them: "58 on Sepolia, 22 on V3, 24 on Base Sepolia and 24 on Arbitrum Sepolia". */
export function perChain(rows: readonly Pick<EvidenceRow, "chain">[]): string {
  const parts = (Object.keys(EVIDENCE_CHAINS) as EvidenceChain[]).flatMap((c) => {
    const n = rows.filter((r) => r.chain === c).length;
    return n > 0 ? [`${n.toLocaleString("en-US")} on ${EVIDENCE_CHAINS[c].short}`] : [];
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

/** The chains whose rows link their transaction: every one but V3. */
export const EVM_EVIDENCE_CHAINS = (Object.keys(EVIDENCE_CHAINS) as EvidenceChain[]).filter((c) => c !== "v3") as Exclude<EvidenceChain, "v3">[];

/** The chain a Block cell's word names ("Base 50,885,111"), or null for a cell that names none (the first Sepolia rows). */
export function chainOfWord(blockCell: string): EvidenceChain | null {
  const word = /\b(V3|Sepolia|Base|Arbitrum|BSC)\b/.exec(blockCell)?.[1];
  return (Object.keys(EVIDENCE_CHAINS) as EvidenceChain[]).find((c) => EVIDENCE_CHAINS[c].word === word) ?? null;
}

/** A transaction on an EVM chain's explorer. */
export const evidenceTxUrl = (chain: Exclude<EvidenceChain, "v3">, tx: string): string => `${EVIDENCE_CHAINS[chain].explorer}/tx/${tx}`;

/** A line of a row's transaction cell: its text, the page it opens if it is a link, and its tooltip. */
export interface CellLine {
  text: string;
  href: string | null;
  title: string;
}

/**
 * How the status page shows a row's transaction: where it is (the chain's word and the block) over
 * its hash, one of the two linked to the page that shows what it names.
 */
export interface EvidenceCell {
  where: CellLine;
  hash: CellLine;
}

/** "0x6b06421f…dd04ba45", a hash as the README prints it, the way the list shortens a full one: "0x6b0642…ba45". */
function shortPrinted(printed: string): string {
  const m = /^0x([0-9a-fA-F]+)…([0-9a-fA-F]+)$/.exec(printed);
  return m && (m[1] ?? "").length >= 6 && (m[2] ?? "").length >= 4 ? `0x${(m[1] ?? "").slice(0, 6)}…${(m[2] ?? "").slice(-4)}` : printed;
}

/**
 * A row's transaction cell. An EVM row: its chain and block, and its hash linked on the chain's
 * explorer. A V3 row: its block linked on the Node Console, which shows the block, and its hash
 * under it, not linked, as for a transaction sent through V3's EVM RPC the README prints its
 * Ethereum hash, not its extrinsic's; its tooltip is the hash in full where deployments/ records
 * it, else says that no record does.
 */
export function evidenceCell(r: Pick<EvidenceRow, "chain" | "tx" | "txText" | "block" | "blockUrl">): EvidenceCell {
  const c = EVIDENCE_CHAINS[r.chain];
  const block = r.block.toLocaleString("en-US");
  const text = r.tx ? shortHex(r.tx, 6, 4) : shortPrinted(r.txText);
  if (r.chain === "v3") {
    return {
      where: { text: `${c.word} #${block}`, href: r.blockUrl, title: `We found no indexed explorer for the V3 testnet: the Node Console shows block #${block}.` },
      hash: { text, href: null, title: r.tx ?? "No record in deployments/ holds this hash in full: the README prints it shortened." },
    };
  }
  return {
    where: { text: `${c.word} ${block}`, href: null, title: c.name },
    hash: { text, href: r.tx ? evidenceTxUrl(r.chain, r.tx) : null, title: `${c.name}, block ${block}` },
  };
}
