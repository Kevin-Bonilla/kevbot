#!/usr/bin/env bash
# One-time VM setup for Kevbot on an Oracle Always Free instance.
# Run as the deploy user (not root):  bash deploy/setup-vm.sh
#
# Idempotent: safe to re-run after pulling new code.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/kevbot}"
REPO_URL="${REPO_URL:-https://github.com/Kevin-Bonilla/kevbot.git}"
BRANCH="${BRANCH:-main}"

# uid:gid of the `node` user in the runtime image (Dockerfile `USER node`). The
# systemd unit's ExecStartPre enforces the same pair on data/ and logs/, so keep
# these in sync or the container cannot write its own state.
CONTAINER_UID=1000
CONTAINER_GID=1000

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Checksum of the deployed copy of this script before the pull below replaces
# it (empty if APP_DIR does not exist yet). See the re-exec after the pull.
SCRIPT_BEFORE="$(cksum "$APP_DIR/deploy/setup-vm.sh" 2>/dev/null || true)"

say "Checking prerequisites"
command -v docker >/dev/null || die "docker not found. On Oracle Linux/Ubuntu: install Docker, then re-run."
command -v git   >/dev/null || die "git not found. Install it and re-run."

# Try to start the daemon if it is not already up. `docker info` is a poor
# check here: it needs the docker group, which this session may not have yet,
# so a stopped-but-fine daemon looks identical to a broken one. Start first,
# then verify, and only complain if it is genuinely not running afterward.
if ! docker ps >/dev/null 2>&1; then
  say "docker daemon not responding, attempting start"
  sudo systemctl enable --now docker >/dev/null 2>&1 || true
  sleep 3
fi
if ! docker ps >/dev/null 2>&1; then
  # Last resort: use sudo for the rest of this run rather than dying, since the
  # daemon may be healthy and only the group membership is missing.
  sudo -n docker ps >/dev/null 2>&1 || die "docker daemon is not running. Check: sudo systemctl status docker"
  say "docker requires sudo in this session; continuing (group may need a new login)"
fi

say "Creating $APP_DIR"
sudo mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
if [ -d "$APP_DIR/.git" ]; then
  # Update: data/ and logs/ must stay owned by the container user. The old
  # container is still running while this script builds, and handing those
  # directories to the deploy user (the old chown -R over the whole tree) made
  # its last writes fail: the log file went EACCES, and the deploy marker could
  # not be written, so the restart had nothing to announce as awake. The repo
  # itself is already the deploy user's; only a fresh clone needs the full
  # chown.
  sudo chown -R "$CONTAINER_UID:$CONTAINER_GID" "$APP_DIR/data" "$APP_DIR/logs" 2>/dev/null || true
else
  sudo chown -R "$(id -u):$(id -g)" "$APP_DIR" 2>/dev/null || true
fi

