// A lock from a Polkadot wallet (src/app/substrate): the 5… account read back to its account id and
// to the address the vault records as its sender, the Sepolia recipient's checks, the revive.call
// encoded byte by byte against the call and the payload @polkadot/api built on V3 (captured live,
// read-only, Oct 27: the deployer 5ERJ…, 0.001 tPOT to 0xD983…1071, nothing signed), the dry run as
// V3 answers it and the relayer's limits, a stand-in injectedWeb3 extension, and the send's order:
// the checks before the wallet, the wallet once, V3's check before the broadcast. Offline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MINT } from "../src/app/handoff.ts";
import type { ExtrinsicRef } from "../src/app/model.ts";
import { accountIdOf, base58Decode, checkRecipient, ethDerived, recipientNote, reviveAddress, senderOf, shortSs58, type RecipientContext } from "../src/app/substrate/account.ts";
import { compact, eraWindow, limitsOf, lockData, payloadProblem, readDryRun, REVIVE_CALL, reviveCall, V3_GENESIS, type PayloadJson } from "../src/app/substrate/call.ts";
import { accountRows, APP_NAME, enableWallet, faultOf, polkaWallets, type Injected, type InjectedAccount, type InjectedWindow, type SignerResult } from "../src/app/substrate/inject.ts";
import { NodeRefused, PayloadRefused, sendLockOnce, TALISMAN_HELP, type LockChain, type LockPrep, type PreparedLock, type SendHooks, type SignedLock } from "../src/app/substrate/send.ts";
import { evmValue, parseAmount } from "../src/app/txmath.ts";
import { bytesToHex, hexToBytes, type Hex } from "../src/lib/hex.ts";
import { ss58 } from "../src/lib/ss58.ts";

const VAULT: Hex = "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd";
const MINTER: Hex = "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e";
/** wtPOT (deployments/sepolia-bridge.json, contracts.WrappedTPOT). */
const TOKEN: Hex = "0x1fcbbd66922ac5aa20219a5c16c2591a76b4cb14";
const RECIPIENT: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";
const SEPOLIA_ID = 11_155_111n;

/** V3's accounts as pjs-check read them live (Oct 27): reviveApi.address of each, and keccak-256 of its id, its last 20 bytes. */
const ACCOUNTS: [string, Hex][] = [
  ["5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7", "0xb621f9a9dd96ba88681c40b04657cef602854e24"],
  ["5DLnLMAsR3kkHnHndC4eRWhMFXPjCU8bGiSugCjUmGJaBism", "0x8a09bc2199051a5d579e3c7a4561ffa0a5bc973d"],
  ["5F99Y91UgQ4EDTubPWWPvWKc3ghhVA77nc7HjRhsTyXn38z9", "0xf74b1851fc5bb316570440a61eab0ccf595a42b2"],
  ["5EJJYKuM5aaKwgegKGinAbnL7dK3m3QziyqusPotTQ3S7w1E", "0x70445ab9696f430394eb95b03a182b36dc7761dc"],
  ["5FTrjzEPPdxo3WP1RcQGTzUX1y1udD7tAkaETV1iLH24xPk3", "0xa08a7f7ded49cc81f901fb42fec00edfc48c0fc1"],
];
const DEPLOYER = ACCOUNTS[0]![0];

