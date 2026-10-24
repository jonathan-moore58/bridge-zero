// The trusted return path computed off chain: a burn of wtPOT on Sepolia (BridgeMinter.burn) and
// its release of tPOT from PortaldotVault on the Portaldot V3 testnet by the committee's 2-of-3
// pallet-multisig account. Amounts in wtPOT, native base units and EVM units; the burn's calldata;
// the release's revive.call as V3's runtime encodes it, and back; the call hash, the deposit and the
// other signatories pallet-multisig takes; the limits a release is approved with; the rule that the
// payee is an address someone controls; and the checks of a release's call trace. No network
// access: release.ts and committee.test.ts use it.

import { bytesToHex, concatBytes, equalBytes } from "./bytes.js";
import { callData, MINTER, WTPOT_DECIMALS } from "./bridge.js";
import { blake2_256 } from "./hash.js";
import { encodeCompact, Reader } from "./scale.js";
import { addressWord, decodeLocked, decodeReleased, formatEvmTpot, formatTpot, LOCKED_TOPIC, releaseCalldata, RELEASED_TOPIC, selector, SIGNATURES, uintWord, wordToAddress, type LogJson } from "./vault.js";

// ---------------------------------------------------------------------------------------
// Amounts

const UNIT = 10n ** BigInt(WTPOT_DECIMALS);

/**
 * An amount of wtPOT ("0.5", at most 14 decimals) in wtPOT units, which are native base units of
 * tPOT. Refuses more decimals, signs, exponents, separators and zero (the minter's ZeroAmount).
 */
export function parseWtpot(text: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`not an amount of wtPOT: ${JSON.stringify(text)}`);
  const fraction = m[2] ?? "";
  if (fraction.length > WTPOT_DECIMALS) throw new Error(`${text} wtPOT has more than ${WTPOT_DECIMALS} decimals, below one unit of wtPOT`);
  const value = BigInt(m[1]) * UNIT + BigInt(fraction.padEnd(WTPOT_DECIMALS, "0"));
  if (value === 0n) throw new Error("the amount is zero");
  if (value >= 1n << 128n) throw new Error(`${text} wtPOT is more than any balance on V3 holds`);
  return value;
}

/** What the vault pays for `amountNative` base units: amountNative x NATIVE_TO_ETH_RATIO, in EVM units (wei). */
export function evmValue(amountNative: bigint, ratio: bigint): bigint {
  if (amountNative <= 0n || ratio <= 0n) throw new RangeError(`not an amount and a ratio: ${amountNative}, ${ratio}`);
  return amountNative * ratio;
}

// ---------------------------------------------------------------------------------------
// The burn, on Sepolia

/** BridgeMinter.burn(amount, v3Recipient): the start of the trusted return path. */
export function burnCalldata(amount: bigint, v3Recipient: Uint8Array): Uint8Array {
  if (amount <= 0n) throw new RangeError("the minter refuses a zero amount");
  if (v3Recipient.every((b) => b === 0)) throw new Error("the minter refuses the zero address as v3Recipient");
  return callData(MINTER.burn, uintWord(amount), addressWord(v3Recipient));
}

// ---------------------------------------------------------------------------------------
// The release's call, on V3

export interface Weight {
  refTime: bigint;
  proofSize: bigint;
}

const U64 = 1n << 64n;
const U128 = 1n << 128n;

/** Weight as the runtime encodes it: ref time and proof size, each a Compact<u64>. */
export function encodeWeight(w: Weight): Uint8Array {
  if (w.refTime < 0n || w.refTime >= U64 || w.proofSize < 0n || w.proofSize >= U64) throw new RangeError(`not a weight: ${w.refTime}, ${w.proofSize}`);
  return concatBytes(encodeCompact(w.refTime), encodeCompact(w.proofSize));
}

/** revive.call(dest, value, weight_limit, storage_deposit_limit, data). */
export interface ReviveCall {
  dest: Uint8Array;
  /** Native base units sent with the call (0 for a release). */
  value: bigint;
  weightLimit: Weight;
  storageDepositLimit: bigint;
  data: Uint8Array;
}

