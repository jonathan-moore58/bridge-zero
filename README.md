# Bridge Zero

A Portaldot light client on Ethereum. Solidity contracts check Portaldot's GRANDPA
finality (the validators' signatures) and Substrate storage proofs, so an EVM
contract can use Portaldot state without a trusted relayer: trust rests on the
Portaldot validator set.

Built for the Portaldot Hacker House 2026, Multi-Chain & Cross-Chain Infra track.
Development runs from Oct 14 to Nov 6, 2026; this repository starts on Oct 14.

## Status

The light client runs on Ethereum Sepolia. It has verified GRANDPA finality from two Portaldot
chains, the old Portaldot mainnet (10 validators, 7 signatures needed) and the Portaldot V3 testnet
(2 validators, both needed), and proved an account balance from each verified block's state root.
On Oct 18 the relayer brought both light clients up to the chains' live finalized heads: every
validator-set change since their checkpoints, each with its validators' signatures, then the head.
Next: the token bridge (a vault on the V3 testnet, a mint on Sepolia).

## Evidence

Sepolia, from [`0xD983…1071`](https://sepolia.etherscan.io/address/0xD9838A86cF83C28Ee486544060D1cA4Ca2971071), blocks 11,934,321 to 11,934,336. Every transaction is built from
the captured chain data in [`fixtures/`](fixtures), each step is recorded in
[`deployments/sepolia.json`](deployments/sepolia.json), and
`node contracts/script/deploy-sepolia.mjs` replays the plan on a Sepolia node without sending
anything. All eight contracts are source-verified on Etherscan.

| # | What it shows | Transaction | Block | Result |
|---|---|---|---|---|
| 1 | Old mainnet client initialized at a checkpoint: set 3894, its 10 keys (the one trusted, admin step) | [`0xc4d1d212…`](https://sepolia.etherscan.io/tx/0xc4d1d212c5d2f2c0e0cb47aee6e7b21570dbdcad97fbabe5062a7ac84a75dac8) | 11,934,329 | success |
| 2 | Old mainnet set change 3894 → 3895 verified: 7 of 10 validator signatures | [`0x6851aa04…`](https://sepolia.etherscan.io/tx/0x6851aa0423528bec75ae5c459c75a9e056068c123a8ae701cbc1b722e21e6fce) | 11,934,330 | success, 6,322,745 gas |
| 3 | Old mainnet block #2,726,202 verified (7 of 10), and an account balance proven from its state root (System.Account, trie V0) | [`0x8ddd807e…`](https://sepolia.etherscan.io/tx/0x8ddd807e2880b51b397cfac898b857740f7bfd081cddd32dcc71d405ea980696) | 11,934,331 | success, 6,254,403 gas |
| 4 | Row 3 with one signature byte flipped | [`0x0062bc6c…`](https://sepolia.etherscan.io/tx/0x0062bc6c651569d186947506a7fabfce8c30985de3c0e68ac12c293c32696e95) | 11,934,332 | reverted: `InvalidSignature(0, 0)` |
| 5 | V3 testnet client initialized at a checkpoint: set 19, its 2 keys (the one trusted, admin step) | [`0x076e061f…`](https://sepolia.etherscan.io/tx/0x076e061f78eff113c15f59c88ca0a7ef8a71de876e7a35f1f6c6e8e24bc2ecfb) | 11,934,333 | success |
| 6 | V3 testnet set change 19 → 20 verified: 2 of 2 validator signatures | [`0xbcd75f28…`](https://sepolia.etherscan.io/tx/0xbcd75f28b0f387ecaea4404c8d42869182d7275999fe78cea9dab9bd0518bb66) | 11,934,334 | success, 2,394,089 gas |
| 7 | V3 testnet block #71,745 verified (2 of 2), and an account balance proven from its state root (System.Account, trie V1) | [`0xd4c6fef3…`](https://sepolia.etherscan.io/tx/0xd4c6fef3c9adb2b81a2d4cf57b4a1bdd82e1a2e96e4b8698c042f15bb2028991) | 11,934,335 | success, 2,298,856 gas |
| 8 | Row 7 with one signature byte flipped | [`0xddb3c231…`](https://sepolia.etherscan.io/tx/0xddb3c2310e5a1828af012d3fe3d2b141b2ab2e430be797b4185c3f53f0008a58) | 11,934,336 | reverted: `InvalidSignature(0, 0)` |

| Contract | Old Portaldot mainnet | Portaldot V3 testnet |
|---|---|---|
| `GrandpaLightClient` | [`0x3897…0ab6`](https://sepolia.etherscan.io/address/0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6) | [`0x4471…dcb0`](https://sepolia.etherscan.io/address/0x447171c4885ad725ee4772e8e3c228adee50dcb0) |
| `ProvenBalance` | [`0x40f4…86f0`](https://sepolia.etherscan.io/address/0x40f4b03aa20d3e7ce2503c406a4fe4a46ba886f0) | [`0x5b41…ad3c`](https://sepolia.etherscan.io/address/0x5b41d227248dc4775ef1061f2dfbf7136ccead3c) |

Linked libraries: `SCL_EIP6565` [`0x51da…b77e`](https://sepolia.etherscan.io/address/0x51da20be3e6e23296f2c435b16445aae7a18b77e) (ed25519), `GrandpaCodec` [`0x482a…dfd2`](https://sepolia.etherscan.io/address/0x482a1c993e169e962539c38efdb26e9e0621dfd2),
`AuthoritySets` [`0xf2cd…e6d2`](https://sepolia.etherscan.io/address/0xf2cd69bc5ff06f98e4dd0d4de42565d3338ce6d2), `StorageProofs` [`0x5da0…f2a3`](https://sepolia.etherscan.io/address/0x5da053bc5659ba9f725e4b1b5083545b933ef2a3).

- `initialize` is the one trusted step: the admin sets the first validator set and a checkpoint
  header. After it, a header is accepted only with enough valid signatures from the current set.
- The V3 testnet has 2 GRANDPA validators.
- Rows 1 to 8 use captured blocks (old mainnet: Oct 14; V3 testnet: Oct 17).

### Following the live chains

Sepolia blocks 11,943,046 to 11,943,083, Oct 18, sent by the relayer
(`npm run relay -- --chain mainnet|v3`, in [`relayer/`](relayer)). A run reads the light client's
state on Sepolia, finds every validator-set change on the Portaldot chain since the client's latest
block, and imports them in order, each with the justification the chain stores for it. It then
imports the finalized head. Before anything is signed, the whole plan runs on a Sepolia node with
`eth_simulateV1`. Each transaction is recorded in
[`deployments/relay-sepolia-0xd983….jsonl`](deployments/relay-sepolia-0xd9838a86cf83c28ee486544060d1ca4ca2971071.jsonl).
All 15 cost 0.00000007 Sepolia ETH in total.

| # | What it shows | Transaction | Block | Result |
|---|---|---|---|---|
| 9 | Old mainnet set change 3895 → 3896 at #2,726,491: 7 of 10 signatures | [`0xf9cfea23…`](https://sepolia.etherscan.io/tx/0xf9cfea2374c32b113475e841f7ae455ed3cc9422abcd424575ffb693f6fb08e6) | 11,943,046 | success, 6,325,153 gas |
| 10 | Old mainnet set change 3896 → 3897 at #2,727,211: 7 of 10 signatures | [`0xb960fa66…`](https://sepolia.etherscan.io/tx/0xb960fa660bb0968164a4a665793992e3f7bec5ee5981cb642f1a370da3ffc7c6) | 11,943,047 | success, 6,326,980 gas |
| 11 | Old mainnet set change 3897 → 3898 at #2,727,931: 7 of 10 signatures | [`0xffd4427e…`](https://sepolia.etherscan.io/tx/0xffd4427e2ea3350aa1dc8e030eba7f9dcb5b67651a940dfa98a254835621b107) | 11,943,048 | success, 6,321,564 gas |
| 12 | Old mainnet set change 3898 → 3899 at #2,728,651: 7 of 10 signatures | [`0x699bf194…`](https://sepolia.etherscan.io/tx/0x699bf1946a849f855c6608a97e39e76adcb952a875c5b63cd5304e37bc15488e) | 11,943,050 | success, 6,322,253 gas |
| 13 | Old mainnet set change 3899 → 3900 at #2,729,371: 7 of 10 signatures | [`0xff2f97ec…`](https://sepolia.etherscan.io/tx/0xff2f97ecdfc96ae4dd86b8e35cd963241bcf7e4ea5560d50f2e152ccf742fe3f) | 11,943,051 | success, 6,322,726 gas |
| 14 | Old mainnet set change 3900 → 3901 at #2,730,091: 7 of 10 signatures | [`0x055c6793…`](https://sepolia.etherscan.io/tx/0x055c67936bfa4ad39daac0ce0fd5f2266c6220504e0ca09bbab8aa1f47fa26a0) | 11,943,052 | success, 6,312,979 gas |
| 15 | Old mainnet set change 3901 → 3902 at #2,730,811: 7 of 10 signatures | [`0x8d905bdf…`](https://sepolia.etherscan.io/tx/0x8d905bdf6ece7c2f152cb790f1a556e8824596233a250216958312388fc2ef70) | 11,943,053 | success, 6,322,906 gas |
| 16 | Old mainnet set change 3902 → 3903 at #2,731,531: 7 of 10 signatures | [`0x4a7ae5fe…`](https://sepolia.etherscan.io/tx/0x4a7ae5fe063e4e4021c37a88925de4d2e2400cb17022bc350b09d759dec302aa) | 11,943,054 | success, 6,323,348 gas |
| 17 | Old mainnet block #2,731,989 verified (7 of 10): the live finalized head | [`0xffa0182e…`](https://sepolia.etherscan.io/tx/0xffa0182eea663e5f2b1fda4c44bd9ae091b3ae31548374639a3fe291e22f39de) | 11,943,055 | success, 5,791,275 gas |
| 18 | V3 testnet set change 20 → 21 at #75,119: 2 of 2 signatures | [`0x9ea49f1c…`](https://sepolia.etherscan.io/tx/0x9ea49f1cdf94ab9249460224da62c3f9c6d7e3e0d44f629491cd6c28a8d7dc15) | 11,943,078 | success, 2,391,213 gas |
| 19 | V3 testnet set change 21 → 22 at #78,695: 2 of 2 signatures | [`0xc3c4fd71…`](https://sepolia.etherscan.io/tx/0xc3c4fd7187b89cd421dd66168ce5b3666049764c5525b984d6f00d4e212b9ff7) | 11,943,079 | success, 2,394,850 gas |
| 20 | V3 testnet set change 22 → 23 at #82,282: 2 of 2 signatures | [`0xb20bfd53…`](https://sepolia.etherscan.io/tx/0xb20bfd5367381fb6c66f429d130b1d7894973363146c7690136e11040681af2d) | 11,943,080 | success, 2,392,394 gas |
| 21 | V3 testnet set change 23 → 24 at #85,859: 2 of 2 signatures | [`0xf61beb52…`](https://sepolia.etherscan.io/tx/0xf61beb52b3775f12cbb1087af8d0e4cf2413cbe211e4de9d85d57322b9dbf8f1) | 11,943,081 | success, 2,392,238 gas |
| 22 | V3 testnet set change 24 → 25 at #89,440: 2 of 2 signatures | [`0x65e47bcb…`](https://sepolia.etherscan.io/tx/0x65e47bcb17736b714fd07a45489a7e6d16950e91d8e5ca99949245e983c3add7) | 11,943,082 | success, 2,392,423 gas |
| 23 | V3 testnet block #92,604 verified (2 of 2): the live finalized head | [`0x493d1fb0…`](https://sepolia.etherscan.io/tx/0x493d1fb0850ab3ed73f34f4c8e7bd322cf341923c5ca896675c4cd5ea183dbc0) | 11,943,083 | success, 1,878,952 gas |

The old mainnet changes its validator set every 720 blocks (about 12 hours) and keeps the same
10 keys; the V3 testnet does so about every 6 hours with its 2 keys. Every change has to be
imported in order: a client that skips one can no longer verify the next set's signatures.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project: light client, proof verification, bridge contracts |
| `relayer/` | TypeScript: fetches finality and storage proofs from Portaldot nodes, and relays finality to the Sepolia light clients |
| `fixtures/` | Captured chain data used by the tests, each file with its source |
| `deployments/` | Sepolia records: deployment addresses, transactions and gas, and the relayer's transactions |
| `docs/` | Gas measurements, deployment notes, decisions |

## Third-party code

Every third-party library is listed in [NOTICE.md](NOTICE.md) with its source,
pinned commit and licence. Commits that add third-party code start with `vendor:`.

## Licence

The project licence (Apache-2.0) will be added with the final submission. Third-party
code keeps its own licence, listed in [NOTICE.md](NOTICE.md).