/** What @polkadot/api 17.0.2 built on V3 for the deployer's 0.001 tPOT lock to 0xD983…1071, with the relayer's limits (pjs-check, captured, never signed). */
const LIVE = {
  data: "0xecd1eb6c0000000000000000000000000000000000000000000000000000000000aa36a70000000000000000000000008287b3baf205ca8456f98346f13064aa7fcdcb9e000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca2971071" as Hex,
  method:
    "0x5001a02ee16eb03d2cf1aef199f7658fb8c8e3188ffd0700e876481786eaff91062802000f00bac6ba5e64019101ecd1eb6c0000000000000000000000000000000000000000000000000000000000aa36a70000000000000000000000008287b3baf205ca8456f98346f13064aa7fcdcb9e000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca2971071" as Hex,
  dryRun: {
    weightConsumed: { refTime: 556697281, proofSize: 32118 },
    weightRequired: { refTime: 556697281, proofSize: 32118 },
    storageDeposit: { charge: 384150000000000 },
    maxStorageDeposit: { charge: 384150000000000 },
    gasConsumed: 0,
    result: { ok: { flags: { bits: 0 }, data: "0x0000000000000000000000000000000000000000000000000000000000000003" } },
  },
  payload: {
    specVersion: "0x00000bba",
    transactionVersion: "0x00000002",
    address: "5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7",
    assetId: null,
    blockHash: "0x5c417a712c0af0458413679064f64ee97bc46ec09d38cb61aff5db09a7b1f183",
    blockNumber: "0x00035aee",
    era: "0xe502",
    genesisHash: "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd",
    metadataHash: null,
    method: "",
    mode: 0,
    nonce: "0x00000007",
    signedExtensions: [
      "AuthorizeCall",
      "CheckNonZeroSender",
      "CheckSpecVersion",
      "CheckTxVersion",
      "CheckGenesis",
      "CheckMortality",
      "CheckNonce",
      "CheckWeight",
      "ChargeAssetTxPayment",
      "CheckMetadataHash",
      "EthSetOrigin",
      "WeightReclaim",
    ],
    tip: "0x00000000000000000000000000000000",
    version: 4,
    withSignedTransaction: false,
  } satisfies PayloadJson,
};
LIVE.payload.method = LIVE.method;

// ---------------------------------------------------------------------------------------------
// The account, and the vault's sender

test("a 5… address reads back to its account id, and to the address V3 gives it: what the vault records as the lock's sender", () => {
  for (const [address, h160] of ACCOUNTS) {
    const a = accountIdOf(address);
    assert.ok(a, address);
    assert.equal(a.prefix, 42);
    assert.equal(ss58(a.id, 42), address);
    assert.equal(reviveAddress(a.id), h160, address);
    assert.equal(senderOf(address), h160);
  }
  assert.equal(shortSs58(DEPLOYER), "5ERJ…gPJ7");
});

test("an address that is not an SS58 address of a 32-byte account reads as none: its checksum, its length, its characters", () => {
  const last = DEPLOYER.slice(-1) === "7" ? "8" : "7";
  assert.equal(accountIdOf(DEPLOYER.slice(0, -1) + last), null);
  assert.equal(accountIdOf(DEPLOYER.slice(0, -2)), null);
  assert.equal(accountIdOf("0xb621f9a9dd96ba88681c40b04657cef602854e24"), null);
  assert.equal(accountIdOf("5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ0"), null);
  assert.equal(base58Decode("0OIl"), null);
  assert.deepEqual(base58Decode("11"), Uint8Array.of(0, 0));
});

test("an account that stands for an Ethereum address (its H160 and twelve 0xEE bytes) has that H160 as its address, not a hash", () => {
  const id = Uint8Array.from([...hexToBytes(RECIPIENT), ...new Array<number>(12).fill(0xee)]);
  assert.equal(ethDerived(id), true);
  assert.equal(reviveAddress(id), RECIPIENT);
  assert.equal(ethDerived(accountIdOf(DEPLOYER)!.id), false);
});

// ---------------------------------------------------------------------------------------------
// The Sepolia recipient

const CTX: RecipientContext = { mapped: ACCOUNTS[0]![1], minter: MINTER, token: TOKEN, vault: VAULT };

test("a Sepolia address is taken in any case, checked against its EIP-55 checksum when it mixes cases", () => {
  const lower = checkRecipient(RECIPIENT, CTX);
  assert.ok(lower.ok);
  assert.equal(lower.address, RECIPIENT);
  assert.equal(lower.shown, "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071");
  assert.ok(checkRecipient("  0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 ", CTX).ok);
  assert.ok(checkRecipient(RECIPIENT.toUpperCase().replace("0X", "0x"), CTX).ok);
  const typo = checkRecipient("0xD9838A86cF83C28Ee486544060D1cA4Ca2971070".replace("1cA4", "1Ca4"), CTX);
  assert.equal(typo.ok, false);
  assert.equal(typo.ok ? "" : typo.kind, "invalid");
});