/**
 * The RuntimeCall of revive.call as V3's runtime encodes it: the pallet and call index (`index`,
 * 0x5001 on V3: pallet 80, call 1), the 20-byte dest, the value as a Compact<u128>, the weight
 * limit, the storage deposit limit as a Compact<u128> and the data as a Vec<u8>.
 */
export function encodeReviveCall(index: Uint8Array, c: ReviveCall): Uint8Array {
  if (index.length !== 2) throw new Error(`a call index is 2 bytes, got ${index.length}`);
  if (c.dest.length !== 20) throw new Error(`dest is 20 bytes, got ${c.dest.length}`);
  if (c.value < 0n || c.value >= U128 || c.storageDepositLimit < 0n || c.storageDepositLimit >= U128) throw new RangeError("value and storage deposit limit are u128");
  return concatBytes(index, c.dest, encodeCompact(c.value), encodeWeight(c.weightLimit), encodeCompact(c.storageDepositLimit), encodeCompact(c.data.length), c.data);
}

/** The fields of an encoded revive.call; refuses another call, a non-canonical compact and trailing bytes. */
export function decodeReviveCall(bytes: Uint8Array, index: Uint8Array): ReviveCall {
  const r = new Reader(bytes);
  const at = r.bytes(2);
  if (!equalBytes(at, index)) throw new Error(`not revive.call: the call index is ${bytesToHex(at)}, revive.call's is ${bytesToHex(index)}`);
  const dest = r.bytes(20).slice();
  const value = r.compact();
  const refTime = r.compact();
  const proofSize = r.compact();
  const storageDepositLimit = r.compact();
  const data = r.bytes(r.length()).slice();
  r.end("revive.call");
  if (value >= U128 || storageDepositLimit >= U128 || refTime >= U64 || proofSize >= U64) throw new Error("a field of the revive.call is out of range");
  return { dest, value, weightLimit: { refTime, proofSize }, storageDepositLimit, data };
}

export interface Release {
  burnId: Uint8Array;
  to: Uint8Array;
  amountNative: bigint;
}

/** release(burnId, to, amountNative) from its calldata; refuses another function, another length and a dirty address word. */
export function decodeReleaseCalldata(data: Uint8Array): Release {
  if (data.length !== 4 + 96 || !equalBytes(data.subarray(0, 4), selector(SIGNATURES.release))) throw new Error(`not release(bytes32,address,uint256) calldata: ${data.length} bytes, selector ${bytesToHex(data.subarray(0, 4))}`);
  return {
    burnId: data.slice(4, 36),
    to: wordToAddress(data.slice(36, 68), "release's to"),
    amountNative: BigInt(bytesToHex(data.slice(68, 100))),
  };
}

/** pallet-multisig's call hash: blake2_256 of the encoded call. */
export const callHash = (call: Uint8Array): Uint8Array => blake2_256(call);

// ---------------------------------------------------------------------------------------
// pallet-multisig

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

/**
 * The other_signatories of `me` among `members`: every other member, in ascending order of the
 * account id's bytes, as pallet-multisig requires (SignatoriesOutOfOrder otherwise).
 */
export function otherSignatories(members: Uint8Array[], me: Uint8Array): Uint8Array[] {
  if (members.some((m) => m.length !== 32) || me.length !== 32) throw new Error("an account id is 32 bytes");
  if (!members.some((m) => equalBytes(m, me))) throw new Error(`${bytesToHex(me)} is not a member`);
  const others = members.filter((m) => !equalBytes(m, me)).sort(compareBytes);
  if (others.some((m, i) => i > 0 && compareBytes(others[i - 1], m) === 0)) throw new Error("a member is listed twice");
  return others;
}

/** What the member who opens a multisig operation reserves until it runs or is cancelled: DepositBase + DepositFactor x threshold. */
export const multisigDeposit = (base: bigint, factor: bigint, threshold: number): bigint => base + factor * BigInt(threshold);

/** A block number and the index of the extrinsic in it, which names an open multisig operation. */
export interface Timepoint {
  height: number;
  index: number;
}

// ---------------------------------------------------------------------------------------
// The limits a release is approved with

