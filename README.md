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
Next: the token bridge (a vault on the V3 testnet, a mint on Sepolia) and a relayer that keeps both
light clients current.

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
- These are captured blocks (old mainnet: Oct 14; V3 testnet: Oct 17). Following both chains live
  needs the relayer, which comes next.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project: light client, proof verification, bridge contracts |
| `relayer/` | TypeScript: fetches finality and storage proofs from Portaldot nodes |
| `fixtures/` | Captured chain data used by the tests, each file with its source |
| `deployments/` | Sepolia deployment record: addresses, transactions, gas |
| `docs/` | Gas measurements, deployment notes, decisions |

## Third-party code

Every third-party library is listed in [NOTICE.md](NOTICE.md) with its source,
pinned commit and licence. Commits that add third-party code start with `vendor:`.

## Licence

The project licence (Apache-2.0) will be added with the final submission. Third-party
code keeps its own licence, listed in [NOTICE.md](NOTICE.md).
