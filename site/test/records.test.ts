// The build-time records, and what the page recomputes from them: amounts, commitments, keys and
// SS58 addresses.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRecords, checkReadmeTiming, markStaleOutputs, parseEvidence, parseRoadmap, parseVerify, readmeTimingSection } from "../build/records.ts";
import { formatDuration, formatInt, formatUnits } from "../src/lib/format.ts";
import { checksumAddress } from "../src/lib/hex.ts";
import { keccak256 } from "../src/lib/hashes.ts";
import { burnId, childTrieKey, commitmentSlot, lockCommitment } from "../src/lib/proofs.ts";
import { ss58 } from "../src/lib/ss58.ts";

const here = dirname(fileURLToPath(import.meta.url));
// RECORDS_ROOT runs these tests against another checkout's records (a newer README, say).
const repo = process.env.RECORDS_ROOT ?? join(here, "..", "..");
const r = buildRecords(repo);

test("the records hold the run of lock 0 and its six reverted copies", () => {
  assert.ok(r.evidence.length >= 38);
  assert.equal(r.bridge.row, 32);
  assert.equal(r.bridge.mint.gasUsed, 2952838);
  assert.equal(r.bridge.finality.block.number, 108424);
  assert.equal(r.bridge.finality.setId, 30);
  assert.equal(r.bridge.lock.block.number, 101009);
  assert.deepEqual(
    r.attacks.map((a) => [a.part, a.row]),
    [
      ["signature", 33],
      ["header", 34],
      ["proof", 35],
      ["amount", 36],
      ["recipient", 37],
      ["replay", 38],
    ],
  );
  assert.equal(r.lightClients.mainnet.checkpointRow, 1);
  assert.equal(r.lightClients.v3.checkpointRow, 5);
  assert.equal(r.lightClients.mainnet.fixtureSet.keys.length, 10);
  assert.equal(r.lightClients.mainnet.blockTimeSec, 60);
  assert.equal(r.lightClients.v3.blockTimeSec, 6);
});

test("the page recomputes lock 0's commitment and slot key as the records hold them", () => {
  const l = r.bridge.lock;
  assert.equal(
    lockCommitment({ v3ChainId: 420420777n, vault: r.bridge.vault.address, dstChainId: BigInt(l.dstChainId), minter: l.dstMinter, recipient: l.recipient, amountNative: BigInt(l.amountNative), nonce: 0n }),
    l.commitment,
  );
  assert.equal(commitmentSlot(0n), r.bridge.proofs.slot.index);
  assert.equal(childTrieKey(0n), r.bridge.proofs.slot.key);
  for (const b of r.returnPath.burns) {
    if (b.burnNonce === null || b.burnId === null) continue;
    assert.equal(burnId(11155111n, r.sepolia.minter, BigInt(b.burnNonce)), b.burnId, `burn ${b.burnNonce}`);
  }
});

test("totals follow the records: minted, burned, released", () => {
  const t = r.totals;
  assert.equal(BigInt(t.supply), BigInt(t.minted) - BigInt(t.burned));
  assert.ok(t.locks >= 2, "locks 0 and 1");
  assert.ok(BigInt(t.minted) >= 200000000000000n, "1 wtPOT each for locks 0 and 1");
  // Every lock minted and every release paid: what the vault holds equals the wtPOT supply.
  const released = r.returnPath.releases.filter((x) => x.status === "released").reduce((n, x) => n + BigInt(x.amountNative ?? "0"), 0n);
  assert.equal(BigInt(t.outstandingNative), BigInt(t.minted) - released);
  // Lock 2 was minted by auto-mint, from its own key (deployments/automint-sepolia-*.jsonl).
  if (t.locks >= 3) assert.ok(BigInt(t.minted) >= 201000000000000n, "lock 2's 0.01 wtPOT, minted by auto-mint");
  if (t.locks === 2 && released === 50000000000000n) {
    assert.equal(t.supply, "150000000000000");
    assert.equal(t.outstandingNative, "150000000000000");
  }
});