test("the recipient's traps are refused: the zero address, V3's 0xEE form, your own addresses on V3 (no key holds them), the contracts", () => {
  const kind = (t: string) => {
    const r = checkRecipient(t, CTX);
    return r.ok ? "ok" : r.kind;
  };
  assert.equal(kind(""), "empty");
  assert.equal(kind("0x1234"), "invalid");
  assert.equal(kind(`${RECIPIENT}00`), "invalid");
  assert.equal(kind(`0x${"0".repeat(40)}`), "refused");
  assert.equal(kind(`0x${"12".repeat(8)}${"ee".repeat(12)}`), "refused");
  assert.equal(kind(ACCOUNTS[0]![1]), "refused");
  assert.equal(kind(ACCOUNTS[0]![1].toUpperCase().replace("0X", "0x")), "refused");
  assert.equal(kind(MINTER), "refused");
  assert.equal(kind(TOKEN), "refused");
  assert.equal(kind(VAULT), "refused");
  const own = checkRecipient(ACCOUNTS[0]![1], CTX);
  assert.match(own.ok ? "" : own.text, /stuck/);
  // The wallet's other accounts' addresses on V3 are keyless too: refused, named. Any other
  // account's is refused by the review's read of revive.originalAccount on V3 (chain.ts).
  assert.equal(kind(ACCOUNTS[1]![1]), "ok");
  const wallet: RecipientContext = { ...CTX, others: [{ h160: ACCOUNTS[1]![1], label: "Savings (5DLn…Bism)" }] };
  const other = checkRecipient(ACCOUNTS[1]![1].toUpperCase().replace("0X", "0x"), wallet);
  assert.equal(other.ok ? "ok" : other.kind, "refused");
  assert.match(other.ok ? "" : other.text, /Savings \(5DLn…Bism\), another account in your Polkadot wallet.*stuck/);
  assert.ok(checkRecipient(RECIPIENT, wallet).ok);
});

