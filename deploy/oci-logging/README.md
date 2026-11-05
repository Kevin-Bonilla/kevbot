# Sending kevbot logs to OCI Logging

The bot already logs to the console (→ journald) and to a file. This guide adds
the last hop: an **OCI Unified Monitoring Agent** on the VM tails that file and
ships the lines to a **Logging custom log**, where you get search, retention,
and agent health metrics in the OCI Console.

```
kevbot container ──write──▶ /app/logs/kevbot.log
                                   │  bind mount (deploy/kevbot.service)
                                   ▼
                            /opt/kevbot/logs/kevbot.log   (host)
                                   │  tail + parse
                                   ▼
                    Unified Monitoring Agent (on the VM)
                                   │  https 443 to auth/ingestion.<region>.oraclecloud.com
                                   ▼
                     OCI Logging ─▶ custom log ─▶ Log Search / retention
```

**Why the agent and not the Logging Ingestion API from the bot?** The agent
buffers on disk and retries, so an OCI or network hiccup cannot slow the bot or
put a network call in the logging path. It also survives bot restarts and crash
loops — the file on disk still contains the logs that explain the crash — and it
emits its own operational metrics (heartbeat, emitted records, buffer space,
rollbacks) that you can alarm on. Direct ingestion would mean moving all of
that into `logger.ts`, plus OCI SDK credentials on the VM.

---

## Prerequisites

| Thing | Where to find it |
| --- | --- |
| Region | Console top-right, e.g. `us-chicago-1` |
| Compartment OCID | Identity → Compartments (use a dedicated `kevbot` compartment if you like) |
| Instance OCID | Compute → Instances → your VM → OCID |
| Access to the instance's Oracle Cloud Agent tab | to enable the plugin |
| Root/sudo on the VM | to install/verify the agent |