/**
 * The storage deposit limit no release goes below: one new contract storage item
 * (released[burnId], a 32-byte key and a 32-byte value: DepositPerByte x 64 +
 * DepositPerChildTrieItem, 3.8415 tPOT on V3) and the existential deposit a payee account that
 * does not exist yet takes from the origin (0.1 tPOT): 3.9415 tPOT. The release that brings
 * outstanding to 0 is charged 0 net, but its limit still has to allow the item.
 */
export const releaseDepositFloor = (depositPerByte: bigint, depositPerChildTrieItem: bigint, existentialDeposit: bigint): bigint =>
  depositPerByte * 64n + depositPerChildTrieItem + existentialDeposit;

const roundUp = (value: bigint, step: bigint): bigint => ((value + step - 1n) / step) * step;

/** The steps the limits are rounded up to, so that two runs on the same state build the same call. */
export const LIMIT_STEPS = { refTime: 100_000_000n, proofSize: 10_000n, deposit: 10_000_000_000n } as const;

/** What a dry run of the release from the multisig needs. */
export interface ReleaseNeeds {
  refTime: bigint;
  proofSize: bigint;
  /** The most the call holds as storage deposit at any point, positive: charged. */
  maxStorageDeposit: bigint;
}

/**
 * The weight limit and the storage deposit limit of the release's revive.call: twice the dry run's
 * weight, rounded up to 10^8 ref time and 10^4 proof size, and the dry run's largest deposit plus
 * 2%, rounded up to 0.0001 tPOT, at least `floor`. The approvals come minutes apart; the margin
 * lets the call still run when the state moves a little in between, and the rounding makes every
 * approver who dry-runs the same state build the same call, whose hash the multisig keys it by.
 */
export function releaseLimits(needs: ReleaseNeeds, floor: bigint): { weightLimit: Weight; storageDepositLimit: bigint } {
  if (needs.refTime <= 0n || needs.proofSize < 0n || needs.maxStorageDeposit < 0n) throw new RangeError("not a dry run's needs");
  const deposit = roundUp(needs.maxStorageDeposit + needs.maxStorageDeposit / 50n, LIMIT_STEPS.deposit);
  return {
    weightLimit: { refTime: roundUp(2n * needs.refTime, LIMIT_STEPS.refTime), proofSize: roundUp(2n * needs.proofSize, LIMIT_STEPS.proofSize) },
    storageDepositLimit: deposit > floor ? deposit : floor,
  };
}

/** Why a call's limits do not cover what a dry run needs, or null when they do. */
export function limitsProblem(c: ReviveCall, needs: ReleaseNeeds, floor: bigint): string | null {
  if (c.weightLimit.refTime < needs.refTime) return `its ref time limit ${c.weightLimit.refTime} is below the ${needs.refTime} the dry run needs`;
  if (c.weightLimit.proofSize < needs.proofSize) return `its proof size limit ${c.weightLimit.proofSize} is below the ${needs.proofSize} the dry run needs`;
  if (c.storageDepositLimit < needs.maxStorageDeposit) return `its storage deposit limit ${c.storageDepositLimit} is below the ${needs.maxStorageDeposit} the dry run holds`;
  if (c.storageDepositLimit < floor) return `its storage deposit limit ${c.storageDepositLimit} is below the floor ${floor} (one storage item and an existential deposit)`;
  return null;
}

// ---------------------------------------------------------------------------------------
// The payee

/** What the chains say about a payee address. */
export interface PayeeFacts {
  /** revive.originalAccount(payee): the Substrate account the address stands for, when one is mapped to it. */
  original: Uint8Array | null;
  /** The payee has code on V3. */
  contract: boolean;
  /** The payee has code on Sepolia, other than an EIP-7702 delegation (whose account still has a key). */
  sepoliaContract: boolean;
  /** The payee is the burn's sender, the address that sent the burn on Sepolia. */
  burner: boolean;
  /** Transactions sent from the address: its nonce on Sepolia and on V3 (eth_getTransactionCount). */
  sepoliaNonce: number;
  v3Nonce: number;
}