# --- Source ---
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing clone"
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only
else
  # APP_DIR already exists (we created data/ and logs/ above), and `git clone`
  # refuses a non-empty destination. Clone into a staging dir and move the
  # repository in, leaving data/ and logs/ untouched.
  say "Cloning $REPO_URL ($BRANCH) into $APP_DIR"
  # The repo may be private; if so, use a deploy key or a PAT in the URL
  # rather than committing a token to this script.
  STAGE="$(mktemp -d)"
  git clone --branch "$BRANCH" "$REPO_URL" "$STAGE/repo"
  shopt -s dotglob nullglob
  mv "$STAGE/repo"/* "$APP_DIR"/
  shopt -u dotglob nullglob
  rm -rf "$STAGE"
fi

# --- Re-exec if this script updated itself ---
# This script normally runs from the clone it is about to update (the deploy
# workflow runs `bash deploy/setup-vm.sh` in /opt/kevbot). The pull above
# replaces that file on disk, but bash opened it before the pull and keeps
# reading the old copy, so a change to this script used to take effect only on
# the NEXT deploy. That is why the first deploy of the KEVBOT_COMMIT stamp
# built the image without --build-arg and /status reported "unknown": the
# running copy still had the old build command.
#
# Re-exec once when the file changed, so the rest of this run is the version
# that was just pulled. The environment variable is the loop guard and
# survives exec.
SCRIPT_AFTER="$(cksum "$APP_DIR/deploy/setup-vm.sh" 2>/dev/null || true)"
if [ "${KEVBOT_SETUP_REEXEC:-0}" != "1" ] && [ -n "$SCRIPT_AFTER" ] && [ "$SCRIPT_BEFORE" != "$SCRIPT_AFTER" ]; then
  export KEVBOT_SETUP_REEXEC=1
  say "deploy/setup-vm.sh changed; re-executing the updated version"
  exec bash "$APP_DIR/deploy/setup-vm.sh" "$@"
fi

# Sanity-check that the deploy files actually arrived. A wrong branch or a
# silent clone failure used to sail through until the systemd step failed.
[ -f "$APP_DIR/Dockerfile" ] || die "Dockerfile missing in $APP_DIR - wrong branch?"
[ -f "$APP_DIR/deploy/kevbot.service" ] || die "deploy/kevbot.service missing - wrong branch?"

# --- Secrets ---
# .env is gitignored, so it is never cloned. It must be created by hand.
if [ ! -f "$APP_DIR/.env" ]; then
  say "No .env found — creating from .env.example (you must edit it)"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  cat <<'EOF'

    >>> EDIT NOW: sudo nano /opt/kevbot/.env <<<

    Required:  DISCORD_TOKEN   (from the Discord developer portal)
    Also set:  PURGE_ROLE_ID or PURGE_ADMIN_IDS  (or the gated commands stay disabled)

    Then re-run this script.

EOF
  exit 1
fi
chmod 600 "$APP_DIR/.env"

# docker reads the env file itself; the token must be readable by the
# daemon's user, so keep it owner-only rather than world-readable.
say "Sanity-checking .env"
if grep -qE '^DISCORD_TOKEN=YOUR_TOKEN_HERE' "$APP_DIR/.env"; then
  die "DISCORD_TOKEN is still the placeholder. Edit $APP_DIR/.env first."
fi
if ! grep -qE '^(PURGE_ROLE_ID|PURGE_ADMIN_IDS|PURGE_ROLE_NAME)=' "$APP_DIR/.env"; then
  say "WARNING: no purge role configured — /purge will be disabled."
fi

# --- Data files ---
# The list files are gitignored, so a fresh clone has no data/ contents beyond
# counter.json. An absent list means "empty", which is safe; a 0-BYTE file is
# malformed and ABORTS the purge. Create them properly.
#
# sudo, because data/ belongs to the container user (see the chown above), not
# to the deploy user. The file is created root-owned by tee and then handed to
# the container uid, matching what systemd does before the container starts.
for f in whitelisted_users.json blacklisted_users.json; do
  if [ ! -f "$APP_DIR/data/$f" ]; then
    say "Creating empty data/$f"
    printf '[]\n' | sudo tee "$APP_DIR/data/$f" >/dev/null
    sudo chown "$CONTAINER_UID:$CONTAINER_GID" "$APP_DIR/data/$f"
  elif [ ! -s "$APP_DIR/data/$f" ]; then
    say "data/$f is 0 bytes — that ABORTS the purge. Rewriting as []"
    printf '[]\n' | sudo tee "$APP_DIR/data/$f" >/dev/null
    sudo chown "$CONTAINER_UID:$CONTAINER_GID" "$APP_DIR/data/$f"
  fi
done

# --- Build ---
say "Building image (first build takes a few minutes)"
# Stamp the commit into the image so /status can report the build that is
# actually running (Dockerfile ARG KEVBOT_COMMIT). The checkout may be ahead of
# the running service, so the ref alone is not the answer.
GIT_COMMIT="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
docker build --build-arg "KEVBOT_COMMIT=$GIT_COMMIT" -t kevbot:latest "$APP_DIR"

# --- Service ---
if [ -f "$APP_DIR/deploy/kevbot.service" ]; then
  say "Installing systemd unit"
  sudo cp "$APP_DIR/deploy/kevbot.service" /etc/systemd/system/kevbot.service
  sudo systemctl daemon-reload
  sudo systemctl enable kevbot
  say "Starting kevbot"
  sudo systemctl restart kevbot
  sleep 6
  sudo systemctl status kevbot --no-pager || true
else
  say "No systemd unit found; start manually with:"
  echo "  docker run -d --name kevbot --restart unless-stopped \\"
  echo "    --env-file $APP_DIR/.env \\"
  echo "    -v $APP_DIR/data:/app/data -v $APP_DIR/logs:/app/logs \\"
  echo "    kevbot:latest"
fi

# --- OCI Logging ---
# Deliberately NOT automated here. Shipping logs to OCI Logging needs an agent
# configuration created in the OCI Console (or API) against this instance's
# dynamic group, plus an IAM policy; none of that can be done from this VM
# without credentials it should not have. See deploy/oci-logging/README.md.
# This script only guarantees the precondition: a host directory the agent can
# tail, which the systemd unit's bind mount and chown above already provide.

cat <<'EOF'

Done. Useful commands:
  systemctl status kevbot          # is it up
  journalctl -u kevbot -f         # live logs
  journalctl -u kevbot --since "1 hour ago" -p err
  sudo systemctl restart kevbot   # after a git pull + rebuild

Send these logs to OCI Logging (optional, one-time Console + IAM setup):
  see /opt/kevbot/deploy/oci-logging/README.md
  sudo bash /opt/kevbot/deploy/oci-logging/check-agent.sh --emit-test

Note: .env, data/whitelisted_users.json, data/blacklisted_users.json and
data/kevbot.db are gitignored, so they live only on this VM. Back them up if
this box is disposable — Oracle's free tier can be reclaimed if an account is
idle.
EOF
