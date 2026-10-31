# The server

Since 17:45 UTC on Oct 31, 2026, the operator's processes run on a small cloud server with 1 GB of
RAM and a 4 GB swap file, as systemd services that restart after a crash and start at boot: the
relayer of each light client on Sepolia, the release watcher, auto-mint, the rollup relay runs on a
timer, and a health check. Until then a laptop ran them from scheduled tasks at logon; while it
slept no relay run, mint or release happened (on Oct 24 from 00:45 to 06:52 UTC, and from 17:13 UTC
on Oct 28 to 17:51 UTC on Oct 30). These are the files that run on the server, without its address
or account details. [docs/DEPLOY.md](../../docs/DEPLOY.md) has the commands they run and the keys
they use.

The server's first runs: its rollup relay run imported V3 block #266,274 into Base Sepolia's
`GrandpaLightClient` #2 at 17:50:50 UTC
([`0x871a603d…`](https://sepolia.basescan.org/tx/0x871a603d7e6dbdfd1344d4e221771f9b9ea5690b5c81dfd9e63e7de073ab7016))
and #266,278 into Arbitrum Sepolia's at 17:51:13 UTC
([`0xa40c202b…`](https://sepolia.arbiscan.io/tx/0xa40c202bf47994eda6eaaea46cdea5596b57085fe988956f5402a848c07d11b3)),
both from the relayer's key `0xE94a…0257`.

## Files

| File | Installed as | What it does |
|---|---|---|
| `systemd/bz-relay-v3.service` | `/etc/systemd/system/` | the V3 relayer: `--chain v3 --send --watch 600`, key `bz-relayer`, into `GrandpaLightClient` #2 on Sepolia |
| `systemd/bz-relay-mainnet.service` | `/etc/systemd/system/` | the old mainnet's relayer: `--chain mainnet --send --watch 600 --keep 0.02`, key `bz-relayer-mainnet`, into #1 on Sepolia |
| `systemd/bz-release.service` | `/etc/systemd/system/` | the release watcher for Sepolia, Base Sepolia and Arbitrum Sepolia, with members 1 and 2 |
| `systemd/bz-automint.service` | `/etc/systemd/system/` | auto-mint for the three chains, key `bz-automint` |
| `systemd/bz-rollups.service`, `systemd/bz-rollups.timer`, `bz-rollups.sh` | the units in `/etc/systemd/system/`, the script in `/home/ubuntu/bz-ops/` | one relayer run for Base Sepolia, then one for Arbitrum Sepolia (key `bz-relayer`), each ended at 20 minutes, at 02:00, 08:00, 14:00 and 20:00 UTC, six minutes after each V3 set change, and again 20 and 40 minutes later; a slot missed while the server was off runs when it is back |
| `systemd/bz-health.service`, `systemd/bz-health.timer`, `bz-health.sh` | the units in `/etc/systemd/system/`, the script in `/home/ubuntu/bz-ops/` | a read-only check every 15 minutes: the units running, no halt file, each unit's last "Next" line on time, the rollup runs, the clock, memory and disk; it fails while a check FAILs, and can ping a heartbeat URL |
| `systemd/journald-bridge-zero.conf` | `/etc/systemd/journald.conf.d/bridge-zero.conf` | the journal on disk, at most 2 GB: about 12 days of these logs (about 213,000 lines a day) |
| `systemd/rsyslog-30-bridge-zero.conf` | `/etc/rsyslog.d/30-bridge-zero.conf` | optional: no second copy of the `bz-*` lines in `/var/log/syslog` |
| `bz-stop-at-idle.sh` | `/home/ubuntu/bz-ops/` | stops one service once its journal shows it idle, with nothing in flight |
| `bz-state-check.mjs` | `/home/ubuntu/bz-ops/` | read-only: whether the state is quiet (no open transaction, mint, approval or halt), and the sha256 of every state file and record; Node 24, no packages |
| `reencrypt-committee.mjs` | not installed | run once where the committee's keys are: members 1 and 2 under one fresh password that only the server holds |

The units start `node --import tsx src/...` in `relayer/`: the code `npm run relay`, `release` and
`automint` run, without npm and the tsx command line in memory (about 115 MB a process on the
laptop). Each one caps its heap (`--max-old-space-size` 256 for the watcher and auto-mint, 160 for a
relayer) and sets `ESBUILD_WORKER_THREADS=0` (a cold tsx start after a reboot leaves no esbuild
process running), `LimitCORE=0` (an abort writes no core file into the checkout; the watcher's would
hold the opened member keys), `UMask=0077`, `NoNewPrivileges` and `ProtectSystem=full`.

| Unit | Restarted a minute later after | Left stopped for the operator after |
|---|---|---|
| `bz-relay-v3`, `bz-relay-mainnet` | a signal: an out-of-memory abort, a kill | exit code 1: the relayer's own stop (a sent transaction that failed its checks, a signing or record problem), a refusal at start, an uncaught error |
| `bz-release` | exit code 1 (the committee's lock held, a refusal), a crash | exit code 4: the halt file, a key that does not open, a release that only a chain left out of `--network` finishes |
| `bz-automint` | any failure | |

Each restart settles what its record holds as sent before it does anything else: every send is
recorded before it is broadcast. A unit started 5 times in an hour (the watcher 12, room for a lock
left by a process id that a reboot reused to go stale, 10 minutes) stays stopped until
`sudo systemctl reset-failed <unit>`.

## What the server needs

- Linux with systemd (the units were checked with systemd 245) and a user `ubuntu`, home
  `/home/ubuntu`, in the `systemd-journal` group: `bz-health.sh` and `journalctl` read every unit's
  journal. Another user or path means editing `User=`, `Group=` and the paths in the units and the
  scripts.
- Node.js 24 at `/usr/local/bin/node`, and Foundry's `cast` in `/home/ubuntu/.foundry/bin`: every
  process but the watcher signs with cast, and the units put that folder on `PATH`. No
  `~/.foundry/foundry.toml`.
- The checkout at `/home/ubuntu/bridge-zero`, owned by `ubuntu`, with `npm ci` run in `relayer/`.
- The clock synchronized: auto-mint's grace and daily spend, and the relayers' replacements, compare
  times. `bz-health.sh` warns when it is not.
- Outbound HTTPS and WSS (port 443) to the RPCs and the Portaldot nodes. Nothing listens: a firewall
  can admit SSH alone, with keys only.

**Keys**, owned by `ubuntu`, files mode 600 and folders mode 700:

| Path | What |
|---|---|
| `~/.foundry/keystores/bz-relayer`, `bz-relayer-mainnet`, `bz-automint` | the Foundry keystores |
| `~/.foundry/bz-relayer.pw`, `bz-relayer-mainnet.pw`, `bz-automint.pw` | their password files |
| `~/.bridge-zero/committee/member-1.json`, `member-2.json` | members 1 and 2, polkadot-js keystores re-encrypted for the server |
| `~/.foundry/bz-committee-server.pw` | the one password file that opens both |

- `cast` trims trailing whitespace from a password file; the watcher strips exactly one trailing
  line end. Neither takes a byte-order mark.
- Never on the server: the deployer's keystore and password file (the light clients' admin),
  member 3's key, which stays elsewhere to cancel or step in, and the repository's `.env`.
- Members 1 and 2 meet the committee's 2 of 3: whoever controls the server and its password file
  can release up to the vault's outstanding tPOT ([Known limits](../../README.md#status)).
- A key signs on one machine only. The locks that keep two processes of one key apart
  (`~/.bridge-zero/*.lock`) work on one machine: a key used on two can sign twice at one nonce, and
  the run that loses stops (a relayer with exit code 1, the watcher with a halt).

## Install

On the server, as `ubuntu`; nothing here signs or enables anything:

```sh
mkdir -m 700 ~/bz-ops
cd ~/bridge-zero/ops/server
cp bz-rollups.sh bz-health.sh bz-stop-at-idle.sh bz-state-check.mjs ~/bz-ops/ && chmod 755 ~/bz-ops/*.sh
sudo install -m 0644 systemd/bz-*.service systemd/bz-*.timer /etc/systemd/system/
sudo install -D -m 0644 systemd/journald-bridge-zero.conf /etc/systemd/journald.conf.d/bridge-zero.conf
sudo install -m 0644 systemd/rsyslog-30-bridge-zero.conf /etc/rsyslog.d/30-bridge-zero.conf   # optional, with rsyslog
sudo systemctl daemon-reload && sudo systemctl restart systemd-journald rsyslog
systemd-analyze verify /etc/systemd/system/bz-*.service /etc/systemd/system/bz-*.timer
systemd-analyze calendar --iterations=6 '*-*-* 02,08,14,20:00,20,40:00 UTC'
```

`verify` prints nothing about a `bz-*` file, and the calendar lists the next six rollup slots. Then
put the keys in place (above), and check them and the units' command lines with dry runs, from
`~/bridge-zero/relayer`:

```sh
for a in bz-relayer bz-relayer-mainnet bz-automint; do cast wallet address --account $a --password-file ~/.foundry/$a.pw; done
node --import tsx src/relay-main.ts --chain v3 --from <bz-relayer's address>
node --import tsx src/relay-main.ts --chain mainnet --keep 0.02 --from <bz-relayer-mainnet's address>
node --import tsx src/relay-main.ts --network base-sepolia --chain v3 --from <bz-relayer's address>
node --import tsx src/relay-main.ts --network arbitrum-sepolia --chain v3 --from <bz-relayer's address>
node --import tsx src/release.ts release --watch 15 --rounds 1 --network sepolia,base-sepolia,arbitrum-sepolia --confirmations sepolia=3,base-sepolia=180,arbitrum-sepolia=144
node --import tsx src/automint-main.ts --network sepolia,base-sepolia,arbitrum-sepolia --sender <bz-automint's address>
```

Healthy is exit code 0, or 3 while something is not final yet: a relayer prints `... is up to
date` or `The dry run passed`, the watcher a round's summary for each chain, auto-mint `The dry run
is over`. A dry run takes no member keys: `reencrypt-committee.mjs` reads its new files back as the
watcher does, and the watcher opens both keys before its first request and stops with exit code 4
if one does not open.

## Moving the processes to the server

Only one machine runs them with `--send` at a time, so the old one stops first and its state moves
with them. While they move, no relay run, mint or release happens.

1. **When.** Both machines reach the V3 node, and the move is clear of V3's set changes (01:54,
   07:54, 13:54 and 19:54 UTC) and of the rollup slots: it starts between 03:30 and 06:00 UTC, or
   in the same window 6, 12 or 18 hours later.
2. **Same code.** Both checkouts at the same commit; `git status --porcelain -- deployments` prints
   nothing, or only ` M deployments/v3-testnet.json`, the watcher's live record.
3. **Stop the old machine:** first whatever starts the processes there (a scheduled task, a
   service), then each process at an idle moment of its log, the watcher first. Nothing of them is
   left running, and `node bz-state-check.mjs` there ends with `QUIET`. Rename the keys that go to
   the server where they were, so that nothing signs with them there by mistake.
4. **Copy the state** from the old `~/.bridge-zero/` to the server's, byte for byte: each sender's
   relay record and history (`relay-<network>-<address>.json` and `.jsonl`), auto-mint's state and
   history (`automint-<network>-<address>.json` and `.jsonl`), the watcher's burn caches
   (`release-watch-<multisig>*.burns.json`) and its halt file if there is one; and
   `deployments/v3-testnet.json` when it differs from the server's. Never a lock (`*.lock`,
   `*.lock.*`), a `*.tmp` or `*.unreadable-*` file, or the deployer's relay record. On the server,
   `chmod 600` them; `node ~/bz-ops/bz-state-check.mjs` ends with `QUIET` and prints the same
   `sha256` lines as the old machine, the deployer's record aside.
5. **Start, one at a time**, reading each one's first lines (`journalctl -u <unit> -o cat`):

   ```sh
   sudo systemctl start bz-release                    # the lock is this watcher's, both keys open, a round on each chain
   sudo systemctl start bz-automint                   # a state line for each chain, then "Next rounds"
   sudo systemctl start bz-relay-v3 bz-relay-mainnet  # the sender and its nonce, "is up to date" or a plan sent, "Next run in 600 s"
   sudo systemctl enable --now bz-rollups.timer
   sudo systemctl start bz-rollups.service            # optional: one run of each rollup now, "rollup run <network>: exit 0"
   sudo systemctl enable bz-release bz-automint bz-relay-v3 bz-relay-mainnet
   sudo systemctl enable --now bz-health.timer
   ~/bz-ops/bz-health.sh                              # "health: 0 FAIL"
   ```

6. **After the next V3 set change**, the V3 relayer imports it, and each rollup's client gets it
   within its three runs: `journalctl -u bz-relay-v3 -u bz-rollups --since=-10h -o cat`.

To move back, stop the server's units at idle moments (`~/bz-ops/bz-stop-at-idle.sh <unit>`),
disable them and both timers, and copy the state back the same way, never the server's locks or
keys, before anything starts on the other machine. While the server could start again by itself,
nothing starts elsewhere: its units start at boot with `--send`.

## Standing procedures

- **Health.** `ssh ubuntu@<server> bz-ops/bz-health.sh`, daily and before a demo; healthy is
  `health: 0 FAIL`. A relayer `failed` with exit code 1: read `journalctl -u <unit> -n 80 -o cat`,
  fix the cause, then `sudo systemctl reset-failed <unit>` and start it. The watcher `failed` with
  exit code 4: a halt (below), or a key file that did not open. `stuck?` or `backs off`: read the
  journal first; `sudo systemctl restart <unit>` is safe, as every send is recorded before it is
  broadcast. A heartbeat is optional: an uptime monitor's ping URL in `~/bz-ops/heartbeat.url`
  (mode 600) is fetched after each check without a FAIL, so the monitor tells when the pings stop.
- **An approval by hand**, as member 3 on another machine: stop the watcher at an idle moment
  (`~/bz-ops/bz-stop-at-idle.sh bz-release`), copy the server's `deployments/v3-testnet.json` over
  that machine's, run the approval (`npm run release -- release --burn-nonce <n> --network <chain>
  --approve --member 3 --send --key-file <member-3.json> --password-file <file>`), copy the record
  back, compare both copies' sha256, check `node ~/bz-ops/bz-state-check.mjs`, and start
  `bz-release` again. Both at once can make an approval fail on chain and halt the watcher.
- **A code update:**

  ```sh
  sudo systemctl stop bz-rollups.timer; while systemctl is-active --quiet bz-rollups.service; do sleep 10; done
  ~/bz-ops/bz-stop-at-idle.sh bz-release && ~/bz-ops/bz-stop-at-idle.sh bz-automint && ~/bz-ops/bz-stop-at-idle.sh bz-relay-v3 && ~/bz-ops/bz-stop-at-idle.sh bz-relay-mainnet
  cd ~/bridge-zero && live=~/bz-ops/v3-testnet.live.$(date +%Y%m%d-%H%M).json && cp -p deployments/v3-testnet.json "$live"
  git pull --ff-only || { git checkout -- deployments/v3-testnet.json && git pull --ff-only; }
  cp "$live" deployments/v3-testnet.json
  git diff --quiet ORIG_HEAD HEAD -- relayer/package-lock.json || (cd relayer && npm ci)
  ```

  Then the dry runs above, `sudo systemctl start bz-release bz-automint bz-relay-v3
  bz-relay-mainnet bz-rollups.timer`, and `~/bz-ops/bz-health.sh` about 15 minutes later. The
  server's `deployments/v3-testnet.json` is the live record: it is never reset without the copy.
- **A halt.** `cat ~/.bridge-zero/release-watch-<multisig>.halt` and
  `journalctl -u bz-release -n 200 -o cat` say why; the members decide. Where the halt names a burn
  whose approval or final check the record holds as failed, a member adds `"acknowledged": "<who,
  when, what they found>"` to that entry in the server's `deployments/v3-testnet.json`, then
  removes the halt file and starts `bz-release`
  ([docs/BRIDGE.md](../../docs/BRIDGE.md#fast-mode-and-the-auto-release-watcher)).
- **Rules.** No bridge command runs with `sudo`: `HOME` becomes `/root`, with another state
  directory, no keystores and no shared lock. The server's keys sign nowhere else. Records go from
  the server to other copies: its `deployments/v3-testnet.json` comes first when records are
  committed or the site is built from them.

## Limits

- One machine: while the server is off, no relay run, mint or release happens, as on the laptop.
  The health check, the optional heartbeat and the status page's live reads show it; a server that
  starts again resumes from its own state.
- Memory: an out-of-memory abort restarts the unit, which settles its record first; a heap cap set
  too low shows as restarts (`systemctl show -p NRestarts <unit>`) until the start limit stops it.
- A halt needs a member: nothing restarts the watcher after exit code 4.
