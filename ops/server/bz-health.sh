#!/usr/bin/env bash
# /home/ubuntu/bz-ops/bz-health.sh
# Read-only health check of Bridge Zero on this server: one line a check (ok, WARN, FAIL), then a
# summary; exit 1 when a check FAILs. It reads systemd's view of the units, the journal, the names of
# the state directory's files and the host's clock, memory and disk. It opens no key, password file or
# record, changes nothing, and signs and sends nothing.
#   From another machine:  ssh ubuntu@<server> bz-ops/bz-health.sh
#   bz-health.timer runs it every 15 minutes: each run's lines are in journalctl -u bz-health, and
#   bz-health.service stays failed (systemctl --failed) while a check FAILs.
# Optional heartbeat: a URL in /home/ubuntu/bz-ops/heartbeat.url (one line, mode 600) is fetched when no
# check FAILs, so that a monitor elsewhere tells when the pings stop. The URL is never printed.
set -u
STATE=/home/ubuntu/.bridge-zero
HEARTBEAT=/home/ubuntu/bz-ops/heartbeat.url
fails=0
warns=0
ok() { echo "ok   $*"; }
warn() { warns=$((warns + 1)); echo "WARN $*"; }
fail() { fails=$((fails + 1)); echo "FAIL $*"; }
now=$(date +%s)
uptime=$(cut -d. -f1 /proc/uptime)

# A resident unit: running, and the shortest wait its last "Next" line names not overrun by more than
# $4 minutes (a round or run under way). $2: that line's pattern; $3: the longest wait of a healthy
# line (a longer one is a back-off: rounds or runs keep failing, or wait for the operator).
resident() {
  local unit=$1 pattern=$2 normal=$3 grace=$4 state info since age id line at waits min max late
  state=$(systemctl is-active "$unit")
  info=$(systemctl show -p NRestarts -p Result -p ExecMainStatus "$unit" | tr '\n' ' ')
  info=${info% }
  if [ "$state" != active ]; then
    fail "$unit is $state ($info): journalctl -u $unit -n 60"
    return
  fi
  since=$(systemctl show -p ActiveEnterTimestampMonotonic --value "$unit")
  age=$((uptime - ${since:-0} / 1000000))
  id=$(systemctl show -p InvocationID --value "$unit")
  # The journal's time (Unix seconds) and the text of this run's last "Next" line.
  line=$(journalctl _SYSTEMD_INVOCATION_ID="$id" --since=-3h -o short-unix --no-pager 2>/dev/null |
    sed -nE "s/^([0-9]+)\.[0-9]+ [^ ]+ [^ ]+: ($pattern.*)\$/\1 \2/p" | tail -n 1)
  if [ -z "$line" ]; then
    if [ "$age" -lt $(((grace + 10) * 60)) ]; then
      ok "$unit up $((age / 60)) min, its first round or run under way ($info)"
    else
      fail "$unit up $((age / 60)) min with no \"Next\" line in the last 3 hours: journalctl -u $unit -n 60"
    fi
    return
  fi
  at=${line%% *}
  waits=$(printf '%s\n' "$line" | grep -oE 'in [0-9]+ s' | grep -oE '[0-9]+' | sort -n)
  min=$(printf '%s\n' "$waits" | head -n 1)
  max=$(printf '%s\n' "$waits" | tail -n 1)
  late=$((now - at - ${min:-0}))
  if [ "$late" -gt $((grace * 60)) ]; then
    fail "$unit: its last \"Next\" line is $(((now - at) / 60)) min old (shortest wait ${min:-0} s): stuck? journalctl -u $unit -n 60"
  elif [ "${max:-0}" -gt "$normal" ]; then
    warn "$unit backs off, waits up to $max s: its rounds or runs keep failing, or wait for the operator; journalctl -u $unit -n 80 ($info)"
  else
    ok "$unit up $((age / 60)) min, last \"Next\" line $(((now - at) / 60)) min ago ($info)"
  fi
}

resident bz-release 'Next rounds?( in|:) ' 15 20
resident bz-automint 'Next rounds?( in|:) ' 15 30
resident bz-relay-v3 'Next run in [0-9]+ s' 600 45
resident bz-relay-mainnet 'Next run in [0-9]+ s' 600 45

# The committee's halt file: the release watcher does not start while it is there.
halts=$(ls "$STATE"/release-watch-*.halt 2>/dev/null | tr '\n' ' ')
if [ -n "$halts" ]; then
  fail "halt file ${halts% }: the release watcher stays stopped until a member has looked at it (cat it)"
else
  ok "no halt file"
fi

# The rollup relays: the timer, and each network's last run in the last 7 hours (slots are never further apart).
state=$(systemctl is-active bz-rollups.timer)
if [ "$state" = active ]; then ok "bz-rollups.timer active"; else fail "bz-rollups.timer is $state: no rollup run is scheduled"; fi
runs=$(journalctl -u bz-rollups --since=-7h -o cat --no-pager 2>/dev/null | grep -E '^rollup run [a-z-]+: exit [0-9]+$')
for network in base-sepolia arbitrum-sepolia; do
  last=$(printf '%s\n' "$runs" | grep -F "rollup run $network: " | tail -n 1)
  code=${last##* }
  if [ -z "$last" ]; then
    warn "no rollup run for $network in the last 7 hours (none yet since the timer was enabled?)"
  elif [ "$code" = 0 ] || [ "$code" = 3 ]; then
    ok "last rollup run for $network: exit $code"
  else
    warn "last rollup run for $network ended with exit $code: journalctl -u bz-rollups --since=-7h"
  fi
done

# The host: clock, memory, disk.
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
  ok "clock synchronized"
else
  warn "clock not synchronized (timedatectl): the auto-mint's grace and spend window and the relayers' replace-after compare times"
fi
avail=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
swap=$(awk '/^SwapTotal:/ {t = $2} /^SwapFree:/ {f = $2} END {print int((t - f) / 1024)}' /proc/meminfo)
if [ "${avail:-0}" -ge 150 ]; then ok "memory: $avail MB available, $swap MB of swap used"; else warn "memory: ${avail:-?} MB available, $swap MB of swap used: ps -eo rss,comm --sort=-rss | head"; fi
disk=$(df -Pm / | awk 'NR == 2 {print $4}')
if [ "${disk:-0}" -ge 3072 ]; then ok "disk: $disk MB free on /"; else warn "disk: ${disk:-?} MB free on /: journalctl --disk-usage"; fi

# The heartbeat, only when nothing FAILs.
if [ "$fails" -eq 0 ] && [ -s "$HEARTBEAT" ]; then
  if curl -fsS -m 15 --retry 2 -o /dev/null "$(head -n 1 "$HEARTBEAT")" 2>/dev/null; then ok "heartbeat sent"; else warn "the heartbeat could not be sent"; fi
fi

echo "health: $fails FAIL, $warns WARN, $(date '+%a %b %-d, %-I:%M %p %Z')"
[ "$fails" -eq 0 ]