test("Sepolia's word on a recipient is a caution: a contract, or an address with no transaction and no ETH; a 7702 delegation is a key's", () => {
  assert.match(recipientNote("0x6080604052", 5n, 0n) ?? "", /contract/);
  assert.equal(recipientNote(`0xef0100${"ab".repeat(20)}`, 3n, 0n), null);
  assert.match(recipientNote("0x", 0n, 0n) ?? "", /hold this address's key/);
  assert.equal(recipientNote("0x", 0n, 1n), null);
  assert.equal(recipientNote("0x", 4n, 0n), null);
});

// ---------------------------------------------------------------------------------------------
// The call, byte by byte

test("SCALE compact integers, in all four modes", () => {
  const hex = (n: bigint) => bytesToHex(compact(n));
  assert.equal(hex(0n), "0x00");
  assert.equal(hex(1n), "0x04");
  assert.equal(hex(63n), "0xfc");
  assert.equal(hex(64n), "0x0101");
  assert.equal(hex(100n), "0x9101");
  assert.equal(hex(16_383n), "0xfdff");
  assert.equal(hex(16_384n), "0x02000100");
  assert.equal(hex((1n << 30n) - 1n), "0xfeffffff");
  assert.equal(hex(1n << 30n), "0x0300000040");
  assert.equal(hex(100_000_000_000n), "0x0700e8764817");
  assert.throws(() => compact(-1n));
});

test("the lock's calldata and revive.call are the bytes @polkadot/api built on V3: the vault, the value in native units, the limits, lock(11155111, BridgeMinter, recipient)", () => {
  assert.equal(lockData(SEPOLIA_ID, MINTER, RECIPIENT), LIVE.data);
  const call = reviveCall({ vault: VAULT, value: 100_000_000_000n, refTime: 612_367_009n, proofSize: 35_329n, depositLimit: 391_833_000_000_000n, data: LIVE.data });
  assert.equal(call, LIVE.method);
  assert.equal(call.length, 2 + 146 * 2);
  assert.ok(call.startsWith(REVIVE_CALL));
  // The destination is the vault; the data names Sepolia, BridgeMinter and the recipient, never the sender.
  const b = hexToBytes(call);
  assert.equal(bytesToHex(b.subarray(2, 22)), VAULT);
  const data = bytesToHex(b.subarray(b.length - 100));
  assert.equal(data, LIVE.data);
  assert.equal(data.slice(0, 10), "0xecd1eb6c");
  assert.equal(BigInt(`0x${data.slice(10, 74)}`), SEPOLIA_ID);
  assert.equal(`0x${data.slice(98, 138)}`, MINTER);
  assert.equal(`0x${data.slice(162, 202)}`, RECIPIENT);
});

test("the units: 0.001 tPOT is 10^11 native units in the call (auto-mint's minimum), and the vault sees 10,000 times that as msg.value", () => {
  const units = parseAmount("0.001");
  assert.equal(units, 100_000_000_000n);
  assert.equal(units, AUTO_MINT.min);
  assert.equal(evmValue(units!), 10n ** 15n);
  // In the call it is compact(10^11): 0700e8764817, right after the vault.
  assert.equal(LIVE.method.slice(46, 58), "0700e8764817");
  const one = reviveCall({ vault: VAULT, value: parseAmount("1")!, refTime: 1n, proofSize: 1n, depositLimit: 0n, data: LIVE.data });
  assert.equal(one.slice(46, 46 + 14), bytesToHex(compact(10n ** 14n)).slice(2));
});

test("V3's dry run reads as it answered live: ran, returned nonce 3, the weight and the deposit; the relayer's limits come out as the call's", () => {
  const d = readDryRun(LIVE.dryRun);
  assert.equal(d.ok, true);
  assert.equal(d.reverted, false);
  assert.equal(d.returns, 3n);
  assert.equal(d.refTime, 556_697_281n);
  assert.equal(d.proofSize, 32_118n);
  assert.equal(d.deposit, 384_150_000_000_000n);
  assert.deepEqual(limitsOf(d), { refTime: 612_367_009n, proofSize: 35_329n, depositLimit: 391_833_000_000_000n });
  // From an account that cannot pay: revive.TransferFailed, as V3 answered for an empty one.
  const poor = readDryRun({ weightRequired: { refTime: 1573250, proofSize: 899 }, storageDeposit: { charge: 0 }, maxStorageDeposit: { charge: 0 }, result: { err: { module: { index: 80, error: "0x07000000" } } } });
  assert.equal(poor.ok, false);
  assert.deepEqual(poor.error, { index: 80, error: 7 });
  // A revert keeps its data for the contracts' errors to name it.
  const rev = readDryRun({ ...LIVE.dryRun, result: { ok: { flags: { bits: 1 }, data: "0x5d8a1f3c" } } });
  assert.equal(rev.reverted, true);
  assert.equal(rev.returns, null);
  assert.equal(rev.data, "0x5d8a1f3c");
  // A larger maximum deposit wins; a refund charges nothing.
  assert.equal(limitsOf({ ...d, maxDeposit: 768_300_000_000_000n }).depositLimit, 783_666_000_000_000n);
  assert.equal(limitsOf({ ...d, deposit: -5n, maxDeposit: -5n }).depositLimit, 0n);
  assert.throws(() => readDryRun({ result: {} }), /unexpected form/);
});

test("the payload the wallet is asked to sign is the lock checked: the captured one passes, and a changed call, account, chain, era or tip is refused", () => {
  const e = { address: DEPLOYER, call: LIVE.method, genesis: V3_GENESIS };
  assert.equal(payloadProblem(LIVE.payload, e), null);
  assert.match(payloadProblem({ ...LIVE.payload, method: LIVE.method.replace("d9838a86", "d9838a87") }, e) ?? "", /call/);
  assert.match(payloadProblem({ ...LIVE.payload, address: ACCOUNTS[1]![0] }, e) ?? "", /names/);
  assert.match(payloadProblem({ ...LIVE.payload, genesisHash: `0x${"11".repeat(32)}` }, e) ?? "", /another chain/);
  assert.match(payloadProblem({ ...LIVE.payload, era: "0x00" }, e) ?? "", /mortal/);
  assert.match(payloadProblem({ ...LIVE.payload, tip: "0x00000000000000000000000000000001" }, e) ?? "", /tip/);
  // Its signed extensions are V3's twelve, AuthorizeCall and EthSetOrigin among them (both empty).
  assert.equal(LIVE.payload.signedExtensions.length, 12);
});

test("the payload's era lets the extrinsic in for 64 blocks from the block it was made at: #219,886 to #219,949", () => {
  assert.equal(Number(BigInt(LIVE.payload.blockNumber)), 219_886);
  assert.deepEqual(eraWindow(LIVE.payload.era, 219_886), { from: 219_886, to: 219_949 });
  // Read at a later block of the same era: the same window.
  assert.deepEqual(eraWindow("0xe502", 219_900), { from: 219_886, to: 219_949 });
  // 64 blocks on, the same two bytes stand for the next window.
  assert.deepEqual(eraWindow("0xe502", 219_950), { from: 219_950, to: 220_013 });
  assert.throws(() => eraWindow("0x00", 1));
});

// ---------------------------------------------------------------------------------------------
// The wallets in the window

/** A stand-in for a polkadot{.js}-style extension: its accounts, its signer, and what it was asked. */
function extension(accounts: InjectedAccount[], sign: (p: PayloadJson) => Promise<SignerResult> = async () => ({ id: 1, signature: `0x${"ab".repeat(64)}` })) {
  const asked = { enable: [] as string[], sign: [] as PayloadJson[] };
  const injected: Injected = {
    accounts: { get: async () => accounts, subscribe: () => () => undefined },
    signer: {
      signPayload: async (p) => {
        asked.sign.push(p);
        return sign(p);
      },
    },
  };
  return { provider: { version: "0.1.0", enable: async (origin: string) => (asked.enable.push(origin), injected) }, asked, injected };
}

test("the picker's Polkadot wallets: Portaldot's own first, then the ones the page knows, then any other by its name; one without enable is not one", () => {
  const p = extension([]);
  const win: InjectedWindow = {
    injectedWeb3: { "zeta-wallet": p.provider, talisman: p.provider, "subwallet-js": p.provider, "polkadot-js": p.provider, "portaldot extension": p.provider, broken: {} },
  };
  const list = polkaWallets(win);
  assert.deepEqual(
    list.map((w) => [w.key, w.name, w.portaldot]),
    [
      ["portaldot extension", "Portaldot Wallet", true],
      ["polkadot-js", "polkadot{.js}", false],
      ["subwallet-js", "SubWallet", false],
      ["talisman", "Talisman", false],
      ["zeta-wallet", "zeta-wallet", false],
    ],
  );
  assert.match(list.find((w) => w.key === "talisman")?.note ?? "", /Add Portaldot V3 in Talisman first/);
  assert.deepEqual(polkaWallets({}), []);
});

test("only the wallet picked is enabled, under the page's name; a wallet that is gone, or cannot sign payloads, is refused", async () => {
  const a = extension([{ address: DEPLOYER, type: "sr25519", name: "Deployer" }]);
  const b = extension([]);
  const win: InjectedWindow = { injectedWeb3: { "portaldot extension": a.provider, "subwallet-js": b.provider } };
  const injected = await enableWallet(win, "portaldot extension");
  assert.deepEqual(a.asked.enable, [APP_NAME]);
  assert.deepEqual(b.asked.enable, []);
  assert.equal((await injected.accounts.get()).length, 1);
  await assert.rejects(enableWallet(win, "talisman"), /no longer in this browser/);
  const mute: InjectedWindow = { injectedWeb3: { x: { enable: async () => ({ accounts: { get: async () => [] }, signer: {} }) } } };
  await assert.rejects(enableWallet(mute, "x"), /signPayload/);
});

test("the account picker: Substrate accounts for any chain or for V3 are usable; Ethereum ones, ones bound to another chain and non-addresses are listed with why", () => {
  const rows = accountRows([
    { address: DEPLOYER, name: "Deployer", type: "sr25519" },
    { address: DEPLOYER, name: "Twice", type: "sr25519" },
    { address: ACCOUNTS[1]![0], name: " ", type: "ed25519", genesisHash: V3_GENESIS },
    { address: ACCOUNTS[2]![0], name: "Kusama", type: "sr25519", genesisHash: `0x${"b0".repeat(32)}` },
    { address: RECIPIENT, name: "EVM", type: "ethereum" },
    { address: "not-an-address", name: "Bad", type: "sr25519" },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.why === null]),
    [
      ["Deployer", true],
      [null, true],
      ["Kusama", false],
      ["EVM", false],
      ["Bad", false],
    ],
  );
  assert.match(rows[3]?.why ?? "", /Ethereum account/);
  assert.match(rows[2]?.why ?? "", /another network/);
  // What to do, in the wallet's own name when the page knows it.
  assert.equal(accountRows([{ address: ACCOUNTS[2]![0], genesisHash: `0x${"b0".repeat(32)}` }], "SubWallet")[0]?.why, "Bound to another network: in SubWallet, set this account to any network");
});

