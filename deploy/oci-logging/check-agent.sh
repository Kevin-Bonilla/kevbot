#!/usr/bin/env bash
# Pre-flight / post-install checks for the kevbot -> OCI Logging pipeline.
#
# Run ON the Oracle VM, from the repo checkout (/opt/kevbot):
#
#   sudo bash deploy/oci-logging/check-agent.sh
#   sudo bash deploy/oci-logging/check-agent.sh --emit-test
#
# Read-only by default. Everything here fails in a *visible* way instead of
# silently: the usual end state is "no logs in OCI" and ten equally plausible
# causes, so this walks the chain in order — container -> file -> agent ->
# network -> OCI.
#
# --emit-test appends one canary record to the log file and prints a unique
# marker to search for in the OCI Console. Give the agent a minute or two.
#
# Exit status: 0 if no hard failures, 1 otherwise (warnings do not fail).
set -uo pipefail

LOG_FILE="${LOG_FILE:-/opt/kevbot/logs/kevbot.log}"
APP_DIR="${APP_DIR:-/opt/kevbot}"
AGENT_UNIT="${AGENT_UNIT:-unified-monitoring-agent}"
POS_DIR="${POS_DIR:-/etc/unifiedmonitoringagent/pos}"
CONTAINER="${CONTAINER:-kevbot}"

EMIT_TEST=0
for arg in "$@"; do
  case "$arg" in
    --emit-test) EMIT_TEST=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

FAILURES=0
WARNINGS=0

hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m OK \033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
note() { printf '       %s\n' "$*"; }

# --------------------------------------------------------------------------
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  warn "not running as root; agent/position-file checks may be incomplete (use sudo)"
fi

hdr "1. Log file the agent must be tailing"

if [[ ! -e "$LOG_FILE" ]]; then
  bad "$LOG_FILE does not exist"
  note "The bot creates it on first write. Is the container running? docker logs $CONTAINER"
elif [[ ! -r "$LOG_FILE" ]]; then
  bad "$LOG_FILE is not readable (agent runs as root, so this is unusual)"
  note "ls -l $LOG_FILE"