test("the latest transfer is lock 1, with its bundle, its mint and the measured steps", () => {
  const run = r.latestRun;
  assert.ok(run);
  if (run.lock.nonce !== 1) return; // a later run is in the records: the checks below are lock 1's
  assert.equal(run.lock.txHash, "0x30606cf196d5d9553c83580b7d114de91f8a4839d819320ca775351a8c6c70e4");
  assert.equal(run.lock.block, 118636);
  assert.equal(run.lock.commitment, "0x2d1ab009f006fd70b9653d09a56a3b4927775d6251c4879df9c7a1364b0ad0a7");
  assert.equal(run.bundle.block.number, 118637);
  assert.equal(run.bundle.parent.number, 118636);
  assert.equal(run.bundle.setId, 33);
  assert.equal(run.bundle.signatures, 2);
  assert.equal(run.bundle.authorities, 2);
  assert.equal(run.mint.txHash, "0xb9134dd793b84ff53375cd6b5ec8fb51940fea0a5cce2b5924f674b530d7f943");
  assert.equal(run.mint.block, 11955981);
  assert.equal(run.mint.gasUsed, 2391069);
  assert.equal(run.bound, false, "lock 0's mint bound the vault");
  assert.equal(formatUnits(BigInt(run.mint.amountNative), 14), "1");
  const l = run.lock;
  assert.equal(
    lockCommitment({ v3ChainId: 420420777n, vault: r.bridge.vault.address, dstChainId: BigInt(l.dstChainId), minter: l.dstMinter, recipient: l.recipient, amountNative: BigInt(l.amountNative), nonce: 1n }),
    l.commitment,
  );
  assert.equal(commitmentSlot(1n), l.slot);
  const t = run.timing;
  assert.ok(t, "site/data/measured-runs.json holds lock 1's steps");
  assert.deepEqual(
    t.steps.map((s) => [s.key, s.seconds]),
    [
      ["lock", 10],
      ["finality", 14],
      ["proofs", 9],
      ["mint", 15],
    ],
  );
  assert.equal(t.totalSeconds, 48);
  // The records' timestamps fit inside the 48 s: the lock was signed, the bundle read and the mint signed in that order.
  const at = (iso: string) => Date.parse(iso);
  assert.ok(at(l.signedAt) < at(run.bundle.capturedAt) && at(run.bundle.capturedAt) < at(run.mint.signedAt ?? ""));
  assert.ok(at(run.mint.signedAt ?? "") - at(l.signedAt) < t.totalSeconds * 1000);
});

test("the relayer's latest runs: V3 set 32 to 33, then its head", () => {
  const v3 = r.relayRuns.v3;
  assert.ok(v3 && v3.entries.length > 0);
  const change = v3.entries.find((e) => e.setBefore === 32 && e.setAfter === 33);
  if (change) {
    assert.equal(change.block.number, 118123);
    assert.equal(change.sepoliaBlock, 11955971);
    const head = v3.entries.find((e) => e.method === "importFinalityProof");
    assert.equal(head?.block.number, 118614);
    assert.equal(head?.sepoliaBlock, 11955972);
  }
  assert.ok(r.relayRuns.mainnet && r.relayRuns.mainnet.entries.every((e) => e.signatures === 7));
});