The two fixes that make logs *writable* at all are already in this repo:
`deploy/kevbot.service` bind-mounts `/opt/kevbot/logs` to `/app/logs` and
`chown`s it to `1000:1000` (the container's `node` user) before each start.

---

## Step 1 — Enable the agent on the VM (Ubuntu 22.04 / 24.04)

The supported route is the **Custom Logs Monitoring** plugin, which installs and
patches the agent for you — including on Ampere A1 (ARM) instances.

1. Console → **Compute → Instances → *your instance***.
2. Open the **Oracle Cloud Agent** tab.
3. Find **Custom Logs Monitoring**, switch it **on**, and wait until every plugin
   in the list shows **Running** (a minute or two; the first install is slower).

Verify from the VM:

```bash
systemctl status unified-monitoring-agent --no-pager
sudo ls /etc/unifiedmonitoringagent/
```

You should see the unit active; the config directory may stay empty until an
agent configuration is pushed (step 3).

<details>
<summary>Manual install (only if the plugin is unavailable)</summary>

Per Oracle's [Installing the Agent](https://docs.oracle.com/en-us/iaas/Content/Logging/Task/installing_the_agent.htm)
docs, fetch the package with `oci os object get` (needs CLI token auth) and
install the `.deb` for your Ubuntu release — `unified-monitoring-agent-ub-22-<version>.deb`
or `...-ub-24-<version>.deb`, adding `.aarch64` for ARM:

```bash
sudo dpkg -i unified-monitoring-agent-ub-22-<version>.deb
```

Use the `stableVersion` from `versionInfoV2.yml` (bucket
`unified-monitoring-agent-config`, namespace `axmjwnk4dzjv`) as `<version>`.
</details>

---

## Step 2 — IAM: let the agent write logs

The agent authenticates as the **instance** (instance principal), so the
instance must be in a dynamic group with a Logging policy.

1. **Identity → Dynamic Groups → Create Dynamic Group**:

   ```
   ANY {instance.compartment.id = 'ocid1.compartment.oc1..<compartment>'}
   ```

   (Narrow it with `instance.id = '<instance-ocid>'` if you prefer.)
   Name it e.g. `kevbot-agents`.

2. **Identity → Policies → Create Policy** in the root compartment:

   ```
   allow dynamic-group kevbot-agents to use log-content in compartment <compartment>
   ```

   Oracle's multi-host example uses `in tenancy`; a compartment scope is tighter
   and sufficient here.

---

## Step 3 — Create the custom log + agent configuration

Console → **Observability & Management → Logging → Logs → Create custom log**.

> **Terraform alternative:** [`deploy/tf/`](../tf/main.tf) creates the log group
> `kevbot-logs` and the custom log `kevbot-app`, so you can skip items 1–2 and go
> straight to the agent configuration (item 3). It cannot create the agent
> configuration itself — that has to reference the instance's dynamic group.

1. **Log name**: `kevbot-app`; pick the compartment; pick/create log group e.g.
   `kevbot-logs`.
2. **Show additional options → Retention**: 30 days is plenty; max is 180.
3. **Create agent configuration** (the wizard continues into it):
   - **Host group**: `Dynamic group` → `kevbot-agents` (from step 2).
   - **Configure log inputs** → **Input type: Log path**
     - **Input name**: `kevbot-app-log`
     - **Log path**: `/opt/kevbot/logs/kevbot.log`  ← the *host* path, not `/app/...`
   - **Advanced parser options** → **Parser: JSON**
     - **Time type**: the format-based option (Console label varies between
       versions: *Time format* / *Timestamp format*)
     - **Time key**: `time`
     - **Time format**: `%Y-%m-%dT%H:%M:%S.%LZ`
     - **Message key**: `msg`
   - **Select log destination**: log group `kevbot-logs`, log `kevbot-app`.
4. **Show additional options → Logging agent operational metrics → Enable**
   (heartbeat is always on). Choose a namespace, e.g. `kevbot_agent_metrics`.
   This is what gives you OCI-side monitoring of the pipeline (step 6).

> **If JSON parsing is rejected** by your Console version, use **Parser: NONE**
> for now — every line still arrives as searchable text, and you can switch to
> JSON later. A JSON parser will not match anything if the bot is still writing
> text (`LOG_FORMAT=text`); in that case use REGEXP or NONE instead.

The agent picks up the configuration within a couple of minutes; the agent
configuration's status should read **Active**.

---

## Step 4 — Make the bot write JSON

JSON is what makes the agent configuration above work: one event per line, a
`level` field to filter on, and stack traces kept inside a single record instead
of exploding into dozens of lines.

On the VM:

```bash
sudo sed -i 's/^LOG_FORMAT=.*/LOG_FORMAT=json/' /opt/kevbot/.env
grep '^LOG_' /opt/kevbot/.env
sudo systemctl restart kevbot
```

If `LOG_FORMAT` is not in `.env` yet, add it:

```bash
echo 'LOG_FORMAT=json' | sudo tee -a /opt/kevbot/.env
```

Leave `LOG_FILE` at its default. The container's working directory is `/app`, so
the relative `logs/kevbot.log` lands on `/app/logs/kevbot.log`, which is
`/opt/kevbot/logs/kevbot.log` on the host — the path in step 3. If you change
`LOG_FILE`, update the agent configuration to match.

Each line now looks like:

```json
{"time":"2026-11-04T19:58:13.123Z","level":"info","service":"kevbot","host":"kevbot-vm","pid":1,"msg":"KEVBOT is ONLINE!"}
{"time":"2026-11-04T19:59:02.004Z","level":"error","service":"kevbot","host":"kevbot-vm","pid":1,"msg":"Command purge failed:","error":{"name":"KevbotError","message":"...","code":"EACCES","stack":"KevbotError: ...\n    at ..."}}
```

The console/journald copy stays human-readable text — `LOG_FORMAT` only changes
the file.

---

## Step 5 — Verify end to end

On the VM:

```bash
sudo bash /opt/kevbot/deploy/oci-logging/check-agent.sh --emit-test
```

It checks, in order: the log file exists/is readable/is JSON, the container's
`/app/logs` mount, the agent unit and position files, and egress to
`auth.<region>.oraclecloud.com` and `ingestion.logging.<region>.oci.oraclecloud.com`.
`--emit-test` appends a canary line and prints a marker such as
`oci-canary-20261104T200102Z-31231`.

Then Console → **Logging → Search**, pick the compartment and log
`kevbot-app`, and search for that marker (allow 1–2 minutes). Useful filters,
appended to the default query the Console shows:

```
| where level = 'error'
| where level = 'error' and msg contains 'purge'
| where service = 'kevbot'
```

Fields from the JSON record (`level`, `service`, `msg`, `error.name`, ...) are
available for filtering; whether a nested key such as `error.code` is queryable
directly depends on the Console version, so `msg contains 'EACCES'` is the safe
fallback.

Retention is enforced by OCI, independently of the local file.

---

## Step 6 — Monitoring the pipeline (optional but recommended)

Alarms in OCI Monitoring work on **metrics**, not on log text. With agent
operational metrics enabled in step 3 you get:

| Metric | Use |
| --- | --- |
| `Heartbeat` | 1 = agent alive, 0 = not responding → alarm on this |
| `EmitRecords` | records shipped; flat line = ingestion stalled |
| `BufferSpaceAvailable` | trending down = agent can't keep up |
| `RollbackCount` / `RetryCount` | OCI-side or network trouble |

Console → **Monitoring → Alarms → Create alarm**, choose the namespace you set
in step 3, metric `Heartbeat`, the instance dimension (the Console lists the
exact key — the instance OCID), trigger when the value is below 1 for a few
minutes, and notify a topic (email/Slack webhook). That is the "bot is deaf but
the process is up" alarm the gateway handlers in `src/index.ts` already log
about.

For **content-based** alerting (e.g. page on `level = 'error'`), OCI Logging has
no built-in rule engine — route the log through a Service Connector Hub
(Logging → Functions/Streaming) or use Logging Analytics. Not needed for a
single bot.

---

## Troubleshooting

Work top-down; `check-agent.sh` covers the local checks in the first four rows.

| Symptom | Check |
| --- | --- |
| Nothing in Log Search, canary missing | Agent unit active; plugin **Running** in the Console; agent config **Active** and not disabled |
| Canary in the file but not OCI | Egress on 443 to `auth.*` and `ingestion.logging.*` (VCN security list/NSG); IAM policy `use log-content`; host group actually matches the instance |
| Records arrive but `level` is not a field | Parser not JSON, or the bot is still writing text — `check-agent.sh` compares `.env` with the file |
| The whole JSON line sits in the message body | Parser NONE/REGEXP; switch it to JSON |
| `time` is ingestion time, not app time | Wrong **Time key**/format; must be `time` + `%Y-%m-%dT%H:%M:%S.%LZ` |
| Duplicate lines | Two agent configurations (or inputs) matching the same file — each has its own position file |
| A gap in the logs | Agent was down or reinstalled and its position file was lost: tail resumes at the end of the file, so lines written in the gap are skipped |
| Missing lines right after `systemctl restart kevbot` | A few seconds' race while the file is reopened; the app appends, so nothing is lost once the fd is open |
| Very long stacks truncated | OCI caps a field at 10,000 characters |
| No logs at all after a reboot | `systemctl is-enabled unified-monitoring-agent`; the plugin also reinstalls itself |

Agent-side detail: `journalctl -u unified-monitoring-agent -f`.

---

## Notes / deliberate limits

- **No rotation.** Log volume is tiny (tens of KB per week; the whole scan/purge
  history fits in well under a megabyte), and renaming the file out from under a
  tailing agent risks skipped lines. Revisit with `logrotate` + `copytruncate`
  only if volume grows.
- **One log stream.** Everything goes to the same custom log; split by `level`
  or `service` in queries.
- **The file remains the source of truth.** If the agent is broken, fix it and it
  catches up from its position file; the bot never blocks on logging.
