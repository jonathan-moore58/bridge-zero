# Business model

Who Bridge Zero is for, what they would pay for, what it costs to run, and the plan for the three
months after the hackathon. Today everything runs on testnets and charges no fee. Measured facts
name the README rows or docs they come from. Numbers marked **(est.)** are estimates, with their
assumptions. Other bridges' fees were read on Oct 24, 2026 from the sources linked.

## Who it is for

| User | What they get | Today |
|---|---|---|
| POT holders | POT on Ethereum as wtPOT (an ERC-20) to hold, trade or lend in EVM wallets and apps, and a way back | Live on the testnets: the way in in 48 seconds, proven (rows 54 and 55), or with auto-mint, where the user signs only the lock and needs no ETH, in 144 seconds (rows 83 to 85); the way back in 84 seconds in fast mode for up to 1 tPOT (rows 56 to 58), or about 20 minutes (rows 47 to 51) |
| EVM apps and wallets | Portaldot state inside a contract (an account's balance, a contract's storage), checked against Portaldot's finality instead of an oracle or a relayer | Live: `ProvenBalance` and `BridgeMinter` on Sepolia read V3 state through the light client |
| Portaldot | A path for EVM users and liquidity into POT, built on V3's own GRANDPA finality and its EVM (pallet-revive) | Live on the V3 testnet |
| Liquidity providers | A fee for paying a user on V3 at once, repaid from the vault about 20 minutes later | Planned: LP fast-fill ([Roadmap](../README.md#roadmap)) |

## What users would pay for

| Line | Who pays | Level | Needs |
|---|---|---|---|
| Bridge fee | every transfer | 0 to 5 basis points (bps); Stargate charges 6 | a new vault and minter (v2); 0 on the testnet |
| Instant fee | users who choose Instant on the way back | the LP quotes 5 to 30 bps; the protocol keeps 10 to 20% of it (est.) | no contract change: the vault's `release` pays any address |
| Network fee | every transfer, or an app that sponsors it | at cost, plus a margin | covers the mint's Ethereum gas and the release's costs on V3 (below) |
| Light-client service | chains, apps and wallets that read proven Portaldot state on an EVM chain | per integrator, priced above the relayer's gas (below) | the proof kit ([PROOF-KIT.md](PROOF-KIT.md)): in the repository and tested, its Reader not on Sepolia yet; a hosted proof API and a freshness agreement are not built |
| Grants | ecosystem programs | per program | from month 1 |

## The market

| Bridge | Fee | Speed | What users trust | Source |
|---|---|---|---|---|
| Across | 0.0100% for 1,000 USDC Ethereum→Optimism; 0.0083% for 1 WETH Ethereum→Arbitrum; 0.032% for 100 USDC Arbitrum→Ethereum | 2 to 7 s (estimated by Across) | relayers, settled through UMA's optimistic oracle | live quotes from Across's public API (`app.across.to/api/suggested-fees`); [fees](https://docs.across.to/introduction/fees) |
| Stargate | 6 bps per transfer (4 treasury, 1 veSTG, 1 LP), plus a rebalancing fee when pools are uneven | minutes | LayerZero's verifiers | [protocol fees](https://stargateprotocol.gitbook.io/stargate/user-docs/tokenomics/protocol-fees) |
| Hop | bonder fee 0.05 to 0.30%, minimum $0.25 | minutes | bonders, then the rollup's bridge | [fees](https://docs.hop.exchange/basics/fees) |
| Snowbridge (Polkadot↔Ethereum) | about $0.50 Ethereum→Polkadot and $1.00 Polkadot→Ethereum; a fast lane in development, 1 to 2 minutes for $10 to $20 | about 35 minutes Polkadot→Ethereum | light clients both ways | [Snowbridge V2 is live](https://forum.polkadot.network/t/snowbridge-v2-is-live/15844), Nov 7, 2025 |

What this shows:

- On deep routes, speed is cheap: Across charges about 1 bp.
- Bridges that check proofs are slow, and their users pay for speed: Snowbridge plans to charge
  $10 to $20 for a 1 to 2 minute lane.
- POT is a new asset with little liquidity, so an Instant fee should start nearer Hop's level
  (5 to 30 bps) than Across's.
- Bridge Zero's place: the way in is proven by a light client, with no relayer to trust. The way
  back offers Standard (the committee, after Sepolia's finality) and, planned, Instant, where a
  liquidity provider is paid to carry the wait and the vault never pays before finality.

## What it costs to run

Prices for Ethereum mainnet assume 1 gwei and ETH at $3,000 (est.). Sepolia's fees are near zero.

- **A proven mint:** 2,391,069 gas (lock 1, row 55), about $7.20 on Ethereum mainnet and cents on
  an L2 (est.). This is why L2s are the first chains after Sepolia.
- **Keeping the light client on V3's validator set:** V3 changes its set about every 6 hours, and
  each change costs about 2.39M gas to import, so about 9.6M gas a day: about $870 a month on
  Ethereum mainnet, and under $10 a month on an L2 (est.). The hourly head imports that keep reads
  fresh would add about 45M gas a day at the same price; they are optional, since a mint brings its
  own header.
- **A lock on V3:** a 3.8415 tPOT storage deposit for its commitment, paid by the user, and a fee of
  about 0.023 tPOT ([docs/V3.md](V3.md#costs)). A deposit is not a fee: pallet-revive returns it
  when the item is cleared. A v2 vault could clear old commitments and return their deposits (an
  idea, not designed yet).
- **A release on V3:** about 0.066 tPOT in approval fees, and a 3.8415 tPOT deposit for
  `released[burnId]` ([docs/V3.md](V3.md#costs)).
- **LP capital:** the vault repays a fill about 20 minutes after the burn, so one tPOT of inventory
  can serve about 72 fills a day (est.).

## Revenue scenarios (est.)

Assumptions: a 5 bps bridge fee on all volume; 40% of the volume chooses Instant at a 20 bps fee,
and the protocol keeps 15% of that fee.

| Monthly volume | Bridge fee | Share of Instant fees | Total per month |
|---:|---:|---:|---:|
| $100k | $50 | $12 | about $62 |
| $1M | $500 | $120 | about $620 |
| $10M | $5,000 | $1,200 | about $6,200 |

On an L2, fees cover the running costs early. They would pay for one developer only from about $10M
a month.
Until then the work is paid for by grants, prizes and the light-client service.

## The three months after the hackathon

**Month 1, Nov 10 to Dec 9: harden what is live**

- LP fast-fill on the way back, first with time windows kept off-chain, then settled on chain by a
  small contract on V3; more than one LP, with quotes.
- The proof kit as packages: an npm package and a command line from the TypeScript in the
  repository, and the Reader on more chains (v0.1, the library, the Reader, the example gate and
  `npm run kit`, is in the repository: [PROOF-KIT.md](PROOF-KIT.md)).
- Grant applications; the threat model and audit preparation.

**Month 2, Dec 10 to Jan 9: v2 contracts and more chains**

- A v2 vault and minter: the fee the user allows, in the lock's commitment (fast-fill for the way
  in); a bridge fee in bps, paid to a treasury; a network fee.
- The first L2 mainnet, Base. Base Sepolia has run the V3 light client and the way in since Oct 27,
  and the way back since Oct 28 ([Status](../README.md#status)).
- A BEEFY verifier prototype, to cut the gas of each import.
- A light client for Portaldot's V3 mainnet, from its own checkpoint.

**Month 3, Jan 10 to Feb 9: a guarded mainnet**

- An outside audit of the light client, the trie code, the vault and the minter.
- Admin keys behind a timelock or a multisig; committee keys held by independent members.
- A mainnet launch with caps on the total value and on each transfer; 2 or 3 LPs.
- One or two pilots with a wallet or an app that reads proven Portaldot state.
- Measured each week: volume, the share that chooses Instant, LP use and time to fill.

## Running it

What the testnets already show:

- The relayer has run in watch mode since Oct 23, one process per light client, each with its own
  key; the auto-release watcher has run since Oct 24 ([README](../README.md#status)).
- 126 numbered transactions are in the README's [evidence](../README.md#evidence), each with its
  hash, on Sepolia, the V3 testnet, Base Sepolia and Arbitrum Sepolia; 370 forge tests, 380 relayer
  tests and 384 fixture checks pass.
- The limits are written down, including a six-hour gap while the machine slept on Oct 24
  ([Known limits](../README.md#status), [what the minter trusts](BRIDGE.md#what-the-minter-trusts),
  [the trusted return path](BRIDGE.md#the-trusted-return-path)).

What has to change before real value: committee members who are independent of each other, an
outside audit, light-client admins behind a timelock, and more than one machine for the relayer
and the watcher.

## Risks

- **Demand.** POT has little liquidity and volume is unknown. Start on L2s, where running costs are
  cents, and pay for the work with grants until volume grows.
- **The way back is trusted.** The committee can release to any address. On the testnet one
  operator holds all three keys. The plan: independent members, then a proven way back through an
  Ethereum light client on Portaldot (After the event, in the [Roadmap](../README.md#roadmap)).
- **Chain changes.** A reset of the V3 testnet, or a change to how V3 finalizes blocks, would stop
  the light client until it gets a new checkpoint.
- **Ethereum mainnet gas.** A mint costs about $7 there (est.). L2s come first.
- **Unaudited code.** Caps on the total value and on each transfer until an outside audit.
- **LP risk.** A Sepolia reorg after the LP pays, or a committee that does not release, costs the
  LP, not the user. The LP chooses how many confirmations to wait and prices that into its fee.
