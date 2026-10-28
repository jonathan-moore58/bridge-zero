// Substrate (5…) accounts on Portaldot V3, without a library: an SS58 address read back to its
// 32-byte account id, the H160 pallet-revive gives that account (what the vault records as the
// sender of a lock it signs), and the checks of the address such a lock pays on its destination
// (Sepolia, or a rollup). Kept apart from the build's records so that node --test runs it.

import { checksum } from "../../lib/display.ts";
import { blake2b512, keccak256 } from "../../lib/hashes.ts";
import { bytesToHex, concatBytes, equalBytes, type Hex } from "../../lib/hex.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Portaldot's SS58 prefix (V3's system_properties: ss58Format 42). */
export const SS58_PREFIX = 42;

/** Portaldot V3 testnet's genesis (docs/V3.md): a wallet account bound to another is not V3's. */
export const V3_GENESIS: Hex = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";

/** Base58 to bytes, leading "1"s as zero bytes; null for a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array | null {
  let n = 0n;
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  for (; n > 0n; n >>= 8n) body.unshift(Number(n & 0xffn));
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/**
 * The account id of an SS58 address of a 32-byte key with a one-byte prefix, its checksum checked
 * (blake2b-512 of "SS58PRE", the prefix and the key, its first two bytes); null for anything else.
 */
export function accountIdOf(address: string): { id: Uint8Array; prefix: number } | null {
  const raw = base58Decode(address.trim());
  if (!raw || raw.length !== 35) return null;
  const prefix = raw[0] ?? 255;
  if (prefix > 63) return null;
  const sum = blake2b512(concatBytes(new TextEncoder().encode("SS58PRE"), raw.subarray(0, 33))).subarray(0, 2);
  if (!equalBytes(sum, raw.subarray(33))) return null;
  return { id: raw.slice(1, 33), prefix };
}

/** An account id that stands for an Ethereum address on V3: its H160 followed by twelve 0xEE bytes. */
export const ethDerived = (id: Uint8Array): boolean => id.length === 32 && id.subarray(20).every((b) => b === 0xee);

/**
 * pallet-revive's address of an account (AutoMap): keccak-256 of the 32 bytes, its last 20, as the
 * vault sees msg.sender; the first 20 bytes for an account that stands for an Ethereum address.
 * reviveApi.address gives the same for every account checked on V3 (Oct 27).
 */
export function reviveAddress(id: Uint8Array): Hex {
  if (id.length !== 32) throw new RangeError(`an account id is 32 bytes, got ${id.length}`);
  return bytesToHex(ethDerived(id) ? id.subarray(0, 20) : keccak256(id).subarray(12));
}

/** The vault's sender for a lock signed by this SS58 address, lower case; null when it does not read as one. */
export function senderOf(address: string): Hex | null {
  const a = accountIdOf(address);
  return a ? reviveAddress(a.id) : null;
}

/** 5Grw…utQY. */
export const shortSs58 = (address: string): string => (address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

// ---------------------------------------------------------------------------------------------
// The address a lock from a 5… account pays on its destination

/**
 * The addresses wtPOT must never be minted to, by what they are: the contracts and the visitor's own
 * V3 addresses. `chain`: the destination's name, "Sepolia" unless given; `minter` and `token` are its.
 */
export interface RecipientContext {
  /** The connected account's address on V3 (reviveAddress): no Ethereum key holds it. */
  mapped: Hex | null;
  /** The V3 addresses of the other accounts the Polkadot wallet shares, keyless on the destination too, with how the page names each. */
  others?: readonly { h160: Hex; label: string }[];
  minter: Hex;
  token: Hex;
  vault: Hex;
  chain?: string;
}

export type RecipientCheck =
  | { ok: true; address: Hex; shown: string }
  | { ok: false; kind: "empty" | "invalid" | "refused"; text: string };

const ZERO = `0x${"0".repeat(40)}`;
const same = (a: string, b: string | null): boolean => !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The destination's address typed for a lock's recipient: 0x and 40 hex digits, its EIP-55 checksum
 * checked when it mixes cases. Refused: the zero address; an address that ends in twelve 0xEE
 * bytes (V3's form of an Ethereum account, no key's there); the visitor's own address on V3, or
 * another account's of the same wallet, which no Ethereum key holds, so wtPOT minted there would be
 * stuck; BridgeMinter, wtPOT and the vault. Any other Substrate account's address on V3 is refused
 * by the review's check on V3 (chain.ts, revive.originalAccount). A lock's recipient cannot be
 * changed once it is on V3.
 */
export function checkRecipient(text: string, ctx: RecipientContext): RecipientCheck {
  const chain = ctx.chain ?? "Sepolia";
  const t = text.trim();
  if (!t) return { ok: false, kind: "empty", text: `Enter the ${chain} address that receives the wtPOT.` };
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { ok: false, kind: "invalid", text: `A ${chain} address is 0x and 40 hex digits.` };
  const body = t.slice(2);
  if (/[a-f]/.test(body) && /[A-F]/.test(body) && checksum(t) !== t) {
    return { ok: false, kind: "invalid", text: "Its capital letters do not match its checksum (EIP-55): a typo, most likely. Copy it again from your wallet." };
  }
  const a = t.toLowerCase() as Hex;
  if (a === ZERO) return { ok: false, kind: "refused", text: "The zero address: wtPOT minted there could never move." };
  if (a.endsWith("ee".repeat(12))) return { ok: false, kind: "refused", text: `An address that ends in twelve 0xEE bytes is V3's form of an account, not a ${chain} key's.` };
  if (same(a, ctx.mapped)) {
    return {
      ok: false,
      kind: "refused",
      text: "That is your Polkadot account's address on V3. No Ethereum key holds it, so wtPOT minted there would be stuck. Use an address your Ethereum wallet controls.",
    };
  }
  const other = ctx.others?.find((o) => same(a, o.h160));
  if (other) {
    return {
      ok: false,
      kind: "refused",
      text: `That is the V3 address of ${other.label}, another account in your Polkadot wallet. No Ethereum key holds it, so wtPOT minted there would be stuck. Use an address your Ethereum wallet controls.`,
    };
  }
  if (same(a, ctx.minter)) return { ok: false, kind: "refused", text: "That is BridgeMinter, the contract that mints: it cannot use wtPOT." };
  if (same(a, ctx.token)) return { ok: false, kind: "refused", text: "That is the wtPOT token's own address: it cannot use wtPOT." };
  if (same(a, ctx.vault)) return { ok: false, kind: "refused", text: `That is the vault's address on V3, not a ${chain} account.` };
  return { ok: true, address: a, shown: checksum(a) };
}

/**
 * What the destination says of a recipient, as a caution, not a refusal: a contract (it has to be
 * able to hold wtPOT, and to burn it to come back), or an address with no transaction and no ETH yet
 * (the visitor should be sure they hold its key). An EIP-7702 delegation is a key's account.
 */
export function recipientNote(code: string, txCount: bigint, balance: bigint, chain = "Sepolia"): string | null {
  const c = code.toLowerCase();
  if (c !== "0x" && !/^0xef0100[0-9a-f]{40}$/.test(c)) return `A contract on ${chain}: make sure it can hold wtPOT, and burn it to bring it back.`;
  if (txCount === 0n && balance === 0n) return `No transactions and no ETH on ${chain} yet: make sure you hold this address's key.`;
  return null;
}
