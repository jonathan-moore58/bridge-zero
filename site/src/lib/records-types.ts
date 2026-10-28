// The shape of what build/records.ts reads from the repository at build time: deployments/,
// fixtures/, README.md and the contract sources. Every recorded value on the page comes from here.

export type Hex = `0x${string}`;

/** One row of the README's evidence tables. `what` and `result` keep their inline markdown. */
export interface EvidenceRow {
  n: number;
  what: string;
  chain: "sepolia" | "v3";
  /** The full transaction or extrinsic hash: from the Etherscan link, or matched in deployments/ for a V3 row. */
  tx: Hex | null;
  /** The hash as the README prints it. */
  txText: string;
  block: number;
  /** The block's link in the README (the Node Console for V3 rows), if any. */
  blockUrl: string | null;
  result: string;
  table: string;
}

/** A Sepolia transaction of deployments/sepolia-bridge.json. */
export interface RecordedTx {
  name: string;
  kind: string;
  txHash: Hex;
  block: number | null;
  gasUsed: number | null;
  gasLimit: number | null;
  status: number | null;
  sender: Hex;
  to: Hex;
  signedAt: string | null;
  effectiveGasPrice: string | null;
}

export interface Attack extends RecordedTx {
  part: "signature" | "header" | "proof" | "amount" | "recipient" | "replay";
  what: string;
  expectedRevert: { name: string; data: Hex };
  row: number | null;
}

export interface Precommit {
  /** Position in the justification. */
  position: number;
  authorityIndex: number;
  authorityId: Hex;
  signature: Hex;
  targetHash: Hex;
  targetNumber: number;
}

export interface BridgeRun {
  lock: {
    nonce: number;
    txHash: Hex;
    block: { number: number; hash: Hex };
    from: Hex;
    recipient: Hex;
    dstChainId: string;
    dstMinter: Hex;
    amountNative: string;
    /** EVM value sent, 18 decimals. */
    value: string;
    commitment: Hex;
    slot: Hex;
    /** What the lock cost its sender on V3, EVM units (18 decimals): storage deposit and fee. */
    cost: string;
    signedAt: string;
  };
  vault: {
    address: Hex;
    codeHash: Hex;
    runtimeBytes: number;
    deployBlock: { number: number; hash: Hex };
    extrinsicHash: Hex;
    deployer: string;
    releaser: Hex;
    nativeToEthRatio: string;
  };
  finality: {
    block: { number: number; hash: Hex; parentHash: Hex; stateRoot: Hex; extrinsicsRoot: Hex; headerBytes: number; scale: Hex };
    setId: number;
    round: number;
    precommits: Precommit[];
    signers: { hint: Hex; count: number; threshold: number };
    authorities: Hex[];
    finalityProofBytes: number;
    capturedAt: string;
  };
  proofs: {
    account: { key: Hex; keyBytes: number; valueBytes: number; trieId: Hex; codeHash: Hex; items: number; bytes: number };
    childRoot: { key: Hex; keyBytes: number; root: Hex; items: number; bytes: number };
    slot: { index: Hex; key: Hex; value: Hex; items: number; bytes: number };
  };
  mint: RecordedTx & { amountNative: string; recipient: Hex };
  bundleFile: string;
  row: number | null;
}

/** One transaction of the relayer's record (deployments/relay-sepolia-<sender>.jsonl). */
export interface RelayEntry {
  chain: "mainnet" | "v3";
  /** The address that sent it: its history file's name. */
  sender: Hex;
  client: Hex;
  method: string;
  block: { number: number; hash: Hex };
  setBefore: number;
  setAfter: number;
  signatures: number;
  txHash: Hex;
  sepoliaBlock: number | null;
  gasUsed: number | null;
  status: number | null;
  ok: boolean | null;
  settledAt: string | null;
}

export interface LightClientFacts {
  key: "mainnet" | "v3";
  name: string;
  address: Hex;
  /** The Sepolia block of its creation: where a search for its logs starts. */
  deployBlock: number;
  chain: string;
  substrateWs: string;
  substrateHttp: string | null;
  genesis: Hex;
  blockTimeSec: number;
  ss58Prefix: number;
  tokenSymbol: string;
  /** The set and keys of a captured fixture: the recorded fallback of authorities(setId). */
  fixtureSet: { setId: number; keys: Hex[]; from: string };
  checkpointRow: number | null;
  sudo: { id: Hex; ss58: string; from: string };
  /** The relayer's latest recorded import into this client. */
  latestRelay: RelayEntry | null;
  /**
   * The newest block the records say this client imported: the relayer's latest import, or a mint's
   * bundle block when importAndMint imported a newer one. The recorded fallback of latestFinalized().
   */
  latestImport: { number: number; hash: Hex; setId: number; txHash: Hex; sepoliaBlock: number | null; via: "relayer" | "mint"; from: string } | null;
}

export interface BurnRecord {
  txHash: Hex | null;
  block: number | null;
  ok: boolean | null;
  status: number | null;
  signedAt: string | null;
  amount: string;
  v3Recipient: Hex;
  burnNonce: string | null;
  burnId: Hex | null;
}