export type PayeeKind = "substrate" | "contract" | "burner" | "signer" | "unproven";

/** An EIP-7702 delegation designator: 0xef0100 and the 20-byte address delegated to. */
export const isDelegation = (code: Uint8Array): boolean => code.length === 23 && code[0] === 0xef && code[1] === 0x01 && code[2] === 0x00;

/**
 * Whether someone controls the payee on V3. The vault pays `to`'s account: the Substrate account
 * revive.originalAccount names when one is mapped to the address, else the account the address
 * stands for (the address, then twelve 0xEE bytes), which an Ethereum key controls when the address
 * is that key's. The address of a Substrate account that does not exist yet is no key's: the
 * payout would go to a fallback account nobody controls; nor is the address of a contract on
 * Sepolia, a smart wallet say, unless the same contract is on V3. So the payee counts as controlled
 * when it is a mapped Substrate account, a contract on V3, or an address that has sent transactions
 * as a key does: the burn's own sender, or one with a nonce on Sepolia or on V3, where it has no
 * code; anything else is refused.
 */
export function payeeVerdict(f: PayeeFacts): { ok: boolean; kind: PayeeKind; why: string } {
  if (f.original) return { ok: true, kind: "substrate", why: "the address of a Substrate account that exists: revive.originalAccount maps it to that account, which the vault pays" };
  if (f.contract) return { ok: true, kind: "contract", why: "a contract on V3: the vault's payout calls it, and the dry run shows whether it takes the value" };
  if (f.burner && !f.sepoliaContract) return { ok: true, kind: "burner", why: "the burn's own sender, which has no code on Sepolia: the Ethereum key that signed the burn controls the same address on V3" };
  if ((f.sepoliaNonce > 0 && !f.sepoliaContract) || f.v3Nonce > 0) {
    return { ok: true, kind: "signer", why: `an address that has signed transactions (nonce ${f.sepoliaNonce} on Sepolia, ${f.v3Nonce} on V3) and has no code: an Ethereum key controls it` };
  }
  return {
    ok: false,
    kind: "unproven",
    why: f.sepoliaContract
      ? "a contract on Sepolia that is not on V3: no key controls its address on V3, and nothing else shows that anyone does"
      : "nothing shows that anyone controls it on V3: no Substrate account is mapped to it, it has no code, it is not the burn's sender, and it has sent no " +
        "transaction on Sepolia or V3. If it is the address of a Substrate account that does not exist yet, the payout goes to a fallback account nobody controls",
  };
}

// ---------------------------------------------------------------------------------------
// The release's call trace (reviveApi.traceCall with the call tracer and its logs)

export interface CallTrace {
  from: string;
  to: string;
  input: string;
  output?: string;
  error?: string | null;
  revertReason?: string | null;
  calls?: CallTrace[];
  logs?: { address: string; topics: string[]; data: string }[];
  value?: string | null;
  callType?: string;
}

export interface ReleaseExpectation {
  releaser: Uint8Array;
  vault: Uint8Array;
  release: Release;
  ratio: bigint;
}

const lower = (s: string | undefined | null) => (s ?? "").toLowerCase();

/**
 * The checks of a release's call trace, as [passed, what]: the call from the releaser to the vault
 * runs without an error or a revert, the vault emits exactly one Released log with the burn id, the
 * payee and the amount, and pays the payee amountNative x ratio in one call.
 */
