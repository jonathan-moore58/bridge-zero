# Deploy it yourself

How to build Bridge Zero, use its tools against the live deployment, deploy a copy of your own, and
run the operator's processes, on a Linux server too. The tools are the repository's own
(`contracts/script/`, `npm run <tool>` in `relayer/`, `ops/server/`), shown with the flags their
code takes; the header of each one lists every option. A command without `--send` is a dry run and
signs nothing.

Testnet only, and unaudited. What a deployment proves and what it trusts is in the
[README](../README.md#how-it-works) and in [BRIDGE.md](BRIDGE.md#what-the-minter-trusts); a copy of
your own trusts you where this one trusts its operator: the light clients' admin and the committee.

## What a deployment is

| Piece | Where | Made by | Record |
|---|---|---|---|
| `GrandpaLightClient` #2, which follows the V3 testnet, and `ProvenBalance` #2, with the linked libraries `SCL_EIP6565`, `GrandpaCodec`, `AuthoritySets` and `StorageProofs` | each EVM chain; Sepolia also has #1, for the old Portaldot mainnet | `contracts/script/deploy-sepolia.mjs` | `deployments/<network>.json` |
| `PortaldotVault` | the V3 testnet | `npm run v3-vault -- deploy` | `deployments/v3-testnet.json` |
| The committee: 3 members, a 2-of-3 pallet-multisig account whose address is the vault's `RELEASER` | the V3 testnet | three sr25519 keys, named at the vault's deployment | `deployments/v3-testnet.json` |
| `BridgeMinter` and `WrappedTPOT` (wtPOT) | each EVM chain | `npm run mint -- deploy` | `deployments/<network>-bridge.json` |
| `PortaldotStateReader` and `ProvenAssetGate`, the proof kit (optional) | Sepolia | `contracts/script/deploy-kit.mjs` | `deployments/sepolia-kit.json` |
| A relayer for each light client | any machine | `npm run relay` | `~/.bridge-zero/relay-<network>-<sender>.json` and `.jsonl` |
| Auto-mint | any machine | `npm run automint` | `~/.bridge-zero/automint-<network>-<sender>.json` and `.jsonl` |
| The release watcher, with members 1 and 2 | one machine | `npm run release -- release --watch` | `deployments/v3-testnet.json`, `~/.bridge-zero/release-watch-*` |
| The status page and the bridge app | GitHub Pages | `site/`, `.github/workflows/pages.yml` | built from `deployments/`, `fixtures/` and the README |

## Before you start

**Tools.**

- Node.js 24 (the packages' `engines`; CI runs 24).
- Foundry 1.8.5: `forge` builds and tests, and `cast` signs every EVM transaction the tools send,
  so it has to be on `PATH`. `foundryup --install 1.8.5` installs it; forge fetches solc 0.8.27 on
  first use.
- git, for the four pinned libraries ([NOTICE.md](../NOTICE.md)).

**Keys.** Each process has a key of its own, and the tools refuse some mixes.

| Key | Kind | Signs | Notes |
|---|---|---|---|
| Deployer | a Foundry keystore (`cast wallet import <name> --interactive`, or `cast wallet new ~/.foundry/keystores <name>`) | the EVM deployments, at fixed nonces | the light clients' admin: the relayer warns, and auto-mint refuses, when it is the sender |
| Relayer | a Foundry keystore, one for each light client on Sepolia | the imports into the light clients | one key can serve the rollups as well: its record, history and lock are per network |
| Auto-mint | a Foundry keystore | the mints for locks | auto-mint refuses a key a relayer has sent with |
| V3 deployer and funder | a JSON file `{"substrate": {"mnemonic": "<12 to 24 words>"}}`, an sr25519 account | the vault's deployment, and the transfers of `release -- fund` | the tools never print it |
| Committee members 1, 2 and 3 | polkadot-js sr25519 keystores (the JSON Polkadot wallets export) and a password file | the release approvals on V3 | the watcher opens members 1 and 2 with one password file; member 3 stays elsewhere |

A password file holds the password alone: `cast` trims trailing whitespace, the release tool strips
one trailing line end, and neither takes a byte-order mark. Keep keystores, key files and password
files outside the checkout; `.gitignore` leaves out `.env` and `*.account*.json` as a backstop.

**Funds**, as this deployment measured them. Sepolia's and the rollups' fees were near zero (the
mint of lock 0 paid 1,015 wei per gas); each dry run prints the gas, the fees and the balance it
needs, and the tools check balances against the gas limit at their maximum fee.

| Who | What it took or keeps |
|---|---|
| EVM deployer, on Sepolia | the light clients' 16 transactions took 118,743,558 gas and BridgeMinter and wtPOT 12,990,292: 0.000000135 ETH at about 1,000 wei per gas |
| EVM deployer, on a rollup | 0.01 ETH covered the light client's 8 transactions (0.0000615 ETH on Base Sepolia, 0.000247 on Arbitrum Sepolia), the minter and wtPOT (0.0000094 and 0.0000376 ETH) and 0.008 ETH for the relayer's key |
| Relayer | `--keep` in reserve (by default 0.05 ETH on Sepolia, 0.001 on a rollup) above what a run's plan costs at its maximum fee; on Sepolia a V3 set change takes about 2.39M gas, a head about 1.87M |
| Auto-mint | `--keep` (by default 0.05 ETH on Sepolia, 0.0002 on a rollup) above each send at its maximum fee, and at most `--max-spend` a day (0.02 and 0.002 ETH); a mint takes about 0.6M gas at a header the client holds, about 2.5M with the import |
| V3 deployer | a little over 86 tPOT: the vault's storage deposit, 83.232 tPOT, with 2% above it as the limit, a fee of about 0.13, the existential deposit (0.1) and 1 tPOT the tool keeps |
| The committee's multisig | up to 3.9415 tPOT of storage deposit for each release (20 tPOT covered the first five) |
| Member 1 | 9.403 tPOT free to open a release, 9.27 of it returned when the release runs; 18.71 free to open one on another chain while one is open |
| Member 2 | 0.134 tPOT for each release |
| A locker | 11.5245 tPOT of storage deposit for the vault's first lock, 3.8415 for each later one, and a fee of about 0.023 tPOT |

**RPCs.** The tools use public endpoints unless told otherwise: each EVM network's are in `NETWORKS`
([`contracts/script/lib/sepolia.mjs`](../contracts/script/lib/sepolia.mjs)), and V3's node and EVM
RPC are `wss://test-node-v3.portaldot.dev` and `https://test-evm-rpc-v3.portaldot.dev`.
`SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL` and `ARBITRUM_SEPOLIA_RPC_URL` replace a network's first
RPC; `SEPOLIA_ARCHIVE_RPC_URLS` and the rollups' `..._ARCHIVE_RPC_URLS` (comma separated) the RPCs
asked for old receipts and state; `--rpc` and `--evm` the V3 node and its EVM RPC. Of a URL given
this way only the host is printed, as a URL can carry a key. `ETHERSCAN_API_KEY` is read for source
verification only.

## 1. Build and test

No keys and no chain access. `.github/workflows/ci.yml` runs the same on every push.

```sh
git clone https://github.com/jonathan-moore58/bridge-zero
cd bridge-zero
git submodule update --init                                   # the four pinned libraries

cd contracts
FOUNDRY_PROFILE=v3 forge build --skip test --skip script        # out-v3: the vault's V3 build, which its tests check
forge build
forge test
FOUNDRY_PROFILE=sepolia forge build --skip test --skip script   # out-sepolia: the deployment build, libraries linked

cd ../relayer
npm ci
npm run typecheck
npm test
npm run check -- --dir ../fixtures/v3-testnet-hero              # and each directory in the README's table
npm run kit -- check --dir ../fixtures/v3-testnet-kit

cd ../site
npm ci
npm run check
npm run build                                                 # site/dist: both pages, served under /bridge-zero/
```

The README's [Verify it yourself](../README.md#verify-it-yourself) has the counts the relayer's and
the contracts' tests and checks print. The two skipped forge tests fork Sepolia: they run with
`SEPOLIA_FORK=1` and a Sepolia RPC. In `site/`, `npm run dev` serves both pages on
`http://localhost:5173/bridge-zero/`.

## 2. Use the live deployment

The tools read the records in `deployments/`, so a clone follows the live deployment as it is.
With no key, from `relayer/`:

```sh
npm run mint -- status                    # the minter, wtPOT and the vault's locks; --network base-sepolia|arbitrum-sepolia
npm run release -- status                 # the burns, their releases on V3, the committee's balances
npm run v3-vault -- status                # the vault: every lock and release, and its accounting
npm run relay -- --chain v3 --from 0xE94a82E2c7f38f777E8845A9d8c36B6be6a30257
npm run relay -- --network base-sepolia --chain v3 --from 0xE94a82E2c7f38f777E8845A9d8c36B6be6a30257
npm run automint -- --network sepolia,base-sepolia,arbitrum-sepolia
npm run release -- release --watch 15 --rounds 1 --network sepolia,base-sepolia,arbitrum-sepolia --confirmations sepolia=3,base-sepolia=180,arbitrum-sepolia=144
```

A relay dry run plans the next run and has the network's node run it, from the nonce and balance of
`--from` (by default the deployer; `0xE94a…0257` is the relayer's key). The auto-mint line is one
round, the watcher's one round of each chain, both dry runs.

Nothing in the contracts limits who relays or mints. With a Foundry keystore of your own that holds
a little ETH, `npm run relay -- --chain v3 --send --account <keystore> --password-file <file>`
imports into the live light client, and `npm run mint -- mint --nonce <n> --send --account
<keystore> --password-file <file>` (with `--network` on a rollup) mints lock n for the recipient its
commitment names. A sender that races another loses only gas: the light client imports a header
once, and the minter mints a nonce once (`NonceAlreadyUsed`). The way back is not open to everyone:
only the committee releases on V3.

## 3. Deploy your own

This deployment ran the steps below between Oct 17 and Oct 31, 2026; the README's
[Evidence](../README.md#evidence) has every transaction. The tools are written around its records
and accounts, so a copy with other accounts changes these first. No copy has been deployed this
way yet: each tool's dry run is the check.

| What | Where | Why |
|---|---|---|
| This deployment's records | `deployments/*.json` and `*.jsonl`: move them away | the tools read and write them; `deploy-sepolia.mjs --send` refuses over an existing `deployments/<network>.json`, and `v3-vault deploy --send` while `deployments/v3-testnet.json` holds a vault |
| The deployer | `DEPLOYER` in `contracts/script/deploy-sepolia.mjs` (and in `deploy-kit.mjs`) | the plan's sender; the records it writes name it for the other tools |
| The libraries' addresses | `[profile.sepolia]` `libraries` in `contracts/foundry.toml`: `cast compute-address <deployer> --nonce 0`, then `--nonce 1`, `2` and `3` | the deployment build links them at compile time, so that a source verification compiles the same bytes; the deployer's first four transactions on each chain create them |
| The minter's and wtPOT's nonces | `PAIR_NONCES` in `relayer/src/mint.ts` | the deployer's nonces that create them: here 31 and 32 on Sepolia, 9 and 10 on the rollups |
| The checkpoint | `PLANS` in `deploy-sepolia.mjs`, the fixture directory each network's light client starts from | from an old checkpoint the relayer has every set change since to import (V3 changes its set about every 6 hours), and it stops past `--scan-limit` (100,800 V3 blocks, about a week) |
| The V3 accounts | `--from` of `v3-vault deploy` and `lock`, and of `release -- fund` and `burn`; `--committee` and `--threshold` of `v3-vault deploy` | the defaults name this deployment's (`DEFAULT_DEPLOYER`, `DEFAULT_LOCKER` and `COMMITTEE` in `v3-vault.ts`, `DEFAULT_FUNDER` and `DEFAULT_SENDER` in `release.ts`) |
| The pages | `site/src/app/dests.ts` (each destination's contracts and RPCs), `base` in `site/vite.config.ts`, the repository links in `site/build/records.ts` and `site/src/app/facts.ts` | both pages are built from this deployment's records and the README's evidence rows ([site/README.md](../site/README.md)) |

### 3.1 A checkpoint

A light client starts from a V3 validator set and a block that set finalized, installed by its admin
(`initialize`, the one trusted step); from there it takes a header only with valid signatures of the
set it follows. Capture one into a new directory, then check it offline, from `relayer/`:

```sh
npm run capture -- --rpc wss://test-node-v3.portaldot.dev --out ../fixtures/<new directory>
npm run check -- --dir ../fixtures/<new directory>
```

`capture` reads, at the finalized head: its finality proof, the authority set, the latest set change
with its justification and the one before, and an account's balance proof (`--account <0x account
id>`, else the sudo key's account). It signs nothing, and without `--out` it writes over
`fixtures/mainnet`, a test fixture. Name the new directory in `PLANS`: on the rollups (`V3_NOW`,
which was `v3-testnet-set59`), `initialize` installs the set that signed the captured head, at the
set change that started it, and `importAndProve` verifies the head and proves the balance.

### 3.2 The light client on each EVM chain

From `contracts/`, after the deployment build, with the deployer at nonce 0 on that chain:

```sh
node script/deploy-sepolia.mjs --network base-sepolia
node script/deploy-sepolia.mjs --network base-sepolia --send --account <deployer keystore> --password-file <file>
node script/deploy-sepolia.mjs --network base-sepolia --verify          # with ETHERSCAN_API_KEY set
```

The dry run has the network's node run every step with `eth_simulateV1`, from the deployer's own
nonce and balance, and refuses a build that does not link the libraries where the deployer's nonces
put them. `--send` sends the steps one at a time, records each in `deployments/<network>.json` when
it is sent and when it is mined, and checks each receipt; `--resume` continues a run that stopped. A
rollup's plan is 8 transactions, nonces 0 to 7: the four libraries, `GrandpaLightClient` #2,
`ProvenBalance` #2, `initialize` and `importAndProve`. Sepolia's (no `--network`) adds the old
mainnet's client #1, and on each client a set change imported and a tampered import mined as a
failed transaction. The tools' exit codes: 0 done, 1 a check failed or the tool refused, 2 a node
could not be reached, 3 a sent transaction is still pending.

Then a relayer brings the client to V3's current set, with a key of its own (here the deployer
funded it at its nonce 8 on each rollup), from `relayer/`:

```sh
npm run relay -- --network base-sepolia --chain v3 --from <relayer address>
npm run relay -- --network base-sepolia --chain v3 --send --account <relayer keystore> --password-file <file>
```

### 3.3 The vault and the committee, on V3

The vault is the v3 profile's build (`out-v3`, 899 bytes of runtime code). Its `RELEASER`, the only
caller `release` accepts, is fixed at deployment: the committee's multisig, given with its members
in the order of members 1, 2 and 3. From `relayer/`:

```sh
npm run v3-vault -- deploy --committee <member 1>,<member 2>,<member 3> --threshold 2 --committee-multisig <multisig ss58> --releaser <multisig h160> --from <deployer ss58>
npm run v3-vault -- deploy --committee <member 1>,<member 2>,<member 3> --threshold 2 --committee-multisig <multisig ss58> --releaser <multisig h160> --from <deployer ss58> --send --key-file <file>
```

The dry run derives the multisig from the members and the threshold, and refuses a
`--committee-multisig` or a `--releaser` that is not that account and its address, naming the right
one. It has V3's EVM RPC run the constructor, dry-runs the deployment from `--from`, and prints the
vault's address, the deposit and the fee. `--send` signs `revive.instantiateWithCode`, waits for
finality, checks the deployed code and writes the vault and its committee to
`deployments/v3-testnet.json`, where the release tool reads the committee. Then fund the multisig,
which pays each release's storage deposit, and members 1 and 2, which pay the fees and member 1's
deposit (each line without `--send` first):

```sh
npm run release -- fund --multisig --amount 20 --from <funder ss58> --send --key-file <file>
npm run release -- fund --member 1 --amount 10 --from <funder ss58> --send --key-file <file>
npm run release -- fund --member 2 --amount 1 --from <funder ss58> --send --key-file <file>
```

[V3.md](V3.md) has the vault's costs, its storage layout and the rules of a release.

### 3.4 BridgeMinter and wtPOT

A minter is bound for good, in its constructor, to the light client on its chain, the vault, V3's
chain id, the vault's code hash and its token, and wtPOT's only minter is the minter. A lock names
its destination chain and minter. On a rollup `mint deploy` creates both and reads no lock. On
Sepolia it requires a lock that names the minter's address to be, as lock 0 named
`CREATE(deployer, 31)` here: `v3-vault lock` (below) with `--any-destination`, as no
`deployments/*-bridge.json` records a minter yet.

```sh
npm run mint -- deploy --network base-sepolia
npm run mint -- deploy --network base-sepolia --send --account <deployer keystore> --password-file <file>
npm run mint -- status --network base-sepolia
```

The deployer has to be at the nonce `PAIR_NONCES` names. `--send` checks the code at each address
against the build and the constructor arguments, records both in
`deployments/<network>-bridge.json`, and prints the `forge verify-contract` command for each, run
from `contracts/` with `ETHERSCAN_API_KEY` set. [BRIDGE.md](BRIDGE.md#the-mint-tool) has the mint
tool's commands.

### 3.5 A first lock and its mint

```sh
npm run v3-vault -- lock --dst-chain 84532 --dst-minter <minter> --recipient <address> --amount 0.001 --from <locker>
npm run v3-vault -- lock --dst-chain 84532 --dst-minter <minter> --recipient <address> --amount 0.001 --send --account <keystore> --password-file <file>
npm run mint -- plan --network base-sepolia --nonce <n>
npm run mint -- mint --network base-sepolia --nonce <n> --send --account <keystore> --password-file <file>
```

The lock's dry run refuses a destination that no `deployments/*-bridge.json` records for this vault,
and a recipient that is a Substrate account's address on V3, which no Ethereum key holds. From a
Substrate account the lock is a `revive.call`: `--from <ss58>`, then `--send --key-file <file>`. A
minter's first mint also binds it to the vault, from a proof of the vault's account entry
(`VaultBound`). With auto-mint running (below), the last two lines are its work.

### 3.6 The proof kit (optional)

From `contracts/`, `node script/deploy-kit.mjs`, then with `--send --account <deployer keystore>
--password-file <file>`, then `--verify`, deploys `PortaldotStateReader`, bound to Sepolia's
`GrandpaLightClient` #2 and linked to its `StorageProofs`, and the example `ProvenAssetGate` on it.
Its dry run has the new Reader make five of the kit fixture's reads at V3 #264,729, the block that
fixture holds, so it passes only against a light client that imported that block; another
deployment changes the fixture, the block and the gate's arguments in the script.
[PROOF-KIT.md](PROOF-KIT.md) has the reads.

### 3.7 The pages

`npm run build` in `site/` builds the status page and the app from the records; the pages read the
chains from the visitor's browser and sign nothing themselves (the app's transfers are signed in
the visitor's wallet). `.github/workflows/pages.yml` deploys them to GitHub Pages on each push to
`main` that changes `site/`, `deployments/`, `fixtures/`, `contracts/src/` or the README, once Pages
is enabled with GitHub Actions as its source. Each page's Content-Security-Policy
(`site/build/csp.ts`) allows connections only to the RPCs in `site/src/lib/endpoints.ts` and those
`site/src/app/dests.ts` gives each destination.

### 3.8 Another EVM chain

A chain needs the BLAKE2F precompile, which the light client hashes headers with, and a
per-transaction gas limit its deployments fit in: under Sepolia's rules, which price new code high,
`GrandpaLightClient` took 15,039,331 gas of the 16,777,216 cap; on the rollups 2,136,019. Add it to
`NETWORKS` in `contracts/script/lib/sepolia.mjs` and its name to `NetworkName` in
`contracts/script/lib/sepolia.d.mts`: `npm run typecheck` in `relayer/` then names each table that
needs a row for it (`L1_KIND` in `l1.ts`, `PAIR_NONCES` in `mint.ts`, `WAYBACK` in `wayback.ts`,
its finality and fast-mode rule, and `START_BLOCKS`, `NETWORK_DEFAULTS` and `HOLD_MS` in
`automint.ts`). `PLANS` in `deploy-sepolia.mjs` needs one too, and the app a destination in
`site/src/app/dests.ts`. The BNB Smart Chain testnet is next on the roadmap, as a fourth
destination.

## 4. Run it

These keep a deployment going, each from its own key and from `relayer/`. The server's units
([`ops/server/`](../ops/server/README.md)) run the same tools with the same options.

The relayers, a run 10 minutes after each one ends: every set change in order, then the head once it
is `--head-every` blocks past the client's latest (600 on V3, 60 on the old mainnet):

```sh
npm run relay -- --chain v3 --send --watch 600 --account <relayer keystore> --password-file <file>
npm run relay -- --chain mainnet --send --watch 600 --keep 0.02 --account <mainnet relayer keystore> --password-file <file>
```

The rollups' clients, one run of each six minutes after each V3 set change (01:54, 07:54, 13:54 and
19:54 UTC), and again 20 and 40 minutes later:

```sh
npm run relay -- --network base-sepolia --chain v3 --send --account <relayer keystore> --password-file <file>
npm run relay -- --network arbitrum-sepolia --chain v3 --send --account <relayer keystore> --password-file <file>
```

Auto-mint, a round every 15 seconds: each new lock, once V3 has finalized it and 90 seconds more,
minted on the chain it names for the recipient it names, from a key that pays only the gas:

```sh
npm run automint -- --network sepolia,base-sepolia,arbitrum-sepolia --send --watch 15 --grace 90 --min-amount 0.001 --max-spend sepolia=0.02,base-sepolia=0.002,arbitrum-sepolia=0.002 --keep sepolia=0.01,base-sepolia=0.0002,arbitrum-sepolia=0.0002 --account <auto-mint keystore> --password-file <file>
```

The release watcher, a round every 15 seconds: each new burn gets every check of the release tool,
then members 1 and 2 approve its release on V3. A burn of up to 1 tPOT goes in fast mode, once 3
Sepolia blocks follow its own (on a rollup, 36 seconds of its blocks), while the fast releases not
final yet stay within 1 tPOT across the chains; any other waits for its chain's finality:

```sh
npm run release -- release --watch 15 --network sepolia,base-sepolia,arbitrum-sepolia --confirmations sepolia=3,base-sepolia=180,arbitrum-sepolia=144 --send --member-keys 1:<member-1.json>,2:<member-2.json> --password-file <file>
```

- **Records and restarts.** Each sender's record, history and lock are in `~/.bridge-zero`
  (`--state-dir`). Every send is recorded before it is broadcast, and a run settles what the one
  before left open before it does anything else, so a restart after a crash is safe. The locks work
  on one machine: each key runs on one machine only.
- **Stops.** With `--watch`, a relayer stops only on a sent transaction that failed its checks or a
  signing or record problem, and auto-mint only on a lost lock, a record it cannot write, a refused
  key or `cast` unable to sign. The watcher's exit code 4 is a stop for good: a fatal stop, which
  leaves a halt file that a member clears, or a key that does not open. After any other exit it is
  safe to restart ([BRIDGE.md](BRIDGE.md#fast-mode-and-the-auto-release-watcher)).
- **The live record.** The watcher writes `deployments/v3-testnet.json` in its own checkout: that
  copy is the one to commit.
- **Trust.** The watcher's machine holds members 1 and 2: whoever controls it and the password file
  can release up to the vault's outstanding tPOT. Member 3's key stays elsewhere, to cancel or step
  in.

Until Oct 31 these ran on a laptop started at logon; since 17:45 UTC on Oct 31, on a server.

## 5. On a Linux server

[`ops/server/`](../ops/server/README.md) holds the systemd units, timers and scripts that have run
these processes since Oct 31, with how to install them, where the keys go, how to move the processes
from one machine to another, and the standing procedures: health, an approval by hand, a code
update, a halt. In short: a user `ubuntu`, the checkout in `/home/ubuntu/bridge-zero` with `npm ci`
in `relayer/`, Node.js 24, `cast` in `~/.foundry/bin`, the keys in files of mode 600, and each
process a service that starts at boot and restarts after a crash, except the watcher after exit
code 4; a timer for the rollup runs, and a read-only health check every 15 minutes.

## What a copy proves and trusts

- **Proven** on each EVM chain: V3's finality, from the validators' signatures checked in Solidity,
  and each lock, from a storage proof under a finalized state root, before anything is minted.
- **Trusted:** the V3 validator set (2 validators on the testnet) and V3's sudo key; each light
  client's admin, the deployer, who sets its checkpoint and can pause it and install another; the
  committee, on the way back; and the vendored ed25519, BLAKE2b and trie code, treated as unaudited.
- **Testnet limits:** here one operator holds all three committee keys and one machine runs the
  processes, and a light client is as current as its relayer's last run.
