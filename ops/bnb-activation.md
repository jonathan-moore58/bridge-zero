# The BNB Smart Chain testnet: activation

The BNB Smart Chain testnet (chain 97) becomes Bridge Zero's fourth destination, after Sepolia,
Base Sepolia and Arbitrum Sepolia. The code is ready for it and nothing is deployed there yet: the
tools take `--network bsc-testnet`, the app has the destination configured and hidden (`HIDDEN` in
`site/src/app/dests.ts`), and the server runs none of it until its units name the chain. What is
left is sending, and this is the order to do it in: each send preceded by its dry run, each step
with what to check before the next.

- **Who sends.** The deployer `0xD9838A86cF83C28Ee486544060D1cA4Ca2971071` (keystore `bz-deployer`,
  on the laptop) deploys and funds; the relayer key `0xE94a82E2c7f38f777E8845A9d8c36B6be6a30257`
  (`bz-relayer`, on the server) imports; the auto-mint key `0x57cc2ba3B883339a9F32726E6d0d3A9EE861A113`
  (`bz-automint`, on the server) mints. The committee releases on V3, as for every chain.
- **Where.** The laptop is a checkout of `main` (`D:\bridge-zero`, Git Bash); the server is
  `ssh ubuntu@<server>`, checkout `~/bridge-zero`, as in [server/README.md](server/README.md).
  `<deployer password file>` stands for the deployer keystore's password file, wherever it is kept.
- **Before anything else** the code is on `main` and on the server: the server runs it with its
  units unchanged until step 7, and Sepolia's, Base Sepolia's and Arbitrum Sepolia's runs, command
  lines and state files stay as they are.

## What it costs, and what was measured