test("every sender's relay history counts: the newest import and the latest run across them, one sender a run", () => {
  // Three senders' histories (test/fixtures/relays): A into both clients, then B into V3 and C into
  // the old mainnet; B's file holds one line twice.
  const dir = join(here, "fixtures", "relays");
  const f = buildRecords(repo, dir);
  const A = `0x${"a".repeat(40)}`;
  const B = `0x${"b".repeat(40)}`;
  const C = `0x${"c".repeat(40)}`;
  const tx = (b: string) => `0x${b.repeat(32)}`;
  const fileOf = (s: string) => f.relay.files.find((x) => x.endsWith(`relay-sepolia-${s}.jsonl`));

  // The newest import into each client is the newest in any file.
  assert.equal(f.lightClients.v3.latestRelay?.txHash, tx("b3"));
  assert.equal(f.lightClients.mainnet.latestRelay?.txHash, tx("c1"));
  assert.deepEqual([f.lightClients.v3.latestImport?.via, f.lightClients.v3.latestImport?.number], ["relayer", 201700]);
  assert.equal(f.lightClients.v3.latestImport?.from, fileOf(B));
  assert.equal(f.lightClients.mainnet.latestImport?.from, fileOf(C));

  // All three files, each transaction once.
  assert.equal(f.relay.files.length, 3);
  assert.deepEqual([A, B, C].map((s) => Boolean(fileOf(s))), [true, true, true]);
  assert.deepEqual(
    f.relay.entries.map((e) => [e.sender, e.txHash]),
    [
      [A, tx("a1")],
      [A, tx("a2")],
      [A, tx("a3")],
      [A, tx("a4")],
      [B, tx("b1")],
      [B, tx("b2")],
      [B, tx("b3")],
      [C, tx("c1")],
    ],
  );

  // Each client's last run is the newest across the senders, and holds one sender's entries: A's
  // mainnet head 5 minutes before C's is not part of C's run.
  assert.deepEqual(f.relayRuns.v3?.entries.map((e) => e.txHash), [tx("b2"), tx("b3")]);
  assert.equal(f.relayRuns.v3?.settledAt, "2026-10-19T12:00:10.000Z");
  assert.deepEqual(f.relayRuns.mainnet?.entries.map((e) => e.txHash), [tx("c1")]);
  assert.equal(f.relayRuns.mainnet?.settledAt, "2026-10-19T12:10:00.000Z");

  // The repository's own records: every history in deployments/ is read.
  assert.ok(r.relay.files.length >= 1 && r.relay.files.every((x) => /^deployments\/relay-sepolia-0x[0-9a-f]{40}\.jsonl$/.test(x)));
  assert.equal(new Set(r.relay.entries.map((e) => e.txHash)).size, r.relay.entries.length);
});

test("the way back's duration comes from the records' timestamps", () => {
  const t = r.returnPath.timing;
  assert.ok(t);
  assert.equal(t.burnSentAt, "2026-10-20T12:51:52.245Z");
  assert.equal(t.releaseRunAt, "2026-10-20T13:11:50.143Z");
  assert.equal(t.seconds, 1198);
  assert.equal(formatDuration(t.seconds), "20 min");
});

test("the roadmap is the README's, with plans and no promises", () => {
  const rm = r.roadmap;
  assert.ok(rm);
  assert.match(rm.intro, /^Plans, not promises/);
  // What comes next first, then the later groups in the README's order, however many it has: the
  // README's third group ("Planned after the check-in") must not stop the page from building.
  assert.match(rm.groups[0]?.title ?? "", /^Next\b/);
  assert.ok(rm.groups.length >= 2 && rm.groups.every((g) => g.title && g.items.length > 0));
  const text = [rm.intro, ...rm.groups.flatMap((g) => [g.title, ...g.items.map((i) => `${i.lead ?? ""} ${i.text}`)])].join(" ");
  assert.doesNotMatch(text, /\bwill\b|coming soon/i);
  assert.match(text, /Solana/);
  assert.ok(rm.groups.flatMap((g) => g.items).find((i) => i.lead === "More EVM chains."));
  const md = ["## Roadmap", "", "Plans.", "", "**Soon**", "", "- One,", "  continued.", "- **Two.** Text.", "", "**Later: three**", "", "- **Three,** then.", "", "## Next"].join(String.fromCharCode(10));
  assert.deepEqual(parseRoadmap(md), {
    intro: "Plans.",
    groups: [
      {
        title: "Soon",
        items: [
          { lead: null, text: "One, continued." },
          { lead: "Two.", text: "Text." },
        ],
      },
      { title: "Later: three", items: [{ lead: "Three,", text: "then." }] },
    ],
  });
});