export interface ReleaseRecord {
  status: string;
  /** The burn's chain id as the record names it ("11155111" for Sepolia, "84532" for Base Sepolia); null when a record names none, which counts as Sepolia's, as the relayer reads it (chainIdOf in relayer/src/wayback.ts). */
  chainId: string | null;
  burnTx: Hex | null;
  burnNonce: string | null;
  burnId: Hex | null;
  payee: Hex | null;
  amountNative: string | null;
  approvals: { member: number; action: string; extrinsicHash: Hex; status: string; block: number | null; signedAt: string | null }[];
  releasedAt: { number: number; hash: Hex } | null;
  /** How the burn qualified for the release, as the record says ("fast" for fast mode), when it says. */
  by: string | null;
}

export interface FundingRecord {
  status: string;
  role: string;
  to: string;
  amount: string;
  extrinsicHash: Hex;
  block: number | null;
}

export interface ReturnPath {
  burns: BurnRecord[];
  releases: ReleaseRecord[];
  funding: FundingRecord[];
  committee: { members: string[]; threshold: number; multisig: string; releaser: Hex };
  /** The first completed way back, from the records' timestamps: the burn sent, the release run. */
  timing: { burnSentAt: string; releaseRunAt: string; seconds: number } | null;
}

export interface AbiParam {
  type: string;
  name: string;
  indexed: boolean;
}

export interface AbiItem {
  kind: "error" | "event";
  name: string;
  params: AbiParam[];
  /** The source file that declares it, relative to contracts/src. */
  source: string;
}

/**
 * The README's "Verify it yourself" commands, with the outputs the README records for them. `now`
 * is set when deployments/ at this build gives another value than the README's output (a later
 * mint, burn or release): the records' value, for the page to show next to the README's.
 */
export interface VerifyBlock {
  env: string[];
  groups: { what: string[]; commands: { cmd: string; output: string[]; now: string | null }[] }[];
  /** The block as the README has it, for "copy all". */
  text: string;
}

/** One measured step of a timed run (site/data/measured-runs.json). */
export interface RunStep {
  key: "lock" | "finality" | "proofs" | "mint";
  seconds: number;
  what: string;
}

/**
 * The latest recorded transfer, V3 to Sepolia: the newest successful mint in
 * deployments/sepolia-bridge.json, its lock in deployments/v3-testnet.json and its bundle.
 */
export interface LatestRun {
  lock: {
    nonce: number;
    txHash: Hex;
    block: number;
    /** The block hash as the V3 EVM RPC reports it (pallet-revive's), not the Substrate hash. */
    evmBlockHash: Hex;
    from: Hex;
    recipient: Hex;
    dstChainId: string;
    dstMinter: Hex;
    amountNative: string;
    commitment: Hex;
    slot: Hex;
    signedAt: string;
  };
  bundle: {
    file: string;
    block: { number: number; hash: Hex };
    /** The Substrate hash of the lock's block, the bundle block's parent when the bundle was read right after it. */
    parent: { number: number; hash: Hex };
    setId: number;
    signatures: number;
    threshold: number;
    authorities: number;
    capturedAt: string;
  };
  mint: RecordedTx & { amountNative: string; recipient: Hex; nonce: number };
  /** True when this mint also bound the vault (the first mint does). */
  bound: boolean;
  /** The README's evidence rows for the lock and the mint, when the README at this build lists them. */
  row: number | null;
  lockRow: number | null;
  /** The intervals measured during the run, when site/data/measured-runs.json holds them. */
  timing: {
    steps: RunStep[];
    totalSeconds: number;
    measuredOn: string;
    about: string;
    from: string;
    /** The timestamps of the lock's V3 block and the mint's Sepolia block, as recorded (UTC, ISO). */
    blockTimes: { lock: { block: number; at: string }; mint: { block: number; at: string }; seconds: number } | null;
    /** True when the README at this build states the same intervals (its "Lock to mint" section). */
    inReadme: boolean;
    /** That section's heading, when `inReadme`: the page links to it. */
    readmeHeading: string | null;
  } | null;
}

/** The relayer's latest run into one light client: one sender's entries recorded within minutes of its last one. */
export interface RelayRun {
  entries: RelayEntry[];
  settledAt: string | null;
}

/** The README's "Roadmap" section, in its words. */
export interface Roadmap {
  intro: string;
  groups: { title: string; items: { lead: string | null; text: string }[] }[];
}

export interface Records {
  build: { commit: string | null; builtAt: string };
  verify: VerifyBlock | null;
  latestRun: LatestRun | null;
  relayRuns: { mainnet: RelayRun | null; v3: RelayRun | null };
  roadmap: Roadmap | null;
  repo: string;
  sepolia: {
    deployer: Hex;
    contracts: { name: string; address: Hex; role: string }[];
    minter: Hex;
    token: Hex;
  };
  evidence: EvidenceRow[];
  bridge: BridgeRun;
  attacks: Attack[];
  lightClients: { mainnet: LightClientFacts; v3: LightClientFacts };
  /** Every sender's history in deployments/, merged: `files` are their paths, `entries` their transactions, each once. */
  relay: { files: string[]; entries: RelayEntry[] };
  returnPath: ReturnPath;
  /**
   * Totals from the records: the recorded fallback of the vault's and the token's live state. Over
   * the locks the records know (the V3 record's, and any a mint names): outstandingNative is what
   * the vault took for them (the V3 record's amounts, and what was minted for a lock it lacks) less
   * what was released, which is minted + pending - released, pending being the recorded locks no
   * mint names yet (the build refuses records that disagree on a lock's amount).
   */
  totals: {
    locks: number;
    outstandingNative: string;
    minted: string;
    pending: string;
    burned: string;
    supply: string;
    recipientBalance: string;
  };
  abi: { errors: AbiItem[]; events: AbiItem[] };
}