Measured on Nov 1, 2026, without sending: by `eth_simulateV1` on the official nodes and publicnode,
and on a local anvil fork of chain 97 (anvil 1.8.5, `--hardfork osaka`, whose prices equal the
chain's: the deploy dry run's gas there is the official nodes' to the unit). On the fork the whole
path ran from impersonated accounts (`anvil_impersonateAccount`, nothing signed): the deployment, the
relayer's and the auto-mint key's funding, the pair, a first mint from real V3 proofs, a burn, and
the tools' dry runs in between.

| Step | Gas | tBNB at 0.1 gwei |
|---|---|---|
| The light client, nonces 0 to 7: four libraries, GrandpaLightClient #2, ProvenBalance #2, `initialize` at set 75, `importAndProve` at #269,340 | 12,298,574 | 0.00123 |
| … of which the four libraries (2,064,643, 1,433,476, 1,277,278 and 1,810,064) | 6,585,461 | |
| … GrandpaLightClient #2 (9,518 bytes) and ProvenBalance #2 | 2,136,019 and 953,593 | |
| … `initialize`: set 75, 2 keys, checkpoint #266,908 | 504,776 | 0.00005 |
| … `importAndProve`: head #269,340, 2 of 2 signatures, System.Account (trie V1) | 2,118,725 | 0.00021 |
| The relayer key's funding (nonce 8), a transfer | 21,000 | |
| BridgeMinter (nonce 9) and WrappedTPOT (nonce 10) | 1,399,559 and 471,093 | 0.00019 |
| The auto-mint key's funding (nonce 11), a transfer | 21,000 | |
| **The deployer's gas, nonces 0 to 11** | 14,211,226 | **0.00142** |
| A V3 set change (`importHeader`), from the relayer key | 1,849,220 | 0.00018 |
| A head (`importFinalityProof`), from the relayer key (#269,993 on the fork: 1,695,739) | 1,695,727 | 0.00017 |
| A first mint (`importAndMint`, binding the vault), from the auto-mint key: the fork's, of lock 4's real V3 proofs at #270,009 | 2,661,628 | 0.00027 |
| A burn (52,822 used; `eth_estimateGas` 62,422, sent with 68,665) | 52,822 | 0.000005 |
| A day at the server's cadence: 4 set changes and 8 heads | 20,962,696 | 0.0021 |

The base fee there is always 0, and the validators include nothing below a priority fee of 0.1
gwei, which the tools use there (`tip` in `contracts/script/lib/sepolia.mjs`): 1M gas costs 0.0001
tBNB. About 0.3 tBNB covers the deployment and about 110 days at this cadence with two locks a day:
0.1 to the relayer key (about 46 days of runs), 0.05 to the auto-mint key, and about 0.14 kept by
the deployer for top-ups.

The fork's first mint names chain 84532 (lock 4, a Base Sepolia lock): no lock names chain 97 yet,
and the minter checks the lock's commitment against `block.chainid`, so the fork answered 84532 for
that one call (`anvil_setChainId`). The EVM, the proofs and the gas are the BNB Smart Chain testnet
fork's.

## 0. Before the tBNB: a rehearsal on a fork (optional, no keys)

From the laptop, in `contracts/` after `forge build` and `FOUNDRY_PROFILE=sepolia forge build --skip
test --skip script`, with Foundry's `anvil`:

```sh
anvil --fork-url https://bsc-testnet-rpc.publicnode.com --port 8645 --hardfork osaka --silent &
cast rpc anvil_setBalance 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 0x429D069189E0000 --rpc-url http://127.0.0.1:8645   # 0.3 tBNB, on the fork only
BSC_TESTNET_RPC_URL=http://127.0.0.1:8645 node script/deploy-sepolia.mjs --network bsc-testnet
```

Check: `Plan: 8 transactions from nonce 0`; `next base fee 0 wei, priority fee 100,000,000 wei,
max fee 100,000,000 wei`; each step's gas as in the table; `8 transactions: 12,298,574 gas`; `The
dry run passed. Nothing was signed or sent.` Stop anvil afterwards. publicnode keeps the state of
about the last 10,000 blocks (75 minutes), which the fork reads lazily: a fork older than that
starts failing its reads. Against the chain itself (no `BSC_TESTNET_RPC_URL`) the same dry run stops
in its first request while the deployer holds nothing: `insufficient funds for gas * price + value:
have 0 want 1677721600000000`, the 16,777,216 cap at 0.1 gwei.

## 1. The tBNB has arrived (laptop, reads only)

If it came to the owner's wallet, send about 0.29 tBNB from there to the deployer in MetaMask:
receiving moves no nonce. Then, in Git Bash:

```sh
BSC=https://bsc-testnet-rpc.publicnode.com; BSCO=https://bsc-testnet.bnbchain.org; V3=https://test-evm-rpc-v3.portaldot.dev
cast chain-id --rpc-url $BSC                                                     # 97
cast nonce 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --rpc-url $BSCO            # 0
cast balance 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --ether --rpc-url $BSCO   # about 0.29
cast gas-price --rpc-url $BSCO                                                   # 100000000
curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"grandpa_roundState","params":[]}' https://test-node-v3.portaldot.dev   # setId: V3's set now
curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_config","params":[]}' $BSCO | head -c 300; echo   # "next": null, no fork scheduled
```

- **The nonce is not 0: stop.** The build links the libraries at the addresses nonces 0 to 3
  create, and the rollups' addresses repeat only from nonce 0 in this order.
- **A fork is scheduled** (`eth_config`'s `next` not null): read what it changes before going on.
- **When.** V3 changes its set about every 6 hours while it makes blocks: since set 75 (18:54 UTC
  on Oct 31, 11:54 PM PKT) at about 00:54, 06:54, 12:54 and 18:54 UTC (5:54 AM, 11:54 AM, 5:54 PM
  and 11:54 PM PKT). Keep steps 8 to 10 out of the half hour before one.
- **The checkpoint's age.** The relayer refuses a client more than `--scan-limit` (100,800) V3 blocks
  behind. Set 75's head is #269,340: from about V3 #370,000 (around Nov 8 at V3's 6 s blocks) step 8
  needs `--scan-limit <blocks behind + 5000>`, or a fresh capture (`npm run capture`) named in
  `PLANS` in `contracts/script/deploy-sepolia.mjs` before step 2.

## 2. The light client, nonces 0 to 7 (laptop, `contracts/`)

```sh
git pull --ff-only
FOUNDRY_PROFILE=sepolia forge build --skip test --skip script
node script/deploy-sepolia.mjs --network bsc-testnet
```

Check, as in step 0: 8 transactions from nonce 0, fees 0 / 100,000,000 / 100,000,000 wei, each
step's gas, `at most 0.00125… ETH at the max fee` (the tools write tBNB as ETH), and `The dry run
passed`. Then:

```sh
node script/deploy-sepolia.mjs --network bsc-testnet --send --account bz-deployer --password-file <deployer password file>
```

Check: `Every step is mined and checked; the record is …deployments/bsc-testnet.json`.

- Exit code 3 (a transaction still pending): run the same line with `--resume`.
- publicnode refuses the 0.1 gwei tip (untested before the first send): the run prints `(cast
  publish: …; waiting for 0x… anyway)` and would wait 20 minutes for a transaction that went
  nowhere. Press Ctrl-C at that line (its hash is in the record already), `export
  BSC_TESTNET_RPC_URL=https://bsc-testnet.bnbchain.org`, and run the same line with `--resume`: it
  finds that transaction neither mined nor pending, marks it dropped and signs it again at the same
  nonce, sent through the official endpoint. Keep the variable for the sends of steps 4 and 12, put
  `--rpc-url $BSCO` in place of `$BSC` in steps 3 and 5, and `unset BSC_TESTNET_RPC_URL` before a
  `status`, which reads the minter's logs: that endpoint serves none.

Read it back:

```sh
LC=0x389781D4856F0A9f3266ca6E76bE6C7B7cFe0Ab6
cast call $LC "currentSetId()(uint64)" --rpc-url $BSC                     # 75
cast call $LC "latestFinalized()(bytes32,uint32)" --rpc-url $BSC          # 0xeac4383e…1d53743, 269340
cast call $LC "stateRootOf(bytes32)(bytes32,uint32)" 0xeac4383e4872d0af561d7e8a16dab225c73b13df1bb1419d14fc9416c1d53743 --rpc-url $BSC   # 0x896c525e…6950b8cc, 269340
cast call $LC "threshold()(uint256)" --rpc-url $BSC                       # 2
cast nonce 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --rpc-url $BSCO      # 8
```

If the addresses in `deployments/bsc-testnet.json` are not `0x51da…b77E`, `0x482a…dFD2`,
`0xf2Cd…e6D2`, `0x5DA0…F2a3`, `0x3897…0Ab6` and `0x40F4…86f0`, the nonce moved: follow the record
everywhere below, not this page.

## 3. The relayer key's funding, nonce 8 (laptop)

```sh
cast send 0xE94a82E2c7f38f777E8845A9d8c36B6be6a30257 --value 0.1ether --nonce 8 --gas-limit 21000 --gas-price 0.1gwei --priority-gas-price 0.1gwei --chain 97 --rpc-url $BSC --account bz-deployer --password-file <deployer password file>
cast balance 0xE94a82E2c7f38f777E8845A9d8c36B6be6a30257 --ether --rpc-url $BSCO   # 0.1
cast nonce 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --rpc-url $BSCO              # 9
```

If publicnode refuses the transfer as underpriced, nothing went out: the same line with `--rpc-url
$BSCO`, still at nonce 8.

Write `deployments/bsc-testnet-funding.json` by hand, in `base-sepolia-funding.json`'s shape:
`network` `"bsc-testnet"`, `deployer`, and `steps` with `faucet` (the incoming tBNB: `kind`
`"faucet"`, `chain` `"bsc-testnet"`, `chainId` 97, `from` the wallet or faucet it came from, `to`
the deployer, `value`, `txHash`, `block`) and `relayer` (`kind` `"relayer"`, `chain`
`"bsc-testnet"`, `chainId` 97, `from` the deployer, `to` the relayer key, `call` `"a transfer to
bz-relayer 0xE94a…0257"`, `value` `"100000000000000000"`, `data` `"0x"`, `nonce` 8, `gasLimit` 21000,
`maxFee` and `priorityFee` `"100000000"`, `txHash`, `signedAt`, `block`, `status` 1, `gasUsed`
21000, `ok` true, `effectiveGasPrice` from the receipt). The auto-mint key's funding (step 5) stays
out of it, as on the rollups: `relayer/src/networks.test.ts` expects nonce 8 alone from the deployer
there, and checks the pair's nonces against it.

## 4. BridgeMinter and wtPOT, nonces 9 and 10 (laptop, `relayer/`)

```sh
npm run mint -- deploy --network bsc-testnet
npm run mint -- deploy --network bsc-testnet --send --account bz-deployer --password-file <deployer password file>
npm run mint -- status --network bsc-testnet
cast call 0xdc31a3BC1354545EeB985AaD7b2Aa662E9272348 "lightClient()(address)" --rpc-url $BSC   # 0x389781D4…0Ab6
cast call 0xE1130718C56de008B47c392c85895A1A605bA95e "minter()(address)" --rpc-url $BSC        # 0xdc31…2348
```

Check, in the dry run: `the deployer's next nonce is 9`, BridgeMinter `1,399,559 gas` and
WrappedTPOT `471,093 gas`, each `the code is the build's`. After `--send`: the two contracts at
`0xdc31…2348` and `0xE113…A95e`, `deployments/bsc-testnet-bridge.json` written, and status `not
bound`, 0 burns, supply 0. The dry run prints each contract's `forge verify-contract` line (`--chain
bsc-testnet`). BscScan verification through Etherscan's V2 API may need a paid plan for this chain;
if the key is refused, BscScan's own form or `--verifier sourcify` does it. It is optional.

If the `--send` run prints `(cast publish: …; waiting for 0x… anyway)` with publicnode's refusal,
press Ctrl-C, `export BSC_TESTNET_RPC_URL=https://bsc-testnet.bnbchain.org` (unless step 2 did) and
run the same line again: it finds that transaction neither mined nor pending, marks it dropped and
sends it again at the same nonce. `unset BSC_TESTNET_RPC_URL` before `mint -- status`.

## 5. The auto-mint key's funding, nonce 11 (laptop)

```sh
cast send 0x57cc2ba3B883339a9F32726E6d0d3A9EE861A113 --value 0.05ether --nonce 11 --gas-limit 21000 --gas-price 0.1gwei --priority-gas-price 0.1gwei --chain 97 --rpc-url $BSC --account bz-deployer --password-file <deployer password file>
cast balance 0x57cc2ba3B883339a9F32726E6d0d3A9EE861A113 --ether --rpc-url $BSCO   # 0.05
cast nonce 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --rpc-url $BSCO              # 12
```

If publicnode refuses it, the same line with `--rpc-url $BSCO`, still at nonce 11.

## 6. Commit B: the records, the app's addresses and the server's units (laptop)

On `main`, one commit:

- `deployments/bsc-testnet.json`, `deployments/bsc-testnet-bridge.json` and
  `deployments/bsc-testnet-funding.json`.
- `site/src/app/dests.ts`, the `bsc-testnet` entry: `lightClient`, `provenBalance`, `minter`,
  `token` from the records (lower case) and `minterFrom` BridgeMinter's block. It stays in `HIDDEN`.
  `cd site && npm run check` then runs the record checks of `test/app-dests.test.ts` against them,
  and `cd relayer && npm test` the pair's (`networks.test.ts`, no longer skipped).
- The counts the pair's test changes: in the README, `# ℹ pass 403` and `# ℹ skipped 0` under `npm
  test` in Verify it yourself, the sentence on the relayer's skipped test in the paragraph after
  that block (it goes), and in Status "403 relayer tests" without "(one skipped until the BNB Smart
  Chain testnet's records exist)". `docs/BUSINESS.md`'s "403 relayer tests … pass" stays as it is,
  every one of them passing then.
- The server's files, below, and in `docs/DEPLOY.md` the funds table's BNB Smart Chain testnet row
  (tBNB from a faucet, no bridge from Sepolia; 14,211,226 gas, 0.00142 tBNB), the relayer's and
  auto-mint's rows, the lines of §2 and §4 with `bsc-testnet`, and §3.8's last sentence ("was added
  this way on Nov <d>").

The server's files (`ops/server/`):

- `bz-rollups.sh`: `for network in base-sepolia arbitrum-sepolia bsc-testnet; do`, and in its header
  "…then one for the BNB Smart Chain testnet (no rollup: it shares the timer, the key bz-relayer and
  the line format)". The `rollup run <network>: exit <code>` line stays as it is: `bz-health.sh`
  reads it.
- `systemd/bz-rollups.service`: its Description and comment name the third run, and
  `TimeoutStartSec=65min` (three runs of at most 20 minutes, and margins; it was 45 for two).
- `systemd/bz-rollups.timer`: its Description.
- `systemd/bz-automint.service`: its Description, and

  ```
  ExecStart=/usr/local/bin/node --max-old-space-size=256 --import tsx src/automint-main.ts --network sepolia,base-sepolia,arbitrum-sepolia,bsc-testnet --send --watch 15 --grace 90 --min-amount 0.001 --max-spend sepolia=0.02,base-sepolia=0.002,arbitrum-sepolia=0.002,bsc-testnet=0.005 --keep sepolia=0.01,base-sepolia=0.0002,arbitrum-sepolia=0.0002,bsc-testnet=0.001 --account bz-automint --password-file /home/ubuntu/.foundry/bz-automint.pw
  ```

- `systemd/bz-release.service`: its Description, and (no `bsc-testnet=` pair: the watcher waits for
  its finality, about a second)

  ```
  ExecStart=/usr/local/bin/node --max-old-space-size=256 --import tsx src/release.ts release --watch 15 --network sepolia,base-sepolia,arbitrum-sepolia,bsc-testnet --confirmations sepolia=3,base-sepolia=180,arbitrum-sepolia=144 --send --member-keys 1:/home/ubuntu/.bridge-zero/committee/member-1.json,2:/home/ubuntu/.bridge-zero/committee/member-2.json --password-file /home/ubuntu/.foundry/bz-committee-server.pw
  ```

- `bz-health.sh`: `for network in base-sepolia arbitrum-sepolia bsc-testnet; do` in the rollup-run
  check.
- `README.md`: the Files rows of the watcher, auto-mint and the rollup runs; the dry runs with
  `node --import tsx src/relay-main.ts --network bsc-testnet --chain v3 --head-every 1800 --from
  <bz-relayer's address>` and the watcher's and auto-mint's lines of step 7; "three chains" where it
  counts them.

No new process, key or swap: memory grows only by a fourth network's state in auto-mint and the
watcher. Never name `bsc-testnet` in a unit before its records are on the server: the relayer
stops with `deployments/bsc-testnet.json does not exist`, and the units with it.

Push `main`.

## 7. The server: the standing code update, with the dry runs of four chains

On the server, the code update of [server/README.md](server/README.md#standing-procedures), its
first two lines, then the rest once it printed `all four stopped`:

```sh
sudo systemctl stop bz-rollups.timer; while systemctl is-active --quiet bz-rollups.service; do sleep 10; done
~/bz-ops/bz-stop-at-idle.sh bz-release && ~/bz-ops/bz-stop-at-idle.sh bz-automint && ~/bz-ops/bz-stop-at-idle.sh bz-relay-v3 && ~/bz-ops/bz-stop-at-idle.sh bz-relay-mainnet && echo "all four stopped"
cd ~/bridge-zero && live=~/bz-ops/v3-testnet.live.$(date +%Y%m%d-%H%M).json && cp -p deployments/v3-testnet.json "$live"
git pull --ff-only || { git checkout -- deployments/v3-testnet.json && git pull --ff-only; }
cp "$live" deployments/v3-testnet.json
git diff --quiet ORIG_HEAD HEAD -- relayer/package-lock.json || (cd relayer && npm ci)
git diff --quiet ORIG_HEAD HEAD -- ops/server || { cp ops/server/bz-rollups.sh ops/server/bz-health.sh ops/server/bz-stop-at-idle.sh ops/server/bz-state-check.mjs ~/bz-ops/ && chmod 755 ~/bz-ops/*.sh && sudo install -m 0644 ops/server/systemd/bz-*.service ops/server/systemd/bz-*.timer /etc/systemd/system/ && sudo systemctl daemon-reload; }
```

Then the dry runs, from `~/bridge-zero/relayer`:

```sh
node --import tsx src/relay-main.ts --network bsc-testnet --chain v3 --head-every 1800 --from 0xE94a82E2c7f38f777E8845A9d8c36B6be6a30257
node --import tsx src/release.ts release --watch 15 --rounds 1 --network sepolia,base-sepolia,arbitrum-sepolia,bsc-testnet --confirmations sepolia=3,base-sepolia=180,arbitrum-sepolia=144
node --import tsx src/automint-main.ts --network sepolia,base-sepolia,arbitrum-sepolia,bsc-testnet --grace 90 --min-amount 0.001 --max-spend sepolia=0.02,base-sepolia=0.002,arbitrum-sepolia=0.002,bsc-testnet=0.005 --keep sepolia=0.01,base-sepolia=0.0002,arbitrum-sepolia=0.0002,bsc-testnet=0.001 --sender 0x57cc2ba3B883339a9F32726E6d0d3A9EE861A113
systemd-analyze verify /etc/systemd/system/bz-*.service
```

Check:

- The relayer plans every set change from 75 to V3's set now, each `importHeader` about 1,849,220
  gas, then the head, and `The dry run passed` (or `is up to date` when V3 is still at set 75 and
  fewer than 1,800 blocks past #269,340).
- The watcher's first line names the four chains; Sepolia, Base Sepolia and Arbitrum Sepolia read
  as before; `BNB Smart Chain testnet: latest #…, finalized #…` about 2 below its latest, and 0
  burns.
- Auto-mint prints a line for `BNB Smart Chain testnet`: `--keep 0.001 ETH`, `--max-spend 0.005 ETH
  a day`, the scan from V3 #269,300, the vault's earlier locks `not for this minter`, `nothing to
  mint`.
- `systemd-analyze` prints nothing about a `bz-` file.

On the fork on Nov 1 these three dry runs passed against the fork's deployment, with the three
other chains read live.

Then start the four services, the timer still stopped: no lock names chain 97 and its minter has
no burn yet, so auto-mint and the watcher have nothing to do there, while Sepolia's, Base Sepolia's
and Arbitrum Sepolia's locks are minted and their burns released again from here on, through step
8 however long it takes.

```sh
sudo systemctl start bz-release bz-automint bz-relay-v3 bz-relay-mainnet
journalctl -u bz-release -u bz-automint -o cat -n 80      # a round on each of the four chains; auto-mint's "Next rounds" names the BNB Smart Chain testnet
```

## 8. The first run of the BNB Smart Chain testnet's relayer, by hand (server)

With the timer still stopped (the four services run): a first run can scan more than the timer's
20 minutes allow when the client is days behind, and a timer's run of chain 97 meanwhile would find
this one's lock and end with exit code 1.

```sh
cd ~/bridge-zero/relayer
node --import tsx src/relay-main.ts --network bsc-testnet --chain v3 --send --head-every 1800 --account bz-relayer --password-file /home/ubuntu/.foundry/bz-relayer.pw
# with --scan-limit <blocks behind + 5000> added when the client is more than 100,800 V3 blocks behind (from about Nov 8)
cast call 0x389781D4856F0A9f3266ca6E76bE6C7B7cFe0Ab6 "currentSetId()(uint64)" --rpc-url https://bsc-testnet-rpc.publicnode.com   # V3's set of step 1, or later
ls ~/.bridge-zero/relay-bsc-testnet-0xe94a82e2c7f38f777e8845a9d8c36b6be6a30257.*
```

Check: exit code 0, and the relay record `relay-bsc-testnet-0xe94a….jsonl` in `~/.bridge-zero`.

## 9. Start the timer (server)

```sh
sudo systemctl start bz-rollups.timer
systemctl list-timers bz-rollups.timer                    # the next 20-minute slot
journalctl -u bz-rollups -o cat --since=-25min            # after it: "rollup run <network>: exit 0" for each of the three
~/bz-ops/bz-health.sh                                     # "last rollup run for bsc-testnet: exit 0", "health: 0 FAIL"
```

## 10. The first lock (laptop, `relayer/`, right after a relayer run)

Pull commit B first: the lock's dry run takes the destination from `deployments/*-bridge.json`.
The vault's `nextNonce` was 8 on Nov 1, so this is likely lock 8.

```sh
npm run v3-vault -- lock --dst-chain 97 --dst-minter 0xdc31a3BC1354545EeB985AaD7b2Aa662E9272348 --recipient 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --amount 0.001
npm run v3-vault -- lock --dst-chain 97 --dst-minter 0xdc31a3BC1354545EeB985AaD7b2Aa662E9272348 --recipient 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --amount 0.001 --send --account bz-deployer --password-file <deployer password file>
```

Check: the `Locked` event with nonce n and the commitment stored. The lock goes into the laptop's
`deployments/v3-testnet.json`; the server's copy is the live one, so the laptop's is not committed:
lock n's entry is carried into the server's copy at commit C. (The other way, with no record split:
the first lock from the owner's wallet in the app, run locally with `VITE_PREVIEW_DESTS=bsc-testnet
npm run dev` in `site/`.)

## 11. Auto-mint mints it (server, laptop)

Expect V3's finality and the 90 s grace, about 2 to 3 minutes (the rollups' first ones took 133 and
139 s).

```sh
journalctl -u bz-automint -o cat --since=-15min | grep -iE "BNB Smart Chain testnet|lock <n>"          # server
M=0xdc31a3BC1354545EeB985AaD7b2Aa662E9272348
cast call $M "used(uint256)(bool)" <n> --rpc-url $BSC                                                   # true
cast call $M "vaultTrieId()(bytes32)" --rpc-url $BSC                                                    # 0xbe307c2d11dbc9391cda93d17e9772542d1300c9af14e7431918fb49e2f47c3a
cast call 0xE1130718C56de008B47c392c85895A1A605bA95e "balanceOf(address)(uint256)" 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --rpc-url $BSC   # 100000000000
cast call 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd "outstanding()(uint256)" --rpc-url $V3             # up 0.001 tPOT (100000000000) since step 10's dry run
npm run mint -- status --network bsc-testnet
```

The first mint goes by the head path and binds the vault: about 2.66M gas (the fork's 2,661,628). A
log `behind V3's set` means the client waits for a set change: the next timer slot (20 minutes at
most) imports it, or step 8's command does.

## 12. The burn, the deployer's nonce 12 (laptop)

```sh
npm run release -- burn --network bsc-testnet --amount 0.001 --v3-recipient 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071
npm run release -- burn --network bsc-testnet --amount 0.001 --v3-recipient 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --send --account bz-deployer --password-file <deployer password file>
cast call 0xdc31a3BC1354545EeB985AaD7b2Aa662E9272348 "burnIdOf(uint256)(bytes32)" 0 --rpc-url $BSC   # 0xf38d1b6cd1e6d5a6fbe5b1f8238646147194891702fd9e164d9b6ad450454773
```

Check, in the dry run: `burn 0 will carry burn id 0xf38d1b6c…50454773`, `52,822 gas … with 68,665,
eth_estimateGas's 62,422 + 10%`, the priority fee 100,000,000 wei. After `--send`: `BurnRequested`
(burn 0), the `Transfer` to the zero address, and the wtPOT supply on chain 97 back to 0. If the
`--send` run prints publicnode's refusal and waits, press Ctrl-C, export the official endpoint as
in step 2 and run the same `--send` line again: it marks the burn it signed dropped (neither mined
nor pending) and burns again at the same nonce, still burn 0.

## 13. The watcher releases it (server)

Within a minute or two: finality in about a second, a 15 s round, then members 1 and 2.

```sh
journalctl -u bz-release -o cat --since=-15min | grep -i "BNB Smart Chain testnet"     # qualifies by finality, opened, run
cast call 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd "released(bytes32)(bool)" 0xf38d1b6cd1e6d5a6fbe5b1f8238646147194891702fd9e164d9b6ad450454773 --rpc-url $V3   # true
cast call 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd "outstanding()(uint256)" --rpc-url $V3   # back to its value before step 10
npm run release -- status --network bsc-testnet
```

The server's `deployments/v3-testnet.json` has a release round for chain 97 with `"by":
"finality"`. That is the first lock minted and burned back.

## 14. Commit C: the app shows it, the README tells it (laptop)

- `site/src/app/dests.ts`: `bsc-testnet` out of `HIDDEN`, its `firsts` (lock n, burn 0), `mintGas`
  and `burnGas` from the first mint's and burn's receipts; `LATER_CHAINS` in `facts.ts` without it
  (and `test/app-dests.test.ts`'s line that lists them), the app's `LATER_NOTE` and the status
  page's chain list (`sections/Hero.tsx`). Optionally first a local check with the owner's wallet:
  `VITE_PREVIEW_DESTS=bsc-testnet npm run dev`.
- The server's `deployments/v3-testnet.json` (with lock n's entry from the laptop's copy), and the
  BNB Smart Chain testnet's relay and auto-mint histories copied into `deployments/`, as for the
  rollups.
- README: the evidence rows (a new section, "More chains: the BNB Smart Chain testnet"), the
  Roadmap's "More EVM chains" (done), the Status and Known limits (publicnode's logs and receipts
  of recent blocks only, and a burn the watcher never saw while its log was served waiting for an
  RPC that keeps them; 1.85M and 1.70M gas at 0.1 gwei; the watcher's one speed there), the plan and
  the Development log; `site/README.md`.

## If something goes wrong

- **A send is refused as underpriced** (publicnode, at 0.1 gwei; untested before the first send):
  `BSC_TESTNET_RPC_URL=https://bsc-testnet.bnbchain.org` for the laptop's sends, after Ctrl-C on a
  run that waits on the refused transaction (steps 2, 4 and 12 say how each goes on), and `--rpc-url
  $BSCO` for `cast send`. On the server set it for the relayer's script and auto-mint only, never
  for `bz-release`: the official endpoints serve no logs, and the watcher reads the minter's logs
  through that variable.
- **A nonce moved** (anything else sent from the deployer on chain 97 first): the pair's addresses
  are not the rollups'. Follow the records: `PAIR_NONCES` in `relayer/src/mint.ts` and the app's
  entry take the record's.
- **Logs gone.** publicnode forgets chain 97's old logs and receipts and answers them with none and
  no error: on Nov 1 it served those of the blocks from #140,000,000 on, 10.5 to 12.7 hours back. A
  burn the watcher saw is released however late it qualifies: the release reads its transaction's
  receipt, from the official endpoints once publicnode has none, as it does for a burn `release
  burn` sent (its record holds the transaction). Only a burn the watcher never saw while its log was
  served, made while the watcher was down longer than that, waits, as `older than the RPC keeps`:
  the watcher searches 100,000 blocks back at most on publicnode. Stop `bz-release` at an idle
  moment, run its unit's line once by hand with `--rounds 1` and `BSC_TESTNET_RPC_URL` set to an RPC
  that keeps the minter's logs (publicnode's own URL too, while it has them; the search then goes
  back to the last released burn), then start `bz-release` again. `mint status` and `release status`
  read `burnCount` and `burnIdOf` instead when the logs fall short.
- **Finality stops.** If the validators' votes stall, the `finalized` tag stops and the burns there
  wait: the safe failure.
- **A tBNB price rise.** Every number above is at 0.1 gwei and scales with it.
- **The logo.** BNB Chain's brand guidelines ask projects to seek approval before using its logo:
  the app shows a text mark, "BNB", until that approval is given.
