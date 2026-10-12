#!/usr/bin/env bash
# Installs the OCI CLI and the Unified Monitoring (logging) agent on an
# Oracle Linux / RHEL / CentOS instance, then configures the agent to ship
# journald logs from the `kevbot` systemd unit to OCI Logging.
#
# Run on the VM itself (as the deploy user or root):
#   bash deploy/oci-setup.sh
#
# Idempotent: safe to re-run. Will skip steps already completed.
set -euo pipefail

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Install the OCI CLI (if not already present) ---
say "Checking for OCI CLI"
if ! command -v oci >/dev/null 2>&1; then
  say "Installing OCI CLI"
  # Use the official installer. It detects the platform and installs to
  # ~/.local/bin (or /usr/local/bin under root). --accept-terms-agrees to
  # the Oracle Universal License.
  if [ "$(id -u)" = "0" ]; then
    bash -c "$(curl -sL https://raw.githubusercontent.com/oracle/oci-cli/master/install/install.sh)" \
      -- --accept-terms-agrees --installer-version=latest --skip-prerequisites
  else
    sudo bash -c "$(curl -sL https://raw.githubusercontent.com/oracle/oci-cli/master/install/install.sh)" \
      -- --accept-terms-agrees --installer-version=latest --skip-prerequisites
  fi
  # Ensure ~/.local/bin (where the installer puts the binary for non-root) is on PATH.
  export PATH="$HOME/.local/bin:$PATH"
  command -v oci >/dev/null 2>&1 || die "OCI CLI installation failed."
  say "OCI CLI installed: $(oci --version)"
else
  say "OCI CLI already installed: $(oci --version)"
fi

# --- 2. Install the Unified Monitoring (logging) agent ---
# The agent is a Debian/RPM package (oracle-cloud-agent) that includes the
# logging agent plugin. On OCI Compute instances it is usually pre-installed;
# this step handles bring-your-own or custom images.
say "Checking for Oracle Cloud Agent (unified monitoring / logging agent)"
if command -v oracle-cloud-agent >/dev/null 2>&1 || systemctl status oracle-cloud-agent >/dev/null 2>&1; then
  say "Oracle Cloud Agent already present."
else
  say "Installing Oracle Cloud Agent"
  OS_TYPE="$(. /etc/os-release && echo "$ID" | tr '[:upper:]' '[:lower:]')"
  case "$OS_TYPE" in
    ol|centos|rhel|amazon)
      sudo yum install -y oraclelinux-developer-release-el7 || true
      sudo yum install -y oracle-cloud-agent || true
      ;;
    ubuntu|debian)
      # Add the Oracle Linux repo for the agent package.
      curl -sSL https://yum.oracle.com/oraclelinux-developer-release-el7.rpm \
        | sudo tee /etc/apt/sources.list.d/oracle-cloud-agent.list
      sudo apt-get update -qq
      sudo apt-get install -y oracle-cloud-agent
      ;;
    *)
      die "Unsupported OS: $OS_TYPE. Install oracle-cloud-agent manually."
      ;;
  esac
  say "Oracle Cloud Agent installed."
fi

# Ensure the agent is running.
say "Starting oracle-cloud-agent"
sudo systemctl enable --now oracle-cloud-agent 2>/dev/null || true
sleep 2

# --- 3. Configure the logging agent to collect kevbot journald logs ---
# The agent reads its config from /etc/oracle-cloud-agent/plugins/oci-logging-agent/
# We create a config that targets the `kevbot` systemd unit's journald entries.
say "Configuring OCI Logging agent for the kevbot service"

AGENT_CONFIG_DIR="/etc/oracle-cloud-agent/plugins/oci-logging-agent/conf.d"
sudo mkdir -p "$AGENT_CONFIG_DIR"

# The config file uses the agent's `log_source_group` format.
# Each [log_source_group] block maps a source (journald) to a log name.
cat <<'AGENT_CONFIG' | sudo tee "$AGENT_CONFIG_DIR/kevbot.conf" > /dev/null
[log_source_group]
    log_source_group_name = "kevbot-journal"
    sources = [{
        type = "JOURNALD"
        include_units = ["systemd"]
        filters = [
            { key = "_SYSTEMD_UNIT", value = "kevbot.service" }
        ]
    }]
AGENT_CONFIG

say "Logging agent config written to $AGENT_CONFIG_DIR/kevbot.conf"

# Restart the logging agent to pick up the new config.
say "Restarting OCI Logging agent"
sudo systemctl restart oracle-cloud-agent 2>/dev/null || true
sleep 2

# --- 4. Verify ---
say "Verifying..."
if systemctl is-active --quiet oracle-cloud-agent; then
  say "Oracle Cloud Agent is running."
else
  die "Oracle Cloud Agent is not running. Check: journalctl -u oracle-cloud-agent -n 50"
fi

say "Done!"
cat <<'SUMMARY'

OCI Logging agent setup complete. Next steps on the OCI Console:

1. Go to: Identity & Security > Instances > your-kevbot-vm > Logs
   (or search for "Logging" in the console search bar)

2. If the agent is reporting correctly, you should see a "kevbot-journal" log
   source appear under the instance's Logs tab within a minute or two.

3. Create a Log in OCI Logging:
   - Navigate to: Observability > Logging > Log Groups
   - Click your log group (or create one: "kevbot")
   - Click "Create Log"
   - Log source: "Existing instance"
   - Select your kevbot VM
   - Source: "System" / "Custom" — the agent config name should match
     "kevbot-journal"

4. (Optional) Set up alerting:
   - Navigate to Observability > Monitoring > Alarms
   - Create an alarm on your kevbot log for patterns like:
     - "Gateway disconnected"
     - "Uncaught exception"
     - "Unhandled promise rejection"

SUMMARY