else
  ok "$LOG_FILE exists and is readable"
  note "size: $(wc -c < "$LOG_FILE" | tr -d ' ') bytes, mode: $(stat -c '%a %U:%G' "$LOG_FILE" 2>/dev/null || echo '?')"

  last_line="$(tail -n 1 "$LOG_FILE" 2>/dev/null)"
  if [[ -z "$last_line" ]]; then
    warn "file is empty — nothing for the agent to ship yet"
  elif [[ "$last_line" == \{* ]]; then
    ok "last line is JSON (matches the JSON parser in the agent config)"
  else
    warn "last line is NOT JSON (looks like text format)"
    note "The agent config must then use the NONE or REGEXP parser."
    note "For the JSON parser, set LOG_FORMAT=json in $APP_DIR/.env and restart."
  fi

  # What the app *thinks* it is writing, as opposed to what we observe.
  if [[ -f "$APP_DIR/.env" ]]; then
    configured="$(grep -E '^LOG_FORMAT=' "$APP_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]')"
    configured="${configured:-text}"
    observed="text"
    [[ "$last_line" == \{* ]] && observed="json"
    if [[ "$configured" == "$observed" ]]; then
      ok "LOG_FORMAT=$configured agrees with the file contents"
    else
      warn "LOG_FORMAT=$configured in .env but the file looks like $observed"
      note "Restart the bot: sudo systemctl restart kevbot"
    fi
  fi
fi

# --------------------------------------------------------------------------
hdr "2. Container writes into the host directory the agent reads"

if command -v docker >/dev/null 2>&1 && docker inspect "$CONTAINER" >/dev/null 2>&1; then
  mounts="$(docker inspect "$CONTAINER" \
    --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' 2>/dev/null || true)"
  if [[ "$mounts" == *"$APP_DIR/logs:/app/logs"* ]]; then
    ok "$APP_DIR/logs is mounted at /app/logs (app default LOG_FILE=/app/logs/kevbot.log)"
  else
    warn "expected $APP_DIR/logs -> /app/logs, got: ${mounts:-<none>}"
    note "Check deploy/kevbot.service; without this mount the app writes inside the container"
    note "and the host file the agent tails stays empty."
  fi
else
  warn "container '$CONTAINER' not found (or docker unavailable) — skipped"
fi

# --------------------------------------------------------------------------
hdr "3. Unified Monitoring Agent"

# Capture first, then grep: `systemctl | grep -q` trips pipefail via SIGPIPE
# (systemctl exits 141) and would report a present unit as missing.
unit_list="$(systemctl list-unit-files 2>/dev/null || true)"
if grep -q "^${AGENT_UNIT}" <<< "$unit_list"; then
  if systemctl is-active --quiet "$AGENT_UNIT"; then
    ok "$AGENT_UNIT is active"
  else
    bad "$AGENT_UNIT is NOT active"
    note "systemctl status $AGENT_UNIT"
    note "Also confirm the 'Custom Logs Monitoring' plugin shows Running on the"
    note "instance's Oracle Cloud Agent tab in the Console."
  fi
  if systemctl is-enabled --quiet "$AGENT_UNIT" 2>/dev/null; then
    ok "$AGENT_UNIT is enabled at boot"
  else
    warn "$AGENT_UNIT is not enabled at boot"
    note "sudo systemctl enable $AGENT_UNIT"
  fi
else
  bad "unit $AGENT_UNIT not installed"
  note "Install the agent: see deploy/oci-logging/README.md step 1."
fi

if [[ -d "$POS_DIR" ]]; then
  pos_files="$(find "$POS_DIR" -maxdepth 1 -type f -name '*.pos' 2>/dev/null | head -n 5)"
  if [[ -n "$pos_files" ]]; then
    ok "position files present in $POS_DIR (the agent has started reading)"
    while IFS= read -r p; do note "$(basename "$p")"; done <<< "$pos_files"
  else
    warn "no .pos files in $POS_DIR yet"
    note "Either the agent has no active configuration, or it has not started."
  fi
else
  warn "$POS_DIR not found — agent may not have received a configuration yet"
fi

# --------------------------------------------------------------------------
hdr "4. Egress to the OCI endpoints the agent needs"

if ! command -v curl >/dev/null 2>&1; then
  warn "curl not found; skipping network checks (install curl to enable them)"
else
  region="${OCI_REGION:-}"
  if [[ -z "$region" ]]; then
    md="$(curl -fsS -m 5 -H 'Authorization: Bearer Oracle' \
          'http://169.254.169.254/opc/v2/instance/' 2>/dev/null || true)"
    region="$(printf '%s' "$md" | tr -d '\n' \
              | sed -n 's/.*"canonicalRegionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  fi

  if [[ -z "$region" ]]; then
    warn "could not determine the OCI region from instance metadata"
    note "Re-run as: OCI_REGION=us-ashburn-1 sudo -E bash $0"
  else
    ok "region: $region"
    for host in "auth.$region.oraclecloud.com" "ingestion.logging.$region.oci.oraclecloud.com"; do
      # Any HTTP status proves DNS+TLS+egress; only 000 is a real failure.
      code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$host" 2>/dev/null || true)"
      if [[ -z "$code" || "$code" == "000" ]]; then
        bad "https://$host unreachable"
        note "Open egress on 443 (VCN security list / NSG, and any host firewall)."
      else
        ok "https://$host reachable (HTTP $code)"
      fi
    done
  fi
fi

# --------------------------------------------------------------------------
if [[ "$EMIT_TEST" -eq 1 ]]; then
  hdr "5. Emitting a canary record"
  if [[ ! -w "$LOG_FILE" ]]; then
    bad "cannot append to $LOG_FILE"
  else
    marker="oci-canary-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
    # Literal milliseconds: GNU `date` has %3N but BSD/macOS does not, and the
    # agent's time format (%Y-%m-%dT%H:%M:%S.%LZ) needs a fractional part.
    ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    printf '{"time":"%s","level":"info","service":"kevbot","host":"%s","pid":0,"msg":"OCI logging canary %s"}\n' \
      "$ts" "$(hostname)" "$marker" >> "$LOG_FILE"
    ok "appended canary record to $LOG_FILE"
    note "Search OCI Logging for: $marker"
    note "It can take 1-2 minutes to appear. If it never does, the agent config"
    note "is the next place to look (path, host group, parser)."
  fi
fi

# --------------------------------------------------------------------------
printf '\n'
if [[ "$FAILURES" -gt 0 ]]; then
  printf '\033[31m%d failure(s)\033[0m, %d warning(s)\n' "$FAILURES" "$WARNINGS"
  exit 1
fi
if [[ "$WARNINGS" -gt 0 ]]; then
  printf '\033[32mno failures\033[0m, \033[33m%d warning(s)\033[0m\n' "$WARNINGS"
else
  printf '\033[32mall checks passed\033[0m\n'
fi
printf 'Next: OCI Console -> Observability & Management -> Logging -> Search.\n'
