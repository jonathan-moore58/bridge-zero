# The status page

One static page that shows Bridge Zero working, from the chains themselves: the latest recorded
transfer from the V3 testnet to Sepolia with its measured steps, both light clients and how far
each is behind its chain, lock 0's run step by step, the mint's receipt decoded, the six tampered
and replayed mints called again from the browser, the old mainnet's validator set, what is checked
and what is trusted, the return path, the README's `cast` commands and its roadmap.

It signs nothing and connects no wallet. Every read is one of `eth_call`, `eth_getLogs`,
`eth_getStorageAt`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_blockNumber`
and Substrate `chain_getFinalizedHead`, `chain_getHeader`, `chain_getBlockHash`, `chain_getBlock`
and `state_getStorage`.

```
cd site
npm ci
npm run dev        # http://localhost:5173/bridge-zero/
npm run check      # type-check (browser and build code), the decoder, records and RPC tests
npm run build      # site/dist, served under /bridge-zero/
npm run preview    # the build, on http://localhost:4173/bridge-zero/
```

`.github/workflows/pages.yml` builds it on every push to `main` that touches `site/`,
`deployments/`, `fixtures/`, `contracts/src/` or the README, and deploys `site/dist` to GitHub
Pages once Pages is enabled with GitHub Actions as its source.

## Live, recorded, and where each value comes from

Every value says which it is: **Live** (read from a chain when the page loaded, with the endpoint
that answered, refreshed every 30 s for the heads and every 2 minutes for the state) or
**Recorded** (from the repository, because the live read failed). A recorded value is never shown
as a check that passed. `build/records.ts` reads, at build time,

| Source | What the page takes from it |
|---|---|
| `deployments/sepolia.json`, `sepolia-bridge.json`, `v3-testnet.json` | addresses, the mints (the newest one is the hero's card), the six reverted copies and their revert data, the locks, the vault, the burns, the committee's releases and funding |
| `deployments/relay-sepolia-*.jsonl` | every sender's history, merged: each client's latest run (one sender's) and newest import (with the mints' bundle blocks), the fallback for its state |
| `deployments/automint-*.jsonl` | auto-mint's histories, one for each chain (Sepolia, Base Sepolia, Arbitrum Sepolia): the locks it minted, counted in the totals with the amount and recipient each mint's attempt line gives (the V3 record's when that line is missing); Sepolia's in its wtPOT, every chain's in the vault's |
| `fixtures/v3-testnet-hero/`, `fixtures/v3-testnet-lock1/` | the bundles lock 0 and lock 1 were minted with: header, precommits, signers hint, proofs |
| `fixtures/mainnet/finality-proof-head.json`, `fixtures/probe/*.json` | the old mainnet's 10 keys (fallback for `authorities(setId)`), block times, sudo keys |
| `README.md` | the evidence rows, the "Verify it yourself" commands with the outputs it records, and the roadmap, in its words |
| `contracts/src/**/*.sol` | every `error` and `event` declaration: the ABI the page decodes reverts and logs with |
| `site/data/measured-runs.json` | the intervals the tools measured during lock 1's run (lock 10 s, finality 14 s, proofs 9 s, mint 15 s: 48 s) and the two blocks' timestamps |

`site/data/measured-runs.json` is the one file written for the page: `deployments/` records each
transaction and its block, not the intervals of a run; the README's "Lock to mint in 48 seconds"
section states them. The build checks the data file against the records (both transactions
recorded, the steps adding up, the blocks' numbers) and, when the README has that section, against
it: other numbers there fail the build. The page names its source next to the 48 s.

The README's "Verify it yourself" outputs are what cast printed the day they were written. Where
`deployments/` gives another value at build time (a later mint, burn or release), the page shows
the README's output and, under it, the records' value; the build log lists each one.

A record that does not have the expected shape fails the build. The page also recomputes in the
browser what it can: the locks' commitments (keccak-256), the child-trie key of `commitments[0]`
(keccak-256 then blake2b-256), the header's hash (blake2b-256), the burn id, and the GRANDPA
signatures of lock 0's mint and of the latest old-mainnet import (ed25519, `@noble/curves`,
loaded on demand). It reads the timestamps of lock 1's two blocks again: V3's `Timestamp.set`
from the block (`chain_getBlock`), Sepolia's from the mint receipt's logs.

## Endpoints

| Chain | Endpoint | Used for |
|---|---|---|
| Sepolia | `https://ethereum-sepolia-rpc.publicnode.com` | every state read, `eth_call` of the reverted mints |
| Sepolia | `https://sepolia.drpc.org`, `https://sepolia.gateway.tenderly.co` | fallbacks; old receipts and transactions (the public node keeps about a day); `eth_getLogs` for the old-mainnet client's latest import, from the relayer's latest recorded one on (tenderly first) |
| V3 testnet | `https://test-evm-rpc-v3.portaldot.dev` | the vault: `outstanding`, `commitments(n)`, slot 1, the `Locked` logs (each in the one block the records put it in), `released(burnId)` |
| V3 testnet | `https://test-node-v3.portaldot.dev`, then `wss://` | the finalized head, `Grandpa.CurrentSetId`, and lock 1's block |
| Old mainnet | `wss://mainnet.portaldot.io` | the head and set, over WebSocket: the node serves no HTTP |

