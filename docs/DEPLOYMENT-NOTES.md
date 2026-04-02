# BSCS Deployment Notes

Real-world findings from deploying BSCS to manage the OpenClaw fleet on HQ (2026-04-02).

## Bugs Found and Fixed

### BUG-1: OpenClaw `agents list` returns `id`, not `name`

**Severity:** Critical — `bscs fleet import --from-openclaw` imported zero agents.

**Root cause:** `importFromOpenClaw()` in `src/core/fleet.ts` expected the agent list JSON to have a `name` field. OpenClaw's actual response uses `id`. Same issue in `OpenClawRuntime.status()` and `.list()` in `src/core/runtime/openclaw.ts`.

**OpenClaw response format:**
```json
[
  {
    "id": "atlas",
    "identityName": "Atlas 👑",
    "identityEmoji": "👑",
    "workspace": "/home/hani/.openclaw/workspace-atlas",
    "agentDir": "/home/hani/.openclaw/agents/atlas/agent",
    "model": "anthropic/claude-opus-4-6",
    "bindings": 1,
    "isDefault": true
  }
]
```

**Fix:** Use `agent.id || agent.name` as the canonical name. Map `identityName` and `identityEmoji` into the `openclaw.identity` config block.

**Commits:** `39f4137`, `418d94d`

## Deployment Gotchas

### GOTCHA-1: HQ repo was behind remote

The BSCS repo cloned on HQ was several commits behind `main`. The `--from-openclaw` flag didn't exist in the old build. Always `git pull` before deploying.

### GOTCHA-2: `npm link --force` required on second install

After pulling updates, `npm link` fails with `EEXIST` because the symlink already exists. Use `npm link --force`.

### GOTCHA-3: PATH not set for openclaw binary

On HQ, both `openclaw` and `bscs` are installed at `~/.npm-global/bin/` which isn't in the default SSH PATH. Every SSH command needs `export PATH="$HOME/.npm-global/bin:$PATH"` or the login shell profile needs to be updated.

**Fix for permanent:** Add to `~/.bashrc` or `~/.profile`:
```bash
export PATH="$HOME/.npm-global/bin:$PATH"
```

### GOTCHA-4: Watchdog is foreground-only

`bscs fleet watchdog` runs as a foreground process. For persistent monitoring, run in tmux/screen or use `--once` in a cron job:
```
*/5 * * * * /home/hani/.npm-global/bin/bscs fleet watchdog --once >> /var/log/bscs-watchdog.log 2>&1
```

The existing OpenClaw watchdog cron (`*/5`) and BSCS watchdog should NOT both auto-restart the gateway — they'll fight. Run BSCS watchdog in `--once` reporting mode alongside the existing cron for now. When confident, replace the old cron.

### GOTCHA-5: `bscs machine bootstrap` is Ubuntu-only

Uses `apt-get` internally. Won't work on macOS workers (mini1-4). Use `bscs machine add` for already-provisioned macOS machines (only writes to config, no remote install).

## Current Fleet State (HQ)

| Agent | Persona | Model | Status |
|---|---|---|---|
| atlas | Architect | `anthropic/claude-opus-4-6` | running |
| forge | Builder | `anthropic/claude-sonnet-4-6` | running |
| oracle | Investigator | `anthropic/claude-opus-4-6` | running |
| warden | Sentinel | `anthropic/claude-sonnet-4-6` | running |
| yield | Investigator | `anthropic/claude-sonnet-4-6` | running |
| nova | Herald | `minimax/MiniMax-M2.7-highspeed` | running |
| clerk | Sentinel | `minimax/MiniMax-M2.7-highspeed` | running |
| khadem | Builder | `anthropic/claude-sonnet-4-6` | running |

## Deployment Steps (Reproducible)

```bash
# 1. SSH to HQ
ssh hani@100.91.248.9

# 2. Pull latest and build
cd ~/bscs && git pull && npm ci && npm run build && npm link --force

# 3. One-time fleet init (idempotent — skips if config exists)
export PATH="$HOME/.npm-global/bin:$PATH"
bscs fleet init --non-interactive --fleet-name "the-bot-club"

# 4. Import agents from running gateway
bscs fleet import --from-openclaw http://127.0.0.1:18777 --apply

# 5. Verify
bscs fleet status
bscs fleet watchdog --once
bscs doctor
```

## Remaining Issues

### ISSUE-1: Channel bindings not populated in import

`openclaw agents list --json` returns `bindings: 1` (count) but not the actual channel types/account IDs. The `channels` array in BSCS config is empty after import. Need a separate command or API call to resolve bindings.

### ISSUE-2: Skills not returned by `agents list`

The OpenClaw `agents list` output doesn't include skills. The BSCS `openclaw.skills` field stays empty after import. Need to query per-agent config or workspace `skills/` directory.

### ISSUE-3: Cron jobs not returned by `agents list`

Same as skills — cron jobs aren't in the agent list output. BSCS has `openclaw.cronJobs` schema ready but nothing to populate it from. Could read from `~/.openclaw/cron/jobs.json` directly.

### ISSUE-4: Cost tracking requires agents to route through BSCS gateway

The BSCS LLM gateway (port 18999) only tracks costs for requests it proxies. Agents talking directly to Anthropic/MiniMax via the OpenClaw gateway (port 18777) are invisible to cost tracking. Routing agents through BSCS requires understanding how OpenClaw resolves model endpoints.

### ISSUE-5: Test mocks don't match real OpenClaw API

Unit tests for `importFromOpenClaw` used `{ name: "..." }` format. Real API returns `{ id: "..." }`. Tests now updated but need a fixture file or constant that mirrors the real response schema to prevent future drift.
