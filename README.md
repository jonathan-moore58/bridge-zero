# Bridge Zero

A Portaldot light client on Ethereum. Solidity contracts check Portaldot's GRANDPA
finality (the validators' signatures) and Substrate storage proofs, so an EVM
contract can use Portaldot state without a trusted relayer: trust rests on the
Portaldot validator set.

Built for the Portaldot Hacker House 2026, Multi-Chain & Cross-Chain Infra track.
Development runs from Oct 14 to Nov 6, 2026; this repository starts on Oct 14.

## Status

Work in progress. Evidence (contract addresses and transaction hashes) will be
listed here as each part goes on chain.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project: light client, proof verification, bridge contracts |
| `relayer/` | TypeScript: fetches finality and storage proofs from Portaldot nodes |
| `fixtures/` | Captured chain data used by the tests, each file with its source |
| `docs/` | Gas measurements, deployment notes, decisions |

## Third-party code

Every third-party library is listed in [NOTICE.md](NOTICE.md) with its source,
pinned commit and licence. Commits that add third-party code start with `vendor:`.

## Licence

The project licence (Apache-2.0) will be added with the final submission. Third-party
code keeps its own licence, listed in [NOTICE.md](NOTICE.md).