Each answered a JSON-RPC call from a browser page on `http://localhost:4173` (Oct 20, 2026), and
the HTTP endpoints send `Access-Control-Allow-Origin` for any origin. A Content-Security-Policy in
the built page allows connections to these endpoints only, and scripts, styles and fonts from the
page itself.

Calls made to one endpoint within a few milliseconds of each other go out as one JSON-RPC batch
(up to 8 calls; 3 for drpc's free plan; none for the V3 node's HTTP endpoint, which refuses
batches), and the requests leave the browser's CORS preflight cache alone, so a page load costs a
few requests per node. An endpoint that answers a batch with anything but a batch answer gets its
calls one by one from then on.

## Design

Portaldot's colours: the mark's violet-to-blue gradient (`#6C27E2`, `#4A34F0`, `#2D68F4`) for
primary actions, the step being replayed and key figures, its light tints for focus rings; violet
`#B197FF` and lilac `#D6C9FF`/`#C9B8FF` accents on `#0D0C14` with violet-tinted surfaces. Three
meaning colours, as small signals only: green `#45E0A8` for what is verified, amber for what is
trusted, coral for what reverts. Text passes 4.5:1 on every surface. Sora for display and text,
Geist Mono for hashes and numbers, both preloaded. Motion is brief: the card's edge light goes
round once, a live dot pulses three times when its value arrives, the timing bar and the replay
run when asked; all of it stops under `prefers-reduced-motion`.

## Dependencies

Pinned to exact versions, each published at least two weeks before it was added; `overrides` in
`package.json` hold Vite's own `rolldown` and `postcss` to versions that are too. Runtime: `preact`,
`@noble/hashes` and `@noble/curves` (the relayer's versions), and Sora and Geist Mono from
Fontsource (`@fontsource-variable/sora` and `@fontsource-variable/geist-mono` 5.3.0, SIL Open
Font License 1.1, the Latin subset of each, served with the page). Build: `vite`, `typescript`,
`@types/node`. The tests use Node's own test runner.

`src/assets/portaldot.png` is the Portaldot mark, 128 px.

## Layout

| Path | Contents |
|---|---|
| `build/records.ts` | the build-time reader of the repository's records |
| `data/measured-runs.json` | the measured intervals of the timed run |
| `src/lib/` | the RPC client (`rpc.ts`), the live reads and their recorded fallbacks (`live.ts`), the ABI codec (`abi.ts`), SCALE and GRANDPA decoding (`scale.ts`, `calls.ts`), hashes, SS58, formatting |
| `src/sections/` | the page, one file per section |
| `src/components/` | icons, chain marks, the transfer legs, hashes, badges, tickers |
| `src/styles/` | the design tokens, base styles, components, the hero, the sections |
| `test/` | the decoder, records and RPC-client tests, with two Sepolia transactions captured as fixtures (`RECORDS_ROOT=<checkout> npm test` runs the records tests on another checkout's records) |
