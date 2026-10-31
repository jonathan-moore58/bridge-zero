#!/usr/bin/env bash
# /home/ubuntu/bz-ops/bz-stop-at-idle.sh
# Stops one Bridge Zero service at an idle moment of its journal:
#   bz-stop-at-idle.sh bz-release|bz-automint|bz-relay-v3|bz-relay-mainnet [minutes, default 30]
# It waits until the unit's last line of its own is its "next" line and the lines before it show
# nothing in flight, then runs sudo systemctl stop on it. If that does not happen in time, nothing is
# stopped. The lines polkadot-js and Node write to stderr share the journal with the unit's own and
# are left out (dated "YYYY-MM-DD HH:MM:SS ... API-WS: ...", "Failed WS Request: ...", a stack's
# "    at ..." lines, "(node:N) ..." warnings): the laptop's helper read stdout alone.
set -u

bz_patterns() {
  case "$1" in
    # The watcher: round summaries all zeros, then "Next rounds"; no approval signed or settling.
    bz-release) idle='^Next rounds?( in|:) '; busy='^Signed |something sent is not final yet|settling |: [1-9][0-9]* released|, [1-9][0-9]* (waiting|refused|left to the members)' ;;
    # The auto-mint: "Next rounds", no mint signed and waiting for its receipt in the lines shown.
    bz-automint) idle='^Next rounds?( in|:) '; busy='^ +signed 0x|has no receipt after|signs nonce [0-9]+ again' ;;
    # A relayer: its run is over; what it sent is checked, or open in its record for the next run.
    bz-relay-v3 | bz-relay-mainnet) idle='^Next run in [0-9]+ s'; busy='' ;;
    *) return 1 ;;
  esac
}

bz_idle() {
  local lines last before
  lines=$(journalctl -u "$1" -n 300 -o cat --no-pager 2>/dev/null |
    grep -vE '^[[:space:]]*$|^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} |^Failed WS Request|^[[:space:]]+at .*(file|node):|^\(node:[0-9]+\) ' |
    tail -n 60)
  last=$(printf '%s\n' "$lines" | tail -n 1)
  before=$(printf '%s\n' "$lines" | head -n -1)
  printf '%s\n' "$last" | grep -Eq "$idle" || return 1
  [ -z "$busy" ] && return 0
  ! printf '%s\n' "$before" | grep -Eq "$busy"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  unit=${1:-}
  minutes=${2:-30}
  bz_patterns "$unit" || { echo "usage: $0 bz-release|bz-automint|bz-relay-v3|bz-relay-mainnet [minutes]"; exit 2; }
  systemctl is-active --quiet "$unit" || { echo "$unit is not running: nothing to stop"; exit 0; }
  end=$(($(date +%s) + minutes * 60))
  while [ "$(date +%s)" -lt "$end" ]; do
    if bz_idle "$unit"; then
      sudo systemctl stop "$unit"
      echo "$unit stopped at $(date '+%-I:%M:%S %p')"
      exit 0
    fi
    sleep 0.5
  done
  echo "$unit was not idle within $minutes minutes: nothing stopped; read journalctl -u $unit"
  exit 1
fi