test("a wallet's answer: declined, Talisman without V3's metadata, or anything else in its words", () => {
  assert.equal(faultOf(new Error("Cancelled")), "rejected");
  assert.equal(faultOf(new Error("Rejected by user")), "rejected");
  assert.equal(faultOf("User denied the request"), "rejected");
  assert.equal(faultOf(new Error("Unable to find metadata for chain 0xd4f9acbc")), "metadata");
  assert.equal(faultOf(new Error("Unable to decode")), "other");
});

// ---------------------------------------------------------------------------------------------
// The send: checks, the wallet once, V3's check, the broadcast once

const PREP: PreparedLock = {
  call: LIVE.method,
  data: LIVE.data,
  value: 100_000_000_000n,
  refTime: 612_367_009n,
  proofSize: 35_329n,
  depositLimit: 391_833_000_000_000n,
  deposit: 384_150_000_000_000n,
  fee: 2_531_038_123_626n,
  returns: 3n,
  free: 14_556_455_801_079_056n,
  need: 401_964_038_123_626n,
  head: 219_886,
};
const EXT: ExtrinsicRef = { nonce: 7, from: 219_886, to: 219_949 };
const SIGNED: SignedLock = { hash: `0x${"5e".repeat(32)}`, hex: "0x1234", ext: EXT };