test("the README's recorded outputs against deployments/: a later mint shows next to them", () => {
  const md = [
    "## Verify it yourself",
    "",
    "```sh",
    "SEPOLIA=https://a.example",
    "",
    "# wtPOT",
    'cast call 0x1fcB "totalSupply()(uint256)" --rpc-url $SEPOLIA',
    "# 50000000000000 [5e13]",
    'cast call 0x1fcB "balanceOf(address)(uint256)" 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --rpc-url $SEPOLIA',
    "# 150000000000000 [1.5e14]",
    'cast call 0x8287 "burnCount()(uint256)" --rpc-url $SEPOLIA',
    "```",
  ].join("\n");
  const v = parseVerify(md);
  assert.ok(v);
  const differ = markStaleOutputs(v, [
    { cmd: /"totalSupply\(\)\(uint256\)"/, value: 150000000000000n, note: "1.5 wtPOT" },
    { cmd: /"balanceOf\(address\)\(uint256\)"\s+0xd9838a86cf83c28ee486544060d1ca4ca2971071\b/i, value: 150000000000000n, note: "1.5 wtPOT" },
    { cmd: /"burnCount\(\)\(uint256\)"/, value: 1n, note: "1 recorded" },
  ]);
  const cmds = v.groups.flatMap((g) => g.commands);
  assert.equal(cmds[0]?.now, "150000000000000 (1.5 wtPOT)", "the README's 5e13 predates lock 1's mint");
  assert.equal(cmds[1]?.now, null, "an output that still holds is left alone");
  assert.equal(cmds[2]?.now, null, "a command without a recorded output is left alone");
  assert.equal(differ.length, 1);
  // The repository's own README: whatever differs is marked, and a marked value is what deployments/ gives.
  for (const c of r.verify?.groups.flatMap((g) => g.commands) ?? []) {
    if (c.now === null) continue;
    assert.match(c.now, /^\d+ \(/);
    if (/totalSupply/.test(c.cmd)) assert.ok(c.now.startsWith(`${r.totals.supply} `));
    if (/outstanding\(\)/.test(c.cmd)) assert.ok(c.now.startsWith(`${r.totals.outstandingNative} `));
  }
});

test("the V3 client's recorded set is the one the newest mint was signed under", () => {
  const run = r.latestRun;
  assert.ok(run);
  assert.equal(r.lightClients.v3.fixtureSet.setId, run.bundle.setId);
  assert.equal(r.lightClients.v3.fixtureSet.keys.length, run.bundle.authorities);
  assert.equal(r.lightClients.v3.fixtureSet.from, run.bundle.file);
  // Lock 0's bundle keeps its own set for the bridge section's signature check.
  assert.equal(r.bridge.finality.setId, 30);
  assert.equal(r.bridge.finality.authorities.length, 2);
});

test("SS58 and checksummed addresses match the probes and Etherscan's casing", () => {
  assert.equal(ss58(r.lightClients.v3.sudo.id, 42), r.lightClients.v3.sudo.ss58);
  assert.equal(ss58(r.lightClients.mainnet.sudo.id, 42), r.lightClients.mainnet.sudo.ss58);
  assert.equal(checksumAddress("0x447171c4885ad725ee4772e8e3c228adee50dcb0", keccak256), "0x447171c4885Ad725eE4772E8e3c228aDeE50Dcb0");
  assert.equal(checksumAddress("0x8287b3baf205ca8456f98346f13064aa7fcdcb9e", keccak256), "0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E");
});

test("amounts and numbers are formatted without rounding", () => {
  assert.equal(formatUnits(100000000000000n, 14), "1");
  assert.equal(formatUnits(50000000000000n, 14), "0.5");
  assert.equal(formatUnits(1n, 14), "0.00000000000001");
  assert.equal(formatUnits(11547316337433722360n, 18, 4), "11.5473");
  assert.equal(formatUnits(123456789000000000000n, 14), "1,234,567.89");
  assert.equal(formatInt(2952838), "2,952,838");
  assert.equal(formatInt(-1200n), "-1,200");
  assert.equal(formatDuration(51 * 60), "51 min");
  assert.equal(formatDuration(486 * 6), "49 min");
});

test("evidence rows: Sepolia links and V3 rows with their extrinsics resolved", () => {
  const md = [
    "### A table",
    "| # | What | Transaction | Block | Result |",
    "|---|---|---|---|---|",
    `| **47** | **Burn: \`a | b\`** | [\`0x42d70ae9…\`](https://sepolia.etherscan.io/tx/0x${"42".repeat(32)}) | Sepolia 11,955,414 | success |`,
    "| 48 | Funded | `0xe1c37a36…30209617` | V3 [#117,514](https://node-console.portaldot.dev/?rpc=x#/explorer/query/117514) | final |",
  ].join("\n");
  const rows = parseEvidence(md, ["0xe1c37a368392d3d1bbbffba8d9cbab36e96303bc93e201746d69b2d930209617"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.chain, "sepolia");
  assert.equal(rows[0]?.block, 11955414);
  assert.equal(rows[0]?.what, "Burn: `a | b`");
  assert.equal(rows[1]?.chain, "v3");
  assert.equal(rows[1]?.block, 117514);
  assert.equal(rows[1]?.tx, "0xe1c37a368392d3d1bbbffba8d9cbab36e96303bc93e201746d69b2d930209617");
  assert.ok(rows[1]?.blockUrl?.endsWith("/117514"));
});

test("the README's verify block: descriptions, commands and recorded outputs", () => {
  const md = [
    "## Verify it yourself",
    "",
    "```sh",
    "A=https://a.example",
    "",
    "# What the first group shows",
    "# on two lines",
    "cast call 0x1 \"f()(uint256)\"",
    "# 2",
    "cast call 0x2 \"g()(bool)\"",
    "# true",
    "",
    "# The second group",
    "cast code 0x3 | cast keccak",
    "```",
  ].join("\n");
  const v = parseVerify(md);
  assert.ok(v);
  assert.deepEqual(v.env, ["A=https://a.example"]);
  assert.equal(v.groups.length, 2);
  assert.deepEqual(v.groups[0]?.what, ["What the first group shows", "on two lines"]);
  assert.deepEqual(
    v.groups[0]?.commands.map((c) => [c.cmd, c.output]),
    [
      ['cast call 0x1 "f()(uint256)"', ["2"]],
      ['cast call 0x2 "g()(bool)"', ["true"]],
    ],
  );
  assert.deepEqual(v.groups[1]?.commands[0]?.output, []);
  if (r.verify) assert.ok(r.verify.groups.length > 0, "the repository's README has the block");
});

test("the timed run: the block stamps, and the README section that must give the same numbers", () => {
  const t = r.latestRun?.timing;
  assert.ok(t);
  if (r.latestRun?.lock.nonce === 1) {
    assert.deepEqual(t.blockTimes, { lock: { block: 118636, at: "2026-10-20T14:45:36Z" }, mint: { block: 11955981, at: "2026-10-20T14:46:12Z" }, seconds: 36 });
  }
  const md = [
    "### Lock to mint in 48 seconds",
    "",
    "The lock's V3 block is stamped 14:45:36 and the mint's Sepolia",
    "block 14:46:12: 36 seconds. From sending the lock to the mint's receipt, with the tools' own checks,",
    "it took 48 seconds: the lock 10, GRANDPA finality 14, reading and checking the proofs 9, the mint 15.",
    "",
    "| # | What it shows |",
    "",
    "## Layout",
  ].join("\n");
  const section = readmeTimingSection(md);
  assert.ok(section && !section.includes("Layout"));
  assert.deepEqual(checkReadmeTiming(section, t.steps, 48, ["14:45:36", "14:46:12"]), { status: "agrees", problem: null });
  // Other numbers in the README are a contradiction; other words are not.
  assert.equal(checkReadmeTiming(section.replace("proofs 9", "proofs 8"), t.steps, 48, []).status, "disagrees");
  assert.equal(checkReadmeTiming(section, t.steps, 48, ["14:45:37", "14:46:12"]).status, "disagrees");
  assert.equal(checkReadmeTiming(section.replaceAll("48 seconds", "47 seconds"), t.steps, 48, []).status, "disagrees");
  assert.equal(checkReadmeTiming(section.replace("48 seconds:", "48 seconds, so:"), t.steps, 48, []).status, "unclear");
  assert.equal(checkReadmeTiming("It was quick.", t.steps, 48, ["14:45:36"]).status, "unclear");
  assert.equal(readmeTimingSection("## Roadmap"), null);
});

test("each light client's newest import by the records: the relayer's, or a mint's bundle block", () => {
  const v3 = r.lightClients.v3.latestImport;
  const main = r.lightClients.mainnet.latestImport;
  assert.ok(v3 && main);
  assert.equal(main.via, "relayer");
  assert.equal(main.number, r.lightClients.mainnet.latestRelay?.block.number);
  // Lock 1's mint imported V3 #118,637, after the relayer's head #118,614.
  if (r.latestRun?.lock.nonce === 1 && (r.lightClients.v3.latestRelay?.block.number ?? 0) < 118637) {
    assert.deepEqual([v3.via, v3.number, v3.setId, v3.sepoliaBlock], ["mint", 118637, 33, 11955981]);
    assert.equal(v3.txHash, r.latestRun.mint.txHash);
  }
  assert.ok(v3.number >= (r.lightClients.v3.latestRelay?.block.number ?? 0));
});