export function releaseTraceChecks(trace: CallTrace, e: ReleaseExpectation): [boolean, string][] {
  const vault = bytesToHex(e.vault);
  const out: [boolean, string][] = [];
  out.push([lower(trace.from) === bytesToHex(e.releaser) && lower(trace.to) === vault, `the call is from the releaser ${bytesToHex(e.releaser)} to the vault ${vault}`]);
  out.push([!trace.error && !trace.revertReason, trace.error || trace.revertReason ? `the call fails: ${trace.error ?? ""} ${trace.revertReason ?? ""}`.trim() : "the call does not revert"]);
  const released = (trace.logs ?? []).filter((l) => lower(l.address) === vault && lower(l.topics[0]) === RELEASED_TOPIC);
  let logged = false;
  if (released.length === 1) {
    try {
      const r = decodeReleased(released[0] as LogJson);
      logged = equalBytes(r.burnId, e.release.burnId) && equalBytes(r.to, e.release.to) && r.amountNative === e.release.amountNative;
    } catch {
      logged = false;
    }
  }
  out.push([logged, `one Released log: burn id ${bytesToHex(e.release.burnId)}, to ${bytesToHex(e.release.to)}, ${e.release.amountNative} native base units (${released.length} found)`]);
  const value = evmValue(e.release.amountNative, e.ratio);
  const payouts = (trace.calls ?? []).filter((c) => lower(c.from) === vault && lower(c.to) === bytesToHex(e.release.to));
  const paid = payouts.length === 1 && payouts[0].value !== undefined && payouts[0].value !== null && BigInt(payouts[0].value) === value && !payouts[0].error;
  out.push([paid, `the vault pays ${bytesToHex(e.release.to)} ${value} wei (amountNative x ${e.ratio}) in one call`]);
  return out;
}

/** The trace of a reviveApi.traceCall result in its JSON form ({ ok: { call: ... } }), or why there is none. */
export function traceOf(json: unknown): { trace: CallTrace | null; problem: string | null } {
  const r = json as { ok?: { call?: CallTrace }; err?: unknown } | null;
  if (r?.ok?.call) return { trace: r.ok.call, problem: null };
  return { trace: null, problem: `reviveApi.traceCall returned ${JSON.stringify(r?.err ?? json).slice(0, 300)}` };
}

// ---------------------------------------------------------------------------------------
// The checks of a release's execution on V3

/** An event the vault emitted (revive.ContractEmitted), and the extrinsic of the block it is in (null: none, as at the block's initialization). */
export interface VaultEvent {
  extrinsic: number | null;
  topics: string[];
  data: string;
}

/** A balances.Transfer: from and to as AccountId32, the amount in native base units. */
export interface BalanceTransfer {
  from: Uint8Array;
  to: Uint8Array;
  amount: bigint;
}

/** What the chain says about the extrinsic that ran a release, and about its block. */
export interface ExecutionFacts {
  /** Its block's number, and its index in the block. */
  block: number;
  index: number;
  amountNative: bigint;
  /** The vault's account and the payee's (AccountId32). */
  vaultAccount: Uint8Array;
  payeeAccount: Uint8Array;
  /** The vault's outstanding at the block's parent and at the block. */
  outstanding: { before: bigint; after: bigint };
  /** Every event the vault emitted in the block, whatever extrinsic it is in: the locks and releases of other extrinsics move outstanding too. */
  vaultEvents: VaultEvent[];
  /** The extrinsic's own balances.Transfer events, and the accounts its balances.Endowed events created. */
  transfers: BalanceTransfer[];
  endowed: Uint8Array[];
  /** The payee's account (System.Account) at the block's parent: whether it existed; then how much its free balance went up over the block. */
  payeeExisted: boolean;
  credited: bigint;
  existentialDeposit: bigint;
  /** How much the payee's balance went up over the block through the EVM RPC (null: not served any more), and the payout in EVM units (amount x the ratio). */
  received: bigint | null;
  value: bigint;
  ratio: bigint;
}

const topic0 = (e: VaultEvent) => (e.topics[0] ?? "").toLowerCase();

/**
 * The checks of a release's execution after its events, which hold for it whatever else its block
 * holds: outstanding down by the amount once the block's locks (LOCKED_TOPIC, in any extrinsic) are
 * added back and the releases of other extrinsics taken off; and the extrinsic's own
 * balances.Transfer of the amount from the vault's account to the payee's, the payout itself
 * (with balances.Endowed where it created the payee's account). The payee's balance over the whole
 * block, in System.Account and through the EVM RPC (while it serves the block's state), is checked
 * too; when that payout is in the extrinsic's events and another extrinsic of the block moved the
 * payee's balance (anyone can send to it), a difference there is a warning, not a failure.
 */