/** A stand-in V3 that does what chain.ts does in order, and records it: the checks, then the wallet's prompt with the captured payload. */
/** `built`: the call the library built, when it is not the one prepared (as chain.ts checks it, the wallet is then not asked). */
/** `best`: V3's best block at each read, the last one repeated; by default a block inside the era. */
function chainOf(o: { prep?: LockPrep; invalid?: string | null; submit?: Error | null; built?: Hex; best?: number[] } = {}) {
  const log: string[] = [];
  const heads = [...(o.best ?? [EXT.from + 3])];
  const chain: LockChain = {
    best: async () => {
      const n = heads.length > 1 ? heads.shift()! : heads[0]!;
      log.push(`best ${n}`);
      return n;
    },
    prepareLock: async (origin, amount, recipient) => {
      log.push(`prepare ${origin} ${amount} ${recipient}`);
      return o.prep ?? PREP;
    },
    signLock: async (prep, origin, signer, onAsk) => {
      log.push("build");
      const sign = signer.signPayload;
      if (!sign) throw new PayloadRefused("no signPayload");
      const payload = { ...LIVE.payload, address: origin, method: o.built ?? prep.call, withSignedTransaction: true };
      const why = payloadProblem(payload, { address: origin, call: prep.call, genesis: V3_GENESIS });
      if (why) throw new PayloadRefused(why);
      onAsk(EXT);
      await sign(payload);
      log.push("signed");
      return SIGNED;
    },
    validate: async (hex) => {
      log.push(`validate ${hex}`);
      return o.invalid ?? null;
    },
    submit: async (hex) => {
      log.push(`submit ${hex}`);
      if (o.submit) throw o.submit;
    },
  };
  return { chain, log };
}

