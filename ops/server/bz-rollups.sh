#!/usr/bin/env bash
# /home/ubuntu/bz-ops/bz-rollups.sh, run by bz-rollups.service (bz-rollups.timer), as a scheduled
# task ran them on the laptop until Oct 31: one relayer run for Base Sepolia, then one for Arbitrum
# Sepolia, from the key bz-relayer, each ended at 20 minutes if it still runs, and one line a run in
# the journal:
#   rollup run <network>: exit <code>
# A run's exit code: 0 up to date or relayed; 1 a check failed or nothing could be relayed (or a run
# started by hand holds that network's lock); 2 an RPC or the V3 node could not be reached; 3 a sent
# transaction is still pending; 124 ended at 20 minutes (137 when SIGKILL was needed 30 s later), a
# crash the next run reconciles from the record. It exits 1 (the service fails: systemctl --failed,
# bz-health) when a run ended with anything but 0 or 3; the next slot runs both again either way.
set -u
cd /home/ubuntu/bridge-zero/relayer || exit 1
failed=0
for network in base-sepolia arbitrum-sepolia; do
  /usr/bin/timeout --kill-after=30s 20m /usr/local/bin/node --max-old-space-size=160 --import tsx src/relay-main.ts \
    --network "$network" --chain v3 --send --account bz-relayer --password-file /home/ubuntu/.foundry/bz-relayer.pw
  code=$?
  echo "rollup run $network: exit $code"
  case "$code" in
    0 | 3) ;;
    *) failed=1 ;;
  esac
done
exit "$failed"
