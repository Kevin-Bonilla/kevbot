#!/usr/bin/env bash
# One-time VM setup for Kevbot on an Oracle Always Free instance.
# Run as the deploy user (not root):  bash deploy/setup-vm.sh
#
# Idempotent: safe to re-run after pulling new code.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/kevbot}"
REPO_URL="${REPO_URL:-https://github.com/Kevin-Bonilla/kevbot.git}"
BRANCH="${BRANCH:-feature-1-purge}"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

say "Checking prerequisites"
command -v docker >/dev/null || die "docker not found. On Oracle Linux/Ubuntu: install Docker, then re-run."
command -v git   >/dev/null || die "git not found. Install it and re-run."
docker info >/dev/null 2>&1 || die "docker is installed but the daemon isn't running. Try: sudo systemctl start docker"

say "Creating $APP_DIR"
sudo mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
sudo chown -R "$(id -u):$(id -g)" "$APP_DIR" 2>/dev/null || true

# --- Source ---
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing clone"
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only
else
  say "Cloning $REPO_URL ($BRANCH) into $APP_DIR"
  # The repo may be private; if so, use a deploy key or a PAT in the URL
  # rather than committing a token to this script.
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

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
  say "WARNING: no purge role configured — !purgeDryRun / !purge will be disabled."
fi

# --- Data files ---
# The list files are gitignored, so a fresh clone has no data/ contents beyond
# counter.json. An absent list means "empty", which is safe; a 0-BYTE file is
# malformed and ABORTS the purge. Create them properly.
for f in whitelisted_users.json blacklisted_users.json; do
  if [ ! -f "$APP_DIR/data/$f" ]; then
    say "Creating empty data/$f"
    echo '[]' > "$APP_DIR/data/$f"
  elif [ ! -s "$APP_DIR/data/$f" ]; then
    say "data/$f is 0 bytes — that ABORTS the purge. Rewriting as []"
    echo '[]' > "$APP_DIR/data/$f"
  fi
done

# --- Build ---
say "Building image (first build takes a few minutes)"
docker build -t kevbot:latest "$APP_DIR"

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

cat <<'EOF'

Done. Useful commands:
  systemctl status kevbot          # is it up
  journalctl -u kevbot -f         # live logs
  journalctl -u kevbot --since "1 hour ago" -p err
  sudo systemctl restart kevbot   # after a git pull + rebuild

Note: .env, data/whitelisted_users.json and data/blacklisted_users.json are
gitignored, so they live only on this VM. Back them up if this box is
disposable — Oracle's free tier can be reclaimed if an account is idle.
EOF