function hooksOf(log: string[], still = () => true): SendHooks {
  return {
    checking: () => log.push("checking"),
    asking: (ext) => log.push(`asking ${ext.nonce} ${ext.from}-${ext.to}`),
    signed: (s) => log.push(`hooks.signed ${s.hash.slice(0, 6)}`),
    still,
  };
}

const INPUT = { origin: DEPLOYER, amount: 100_000_000_000n, recipient: RECIPIENT };

test("a lock is checked on V3 before the wallet is asked, signed once with the lock's own payload, checked by V3, recorded, then broadcast once", async () => {
  const { chain, log } = chainOf();
  const ext = extension([{ address: DEPLOYER }]);
  const r = await sendLockOnce("in-a", chain, ext.injected.signer, INPUT, hooksOf(log));
  assert.equal(r.kind, "sent");
  assert.equal(r.kind === "sent" && r.broadcast, true);
  assert.deepEqual(log, [
    "checking",
    `prepare ${DEPLOYER} 100000000000 ${RECIPIENT}`,
    "build",
    "asking 7 219886-219949",
    "signed",
    "best 219889",
    "validate 0x1234",
    "hooks.signed 0x5e5e",
    "submit 0x1234",
  ]);
  // The wallet saw one request: from the account, for this call, on V3, with its signed transaction allowed back.
  assert.equal(ext.asked.sign.length, 1);
  const p = ext.asked.sign[0]!;
  assert.equal(p.address, DEPLOYER);
  assert.equal(p.method, LIVE.method);
  assert.equal(p.genesisHash, V3_GENESIS);
  assert.equal(p.withSignedTransaction, true);
});

test("a dry run that refuses the lock, or an account changed meanwhile, asks the wallet nothing", async () => {
  const refused = chainOf({ prep: { problem: { title: "V3 would not run this lock", text: "revive.TransferFailed" } } });
  const ext = extension([]);
  const r = await sendLockOnce("in-b", refused.chain, ext.injected.signer, INPUT, hooksOf(refused.log));
  assert.deepEqual(r, { kind: "problem", title: "V3 would not run this lock", text: "revive.TransferFailed" });
  assert.equal(ext.asked.sign.length, 0);
  assert.ok(!refused.log.some((l) => l.startsWith("submit")));
  const moved = chainOf();
  const r2 = await sendLockOnce("in-c", moved.chain, ext.injected.signer, INPUT, hooksOf(moved.log, () => false));
  assert.equal(r2.kind, "refused");
  assert.equal(ext.asked.sign.length, 0);
});

test("declined in the wallet, or a payload that is not the lock, sends nothing; Talisman without V3 says how to add it", async () => {
  const declined = chainOf();
  const no = extension([], async () => {
    throw new Error("Cancelled");
  });
  assert.deepEqual(await sendLockOnce("in-d", declined.chain, no.injected.signer, INPUT, hooksOf(declined.log)), { kind: "rejected" });
  assert.ok(!declined.log.some((l) => l.startsWith("validate") || l.startsWith("submit") || l.startsWith("hooks.signed")));
  const talisman = chainOf();
  const t = extension([], async () => {
    throw new Error("Unable to find metadata for chain 0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd");
  });
  const r = await sendLockOnce("in-e", talisman.chain, t.injected.signer, INPUT, hooksOf(talisman.log));
  assert.deepEqual(r, { kind: "refused", title: "Talisman does not know Portaldot V3", text: TALISMAN_HELP });
  const tampered = chainOf({ built: LIVE.method.replace("d9838a86", "d9838a87") as Hex });
  const ext = extension([]);
  const r2 = await sendLockOnce("in-f", tampered.chain, ext.injected.signer, INPUT, hooksOf(tampered.log));
  assert.equal(r2.kind, "refused");
  assert.match(r2.kind === "refused" ? r2.text : "", /not the lock this page checked/);
  assert.equal(ext.asked.sign.length, 0);
});