export function executionChecks(f: ExecutionFacts): { checks: [boolean, string][]; warnings: string[] } {
  const checks: [boolean, string][] = [];
  const warnings: string[] = [];
  const at = `#${f.block.toLocaleString("en-US")}`;
  const locked = f.vaultEvents.filter((e) => topic0(e) === LOCKED_TOPIC).reduce((sum, e) => sum + decodeLocked({ address: "0x", topics: e.topics, data: e.data }).amountNative, 0n);
  const releasedElsewhere = f.vaultEvents
    .filter((e) => topic0(e) === RELEASED_TOPIC && e.extrinsic !== f.index)
    .reduce((sum, e) => sum + decodeReleased({ address: "0x", topics: e.topics, data: e.data }).amountNative, 0n);
  const others = [locked > 0n ? `${formatTpot(locked)} locked in ${at} added back` : "", releasedElsewhere > 0n ? `${formatTpot(releasedElsewhere)} released by other extrinsics of ${at} taken off` : ""].filter(Boolean);
  checks.push([
    f.outstanding.before + locked - releasedElsewhere - f.outstanding.after === f.amountNative,
    `outstanding went from ${formatTpot(f.outstanding.before)} to ${formatTpot(f.outstanding.after)}${others.length > 0 ? ` (${others.join(", ")}): down by ${formatTpot(f.outstanding.before + locked - releasedElsewhere - f.outstanding.after)}` : ""}`,
  ]);
  const payouts = f.transfers.filter((t) => equalBytes(t.from, f.vaultAccount) && equalBytes(t.to, f.payeeAccount));
  const paid = payouts.length === 1 && payouts[0].amount === f.amountNative;
  checks.push([paid, `balances.Transfer of ${formatTpot(f.amountNative)} from the vault's account to the payee's ${bytesToHex(f.payeeAccount)}, in the extrinsic's events (${payouts.length} found)`]);
  if (!f.payeeExisted) {
    if (f.endowed.some((a) => equalBytes(a, f.payeeAccount))) checks.push([true, "balances.Endowed: the release created the payee's account"]);
    else warnings.push(`the payee's account did not exist at #${(f.block - 1).toLocaleString("en-US")}, and the extrinsic did not create it: another extrinsic of ${at} did`);
  }
  // Over the whole block: another extrinsic of it may have sent to the payee, or created its account.
  const moved = (what: string) => `another extrinsic in ${at} moved the payee's balance: ${what}; the extrinsic's own balances.Transfer above is the payout`;
  const expected = f.amountNative + (f.payeeExisted ? 0n : f.existentialDeposit);
  const accountText = `System.Account: the payee's free balance went up by ${formatTpot(f.credited)}, the amount${f.payeeExisted ? "" : ` plus the existential deposit ${formatTpot(f.existentialDeposit)} of the account the release created`}`;
  if (f.credited === expected) checks.push([true, accountText]);
  else if (paid) warnings.push(moved(`System.Account has its free balance up by ${formatTpot(f.credited)} over the block, not ${formatTpot(expected)}`));
  else checks.push([false, accountText]);
  if (f.received !== null) {
    const evmText = `the payee's balance through the EVM RPC went up by ${f.received.toLocaleString("en-US")} wei (${formatEvmTpot(f.received, f.ratio)}), amount x ${f.ratio}`;
    if (f.received === f.value) checks.push([true, evmText]);
    else if (paid) warnings.push(moved(`through the EVM RPC its balance went up by ${f.received.toLocaleString("en-US")} wei over the block, not ${f.value.toLocaleString("en-US")}`));
    else checks.push([false, evmText]);
  }
  return { checks, warnings };
}

// ---------------------------------------------------------------------------------------
// The release's call for a burn

/** revive.call(vault, 0, limits, release(burnId, payee, amountNative)): what the committee approves. */
export function releaseCall(vault: Uint8Array, r: Release, limits: { weightLimit: Weight; storageDepositLimit: bigint }): ReviveCall {
  return { dest: vault, value: 0n, weightLimit: limits.weightLimit, storageDepositLimit: limits.storageDepositLimit, data: releaseCalldata(r.burnId, r.to, r.amountNative) };
}