test("V3 refusing what the wallet signed, or its node refusing the broadcast, sends nothing; a broadcast that does not answer is followed by its hash", async () => {
  const invalid = chainOf({ invalid: "V3 says its signature does not check out" });
  const r = await sendLockOnce("in-g", invalid.chain, extension([]).injected.signer, INPUT, hooksOf(invalid.log));
  assert.equal(r.kind, "refused");
  assert.ok(!invalid.log.some((l) => l.startsWith("submit") || l.startsWith("hooks.signed")));
  const node = chainOf({ submit: new NodeRefused("1010: Invalid Transaction: Transaction has a bad signature") });
  const r2 = await sendLockOnce("in-h", node.chain, extension([]).injected.signer, INPUT, hooksOf(node.log));
  assert.deepEqual(r2, { kind: "refused", title: "V3's node refused the lock", text: "1010: Invalid Transaction: Transaction has a bad signature. Nothing was sent." });
  const lost = chainOf({ submit: new Error("socket closed") });
  const r3 = await sendLockOnce("in-i", lost.chain, extension([]).injected.signer, INPUT, hooksOf(lost.log));
  assert.equal(r3.kind, "sent");
  assert.equal(r3.kind === "sent" && r3.broadcast, false);
  // Recorded before the broadcast either way: the page can follow it by its hash.
  assert.ok(lost.log.indexOf("hooks.signed 0x5e5e") < lost.log.indexOf("submit 0x1234"));
});

test("a wallet that answers after the era's last block sends nothing, and says the signing window passed, not that the signature is bad", async () => {
  // Answered with V3 at the era's last block: the next block is past it.
  const late = chainOf({ best: [EXT.to] });
  const r = await sendLockOnce("in-l", late.chain, extension([]).injected.signer, INPUT, hooksOf(late.log));
  assert.equal(r.kind, "refused");
  assert.equal(r.kind === "refused" ? r.title : "", "Signed after V3's signing window");
  assert.match(r.kind === "refused" ? r.text : "", /#219886 to #219949.*Nothing was sent/);
  assert.ok(!late.log.some((l) => l.startsWith("validate") || l.startsWith("hooks.signed") || l.startsWith("submit")));
  // In time at the first read, past it when V3 calls the signature bad: the same words.
  const edge = chainOf({ best: [EXT.to - 1, EXT.to], invalid: "V3 says its signature does not check out" });
  const r2 = await sendLockOnce("in-m", edge.chain, extension([]).injected.signer, INPUT, hooksOf(edge.log));
  assert.equal(r2.kind === "refused" ? r2.title : "", "Signed after V3's signing window");
  assert.ok(!edge.log.some((l) => l.startsWith("hooks.signed") || l.startsWith("submit")));
  // Bad while the era still runs: V3's own words.
  const bad = chainOf({ best: [EXT.to - 2], invalid: "V3 says its signature does not check out" });
  const r3 = await sendLockOnce("in-n", bad.chain, extension([]).injected.signer, INPUT, hooksOf(bad.log));
  assert.deepEqual(r3, { kind: "refused", title: "V3 would not take what your wallet signed", text: "V3 says its signature does not check out. Nothing was sent." });
});

test("never two locks for one click: a second send of the same transfer while one runs asks nothing; the next one, after it, does", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const { chain } = chainOf();
  const slow: LockChain = { ...chain, prepareLock: async (...a) => (await gate, chain.prepareLock(...a)) };
  const ext = extension([]);
  const first = sendLockOnce("in-j", slow, ext.injected.signer, INPUT, hooksOf([]));
  const second = await sendLockOnce("in-j", slow, ext.injected.signer, INPUT, hooksOf([]));
  assert.deepEqual(second, { kind: "busy" });
  // Another transfer is not held up by it.
  assert.equal((await sendLockOnce("in-k", chain, ext.injected.signer, INPUT, hooksOf([]))).kind, "sent");
  release();
  assert.equal((await first).kind, "sent");
  assert.equal(ext.asked.sign.length, 2);
  // Done: the same transfer may be sent again (a retry after a refusal).
  assert.equal((await sendLockOnce("in-j", chain, ext.injected.signer, INPUT, hooksOf([]))).kind, "sent");
});
