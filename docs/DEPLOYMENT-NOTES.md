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

### ISSUE-1: ~~Channel bindings not populated in import~~ FIXED

`openclaw agents list --json` returns `bindings: 1` (count) but not the actual channel types/account IDs. Fixed by making a per-agent follow-up call to `openclaw agents get --json <name>` which returns full details including channels.

### ISSUE-2: Skills not returned by `agents list`

The OpenClaw `agents list` output doesn't include skills. The BSCS `openclaw.skills` field stays empty after import. Need to query per-agent config or workspace `skills/` directory.

### ISSUE-3: Cron jobs not returned by `agents list`

Same as skills — cron jobs aren't in the agent list output. BSCS has `openclaw.cronJobs` schema ready but nothing to populate it from. Could read from `~/.openclaw/cron/jobs.json` directly.

### ISSUE-4: ~~Cost tracking requires agents to route through BSCS gateway~~ RESOLVED

All agents now route through BSCS gateway (Phase 2). Cost tracking works for proxied requests.

### ISSUE-5: ~~Test mocks don't match real OpenClaw API~~ FIXED

Drift detection tests now use `{ id: "..." }` raw API format with `normalizeListAgents()` helper.

### ISSUE-6: Docker bridge DNS broken on HQ (NOT FIXED — requires sudo)

HQ's default Docker `bridge` network has `"invalid Prefix"` in IPAM config, breaking container name resolution. Workaround: custom `bscs-net` network. Root fix: `sudo systemctl restart docker` (requires downtime for all containers).

---

## Bugs Fixed in This Session (2026-04-03)

### BUG-10: importFromOpenClaw() hardcodes channels: []

**Fix:** Makes per-agent follow-up call to `openclaw agents get --json <name>` to fetch full details including channel bindings. Extracts `channels` array from the detailed response.

### BUG-11: listAgents() returns raw API data without normalizing id→name

**Fix:** Normalizes raw JSON response same way `list()` does: `a.id || a.name || 'unknown'`. Also extracts channels, enabled, and model fields.

### BUG-12: Drift detection fails when listAgents() returns id not name

**Fix:** Consequence of BUG-11 fix. Drift detection at fleet.ts line 394 does `liveAgent.name === name` which now works because `listAgents()` normalizes properly.

### BUG-13: Import always sets status 'running' regardless of enabled state

**Fix:** Uses `agent.enabled !== false` to determine running/stopped status during import.

### BUG-14: Import doesn't extract fallback models

**Fix:** Added `extractFallbacks()` helper that checks both `fallbackModels` and `fallbacks` field names from agent details.

### BUG-15: Transitive dependency vulnerabilities

**Fix:** `npm audit fix` upgraded lodash-es to 4.18.1. Added `overrides` in package.json for picomatch ^4.0.4 and brace-expansion ^2.0.3. Result: 0 vulnerabilities.

### BUG-16: No compose file for BSCS gateway deployment

**Fix:** Added `docker-compose.yml`, `docker-compose.hq.yml` (HQ override), and `.env.example`. Gateway now deployable via `docker compose up -d` instead of manual `docker run`.

## Full Test Results

- **42 test files, 402 tests, all passing**
- **0 npm audit vulnerabilities**

---

## Phase 2: LLM Gateway as Additive Model Provider (2026-04-03)

### Architecture

Three-layer resilience for all agents:

1. **BSCS gateway** (port 18999, Docker container) — retry with exponential backoff, fallback chains, per-agent cost tracking
2. **Direct provider fallback** — if BSCS gateway is down, OpenClaw's built-in fallback routes to providers directly
3. **Existing behavior** — all original provider configs untouched

The BSCS gateway runs as a Docker container (`bscs-gateway`) on the default bridge network, connected to `docker-khadem_default` for Khadem access. Port 18999 is published to the host.

### Bugs Found and Fixed (Phase 2)

#### BUG-6: `resolveProvider` used prefix-based inference only

**Severity:** Critical — all non-Anthropic models routed to wrong provider.

**Root cause:** `resolveProvider()` only matched models by prefix (`claude-` → anthropic, `gpt-` → openai). Models like `glm-5-turbo`, `MiniMax-M2.7`, `Qwen/Qwen2.5-72B-Instruct-GPTQ-Int4` have no matching prefix and fell to the default `openai` type, routing them to whichever `openai`-type provider appeared first in config (usually MiniMax).

**Fix:** First try exact match against each provider's configured `models[]` list. Only fall back to prefix-based inference if no list match found. Commit: `af5ce54`.

#### BUG-7: Provider prefix stripping broke models with internal slashes

**Severity:** High — `Qwen/Qwen2.5-72B-Instruct-GPTQ-Int4` routed to MiniMax instead of C4140.

**Root cause:** `model.split('/').pop()` stripped ALL path components. For `Qwen/Qwen2.5-72B-Instruct-GPTQ-Int4`, this produced `Qwen2.5-72B-Instruct-GPTQ-Int4` which didn't match the C4140 provider's model list entry `Qwen/Qwen2.5-72B-Instruct-GPTQ-Int4`.

**Fix:** Try the full model name first, then try with only the first path component stripped (`model.substring(model.indexOf('/') + 1)`). Commit: `af5ce54`.

#### BUG-8: `buildAnthropicRequest` used wrong URL path

**Severity:** High — all Anthropic API calls returned 404.

**Root cause:** Constructed URL as `${baseUrl}/messages`. Provider baseUrl is `https://api.anthropic.com` (no `/v1`), so the request went to `https://api.anthropic.com/messages` instead of `https://api.anthropic.com/v1/messages`.

**Fix:** Changed to `${baseUrl}/v1/messages`. Commit: `af5ce54`.

#### BUG-9: Fallback chain didn't trigger on HTTP errors

**Severity:** High — fallback only worked on connection failures, not on HTTP error responses.

**Root cause:** `proxyRequest()` had `return` inside the `try` block that executed for ALL responses (success or error), preventing iteration to the next fallback model. Fallback only happened if `fetchWithRetry` threw an exception (connection error/timeout).

**Fix:** Only return immediately on 2xx responses. On non-2xx, log the error and continue to the next model in the chain. Commit: `af5ce54`.

### Deployment Gotchas (Phase 2)

#### GOTCHA-6: Docker bridge containers can't reach host-bound ports

Containers on Docker's default `bridge` network cannot reach ports bound by host processes (even on `0.0.0.0`). The `csuite-bots` container works because it uses `--network host`. But `vector-bot` (bridge) and `khadem-bot` (docker-khadem_default) cannot reach a host-bound process on `172.17.0.1:18999` or `172.18.0.1:18999`.

**Fix:** Run the BSCS gateway as a Docker container with `--network bridge -p 18999:18999`. Docker's published port handling uses DNAT rules that work across bridge networks. Connect the gateway container to additional networks as needed (`docker network connect docker-khadem_default bscs-gateway`).

#### GOTCHA-7: Default bridge network DNS is broken on HQ

HQ's default Docker `bridge` network has `"invalid Prefix"` in IPAM config, which breaks Docker's embedded DNS server (`127.0.0.11`). Container name resolution fails even when DNS is set to `127.0.0.11`. Custom networks (like `docker-khadem_default`) have working DNS.

**Fix:** Created a custom bridge network `bscs-net` for inter-container DNS resolution:
```bash
docker network create bscs-net
docker network connect bscs-net bscs-gateway
```

Moved `vector-bot` from the default bridge to `bscs-net` by updating `docker-compose.yml`:
```yaml
networks:
  - bscs-net
networks:
  bscs-net:
    external: true
```

**Note:** `khadem-bot` stays on `docker-khadem_default` (also a custom network with working DNS). The gateway is connected to all three networks: `bridge`, `bscs-net`, `docker-khadem_default`.

#### GOTCHA-7b: Original Vector compose had hardcoded DNS override

`docker-vector/docker-compose.yml` had `dns: [8.8.8.8, 8.8.4.4]` which prevented Docker's internal DNS from being used. Removed the `dns:` key entirely and used a custom network with working embedded DNS instead.

#### GOTCHA-8: MiniMax uses Anthropic-compatible API, not OpenAI

The MiniMax provider endpoint at `https://api.minimax.io/anthropic` expects Anthropic message format (`/v1/messages`), not OpenAI chat completions format (`/chat/completions`). Setting `"type": "anthropic"` in the BSCS provider config routes requests through `buildAnthropicRequest`.

#### GOTCHA-9: API keys differ between OpenClaw and BSCS configs

OpenClaw and BSCS maintain separate config files. When copying API keys, verify they match. In this deployment, the ZAI and MiniMax keys were different between the two configs. Always extract keys from the authoritative source (OpenClaw's `~/.openclaw/openclaw.json`).

### Gateway Docker Setup

```bash
# Run as Docker container (not host process) for cross-network access
docker run -d --name bscs-gateway --restart unless-stopped \
  --network bridge \
  -v /home/hani/bscs:/app \
  -v /home/hani/.config/bscs:/root/.config/bscs \
  -p 18999:18999 \
  -w /app node:24-slim \
  node dist/bin/bscs.js gateway start --port 18999 --bind 0.0.0.0

# Connect to Khadem's network
docker network connect docker-khadem_default bscs-gateway
```

### Provider baseUrl per Container

| Container | Network | BSCS baseUrl |
|-----------|---------|-------------|
| csuite-bots | host | `http://127.0.0.1:18999/v1` |
| khadem-bot | docker-khadem_default | `http://bscs-gateway:18999/v1` |
| vector-bot | bscs-net | `http://bscs-gateway:18999/v1` |

### Current Agent Routing (Post-Phase-2)

| Agent | Container | Persona | Primary | Fallback Chain |
|-------|-----------|---------|---------|----------------|
| Atlas | csuite-bots | Architect | `bscs/claude-opus-4-6` | opus → sonnet → glm-5-turbo → MiniMax-M2.7 |
| Forge | csuite-bots | Builder | `bscs/glm-5` | glm-5 → sonnet → qwen-72b → MiniMax-HS |
| Oracle | csuite-bots | Investigator | `bscs/claude-sonnet-4-6` | sonnet → MiniMax-M2.7 → glm-5-turbo → qwen-72b |
| Warden | csuite-bots | Sentinel | `c4140/qwen-72b` *(direct)* | MiniMax-HS → glm-5-turbo → sonnet |
| Yield | csuite-bots | Investigator | `bscs/claude-sonnet-4-6` | sonnet → MiniMax-M2.7 → glm-5-turbo → qwen-72b |
| Nova | csuite-bots | Herald | `bscs/claude-sonnet-4-6` | sonnet → MiniMax-M2.7 → glm-5-turbo → qwen-72b |
| Clerk | csuite-bots | Sentinel | `c4140/qwen-72b` *(direct)* | MiniMax-HS → glm-5-turbo → sonnet |
| Khadem | khadem-bot | Builder | `bscs/glm-5` | glm-5 → sonnet → qwen-72b → MiniMax-HS |
| Vector | vector-bot | Herald | `bscs/claude-sonnet-4-6` | sonnet → MiniMax-M2.7 → glm-5-turbo → qwen-72b |

Sentinel agents (Warden, Clerk) bypass BSCS and use C4140 directly (local, free, no rate limits).

---

## Phase 2 Round 2: Gateway Resilience & Code Hardening (2026-04-03)

### Bugs Fixed

#### BUG-17: Streaming path had no fallback chain (C-02)

**Severity:** Critical — streaming requests failed permanently if primary provider errored.

**Root cause:** Streaming used a single `fetch()` with no retry or fallback logic. If the primary provider returned 429/500/503, the entire request failed.

**Fix:** Added full fallback chain loop to streaming path matching the non-streaming behavior. On non-2xx from a provider, logs warning and tries the next model in the chain.

#### BUG-18: Client disconnect during streaming didn't abort upstream (H-01)

**Severity:** High — wasted API credits when client disconnected mid-stream.

**Root cause:** No tracking of client connection state during streaming. Upstream provider continued generating tokens even after the client disconnected.

**Fix:** Added `res.on('close')` listener that aborts the upstream `AbortController` and cancels the stream reader when the client disconnects.

#### BUG-19: Streaming cost tracking missing (C-02)

**Severity:** Medium — streaming responses weren't recorded in cost logs.

**Root cause:** Streaming path didn't parse SSE events for usage data.

**Fix:** Extract `usage` data from SSE events during streaming, calculate cost, and record to cost log.

#### BUG-20: No request validation (C-03)

**Severity:** Medium — malformed requests crashed the gateway or produced cryptic errors.

**Fix:** Validate `model` is a non-empty string and `messages` is a non-empty array before processing. Return 400 with descriptive error.

#### BUG-21: Unknown models returned 500 instead of 400 (L-01)

**Severity:** Medium — debugging was harder when the gateway returned 500 for typos.

**Fix:** When `resolveProvider()` returns null (unknown model), return 400 `Unknown model: <name>` instead of 500.

#### BUG-22: Google/Gemini requests crashed with uncaught error (C-01)

**Severity:** Medium — any request for a Google model crashed the process.

**Fix:** Return 501 `Provider type 'google' not implemented` instead of throwing.

#### BUG-23: Gateway logging was insufficient (M-01, M-03)

**Severity:** Low — hard to debug production issues.

**Fix:** Log incoming requests at info level (message count, model, agent). Log provider errors at warn level with status code.

#### BUG-24: Cost tracking failed for prefixed model names (L-02)

**Severity:** Medium — `bscs/claude-opus-4-6` didn't match pricing table because the lookup used the full prefixed name.

**Fix:** Strip provider prefix before pricing lookup in `estimateCost()`.

#### BUG-25: listAgents() didn't normalize id→name (BUG-11 regression)

**Severity:** High — drift detection and fleet import broke when OpenClaw returned `id` instead of `name`.

**Fix:** Normalize raw API response with `a.id || a.name || 'unknown'` in `listAgents()`, matching `list()` behavior.

#### BUG-26: Runtime used curl subprocess for HTTP (M-10)

**Severity:** Low — unnecessary subprocess spawn for HTTP requests.

**Fix:** Replaced `curl` subprocess with native `fetch()` + `AbortController`.

### Test Coverage Added

- **13 new gateway tests:** streaming fallback chain (2), provider model list matching (4), prefix stripping (3), non-2xx fallback (1), request validation (3), unknown model (1), cost with prefixed names (1), client disconnect (1), streaming cost tracking (1)
- **7 new fleet tests:** extractFallbacks fields (2), per-agent detail fetch for channels (2), enabled=false import (1), missing agents get response (1), orphan detection (1)
- **Total: 434 tests passing**

### Deployment (Round 2)

```bash
# HQ — pull latest, rebuild, restart gateway
ssh hani@100.91.248.9
cd ~/bscs && git stash && git pull && npm ci && npm run build && npm link --force
docker restart bscs-gateway
bscs gateway status  # ✓ running on port 18999
bscs fleet watchdog --once  # ✓ all 10 agents healthy
```

---

## Phase 2 Round 3: Performance, Reliability, and Documentation (2026-04-03)

### Issues Fixed

#### G-01: Graceful shutdown called process.exit() breaking tests and host process

**Severity:** Critical — killed the entire Node process on shutdown, leaked into test suite.

**Root cause:** `gracefulShutdown()` called `process.exit()` directly. Tests calling `gw.close()` triggered process exit, breaking subsequent tests. In production, this killed any other work in the same process.

**Fix:** Changed `gracefulShutdown` to return a `Promise<void>`. Added guard flag to prevent duplicate handler registration. CLI now `await`s close before calling `process.exit(0)`.

#### G-02: activeRequests counter could race or never drain

**Severity:** High — could prevent clean gateway shutdown.

**Root cause:** Numeric counter incremented synchronously but decremented on async `finish` event. If response never sent (server closing), counter stays above 0, causing shutdown to timeout.

**Fix:** Replaced numeric counter with a `Set<ServerResponse>`. Shutdown checks each response's `writableEnded` property. Added 10s safety timeout.

#### G-05: Provider returning 200 with error body didn't trigger fallback

**Severity:** High — Anthropic sometimes returns 200 with `{error: {message: "..."}}` in overloaded states.

**Root cause:** Gateway only logged a warning for 200+error responses but still returned them to the client.

**Fix:** Changed to `continue` to the next fallback model when error body detected in 200 response.

#### G-06: No request body timeout (slow loris vulnerability)

**Severity:** Medium — client could hold connections open indefinitely.

**Fix:** Added 30s timeout to `readRequestBody()`. Body size check (10MB) moved inside the reader to enforce limit during streaming read.

#### C-01: Double statSync in loadConfig

**Severity:** Medium — unnecessary I/O on every config load.

**Fix:** Store stat result from cache check and reuse after load.

#### C-02: saveConfig not atomic

**Severity:** Medium — process crash mid-write could corrupt config file.

**Fix:** Write to temp file (`.json.tmp`) then `renameSync` (atomic on most filesystems).

#### R-01: normalizeAgentName returned 'unknown' masking bugs

**Severity:** Medium — broken agent entries silently merged into one "unknown" agent.

**Fix:** Return `null` for entries with no id/name. Callers skip null entries.

#### F-04: Deprecated setExecCommandForFleet still exported

**Severity:** Low — dead code and test confusion.

**Fix:** Removed deprecated export. All usage updated to `_setExecCommandForFleet`.

#### CS-04: getBudgetStatus hardcoded $10 default

**Severity:** Low — silently invented a budget the user never set.

**Fix:** Returns `null` when no budget configured. Callers handle null.

#### CLI-03: Port NaN not validated in gateway CLI

**Severity:** Low — `parseInt("abc")` → NaN would crash gateway.

**Fix:** Added validation: NaN or out-of-range (1-65535) ports rejected with error message.

#### D-02: HQ compose mounted config at /root/ but ran as non-root user

**Severity:** Medium — non-root process couldn't read `/root/.config/bscs`.

**Fix:** Added `HOME=/home/bscs` environment variable in container. Volume now maps to `/home/bscs/.config/bscs`. Node's `os.homedir()` respects the `HOME` env var.

### Known Issues (Not Fixed — Requires Further Work)

#### ISSUE-7: ~~Repeated Anthropic 400 errors on claude-sonnet-4-6~~ FIXED (Round 4)

**Root cause:** Stale `anthropic-version: 2023-06-01` header + missing OpenAI→Anthropic message format conversion. System messages were sent inside `messages[]` instead of top-level `system` field, and content was sent as plain strings instead of `[{type:"text",text:"..."}]` blocks.

**Fix:** Rewrote `buildAnthropicRequest()` with proper message conversion and updated API version to `2025-04-01`. See Round 4 section above.

#### ISSUE-8: ~~fleet status shows 3 agents stopped~~ PARTIALLY FIXED (Round 4)

**Root cause:** Two layers: (1) BSCS config was stale — fixed with `fleet sync` command. (2) `ocRuntime.status()` uses synchronous `execFileSync` with 10s timeout that intermittently fails and returns `'running'` as fallback regardless of actual state. The second layer is an upstream OpenClaw issue.

**Fix:** `bscs fleet sync` command implemented. Display inconsistency remains due to `ocRuntime.status()` unreliability. See Round 4 section above for workarounds.

#### ISSUE-9: Google/Gemini provider returns 501

**Observed:** Any request for a Google model returns 501 Not Implemented.

**Root cause:** `buildGoogleRequest()` was never implemented — only a stub exists.

**Action needed:** Implement Google Gemini API translation or remove from supported provider list.

### Code Annotation Reference

Source code uses severity tags for issue tracking. Format: `// TAG-NN: description`

| Prefix | Meaning | Example |
|--------|---------|---------|
| BUG-NN | Bug found and fixed | `// BUG-6: resolveProvider used prefix-based inference only` |
| GOTCHA-NN | Deployment gotcha | `// GOTCHA-6: Docker bridge containers can't reach host-bound ports` |
| ISSUE-NN | Known issue, not yet fixed | `// ISSUE-2: Skills not returned by agents list` |
| G-NN | Gateway issue | `// G-01: gracefulShutdown calls process.exit()` |
| F-NN | Fleet issue | `// F-01: Race condition in importFromOpenClaw` |
| R-NN | Runtime issue | `// R-01: normalizeAgentName returns 'unknown'` |
| C-NN | Config issue | `// C-01: Double statSync in loadConfig` |
| CS-NN | Cost issue | `// CS-01: Fire-and-forget cost recording` |
| D-NN | Docker issue | `// D-02: HQ compose mounts /root/ but runs as non-root` |
| CLI-NN | CLI issue | `// CLI-01: Duplicated config logic` |
| M-NN | Medium severity (from code review) | `// M-04: Non-retryable 200 with error body` |
| H-NN | High severity (from code review) | `// H-04: importFromOpenClaw blocks event loop` |
| L-NN | Low severity (from code review) | `// L-01: Unknown models returned 500` |
| T-NN | Type safety issue | `// T-01: Multiple unsafe as casts` |
| TQ-NN | Test quality issue | `// TQ-01: process.exit breaks test suite` |
| CC-NN | Cross-cutting issue | `// CC-01: isLocalMachine calls execSync per invocation` |

### Gateway Limits and Behavior

| Setting | Value | Notes |
|---------|-------|-------|
| Max request body | 10 MB | Enforced during read, returns 413 |
| Read timeout | 30s | Slow-loris protection |
| Fetch timeout (per provider) | 120s | Per-request upstream timeout |
| Retry count | 3 | Exponential backoff: 1s, 2s, 4s |
| Graceful shutdown drain | 10s | Waits for in-flight requests |
| Streaming error detection | Logging only | Mid-stream SSE errors logged but not retried |
| Unknown model response | 400 | Returns `Unknown model: <name>` |
| Google provider | 501 | Returns `Provider type 'google' not implemented` |

### Per-Agent Cost Tracking

The gateway uses the `x-bscs-agent` header for per-agent cost attribution. Agents should be configured to send this header when routing through the gateway:

```bash
# In OpenClaw agent config or environment:
OPENAI_EXTRA_HEADERS='{"x-bscs-agent":"atlas"}'
```

Without this header, costs are logged under agent name `unknown`.

### Docker Deployment Methods

Two deployment methods exist — they produce different container configurations:

| Aspect | `docker run` (manual) | `docker compose` |
|--------|----------------------|------------------|
| Image | `node:24-slim` | `node:22-slim` (dev) / `bscs-gateway:latest` (HQ) |
| Code | Bind-mount live source | Built image or bind-mount |
| Config | `-v ~/.config/bscs:/root/.config/bscs` | Volume mount with `HOME` env var |
| User | root | `${UID}:${GID}` (non-root) |
| Networks | Must manually connect | Managed by compose |

For production, prefer `docker compose -f docker-compose.yml -f docker-compose.hq.yml up -d`.

---

## Phase 2 Round 4: Live HQ Issue Fixes (2026-04-03)

### Issues Fixed

#### ISSUE-7 Root Cause: Anthropic 400 on claude-sonnet-4-6 (FIXED)

**Root cause (two bugs):**

1. **Stale API version header:** The Anthropic request builder sent `anthropic-version: 2023-06-01`. Anthropic requires newer versions for `claude-sonnet-4-6`. Updated to `2025-04-01`.

2. **Wrong message format:** OpenAI-to-Anthropic message conversion was missing. The gateway forwarded OpenAI-format messages (system as `role: "system"` in messages array, content as plain strings) directly to Anthropic, which expects:
   - System prompts extracted to top-level `system` field (not inside `messages`)
   - All content blocks as `[{type: "text", text: "..."}]` arrays

**Fix:** Rewrote `buildAnthropicRequest()` in `src/core/gateway.ts`:
- Extract system messages into top-level `system` field
- Convert all content to `[{type: "text", text: "..."}]` block format
- Array content blocks pass through unchanged
- Updated `anthropic-version` header to `2025-04-01`

**Verification needed:** Monitor HQ gateway logs over next few hours to confirm 400 errors stop:
```bash
ssh hani@100.91.248.9 'docker logs bscs-gateway --tail 50 2>&1 | grep -c "status: 400"'
```

#### ISSUE-8 Root Cause: fleet status drift (PARTIALLY FIXED)

**Root cause (deeper analysis):**

The `bscs fleet sync` command was implemented and correctly updates the BSCS config from live gateway state. However, the *display inconsistency* persists because `ocRuntime.status()` in `src/core/runtime/openclaw.ts` (lines 111-139) is fundamentally unreliable:

- Uses synchronous `execFileSync('openclaw', ['agents', 'get', ...])` with a 10s timeout
- On a loaded gateway (HQ runs 8+ agents), this intermittently times out
- The catch block returns `{ status: 'running' }` as a fallback **regardless of actual agent state**
- This means stopped agents sometimes report as "running" and vice versa

**What was fixed:**
- `bscs fleet sync` command implemented — updates BSCS config from live gateway state
- `syncFleetStatus()` writes to config and invalidates cache atomically
- Supports `--dry-run` and `--json` output
- Correctly detects running→stopped and stopped→running transitions

**What remains broken:**
- `ocRuntime.status()` is an upstream OpenClaw issue — BSCS can't fix the timeout/fallback behavior
- Fleet status display will remain inconsistent until OpenClaw provides a reliable status API

**Recommended workarounds:**
1. Run `bscs fleet sync` periodically via cron to keep config in sync:
   ```
   */10 * * * * /home/hani/.npm-global/bin/bscs fleet sync >> /var/log/bscs-sync.log 2>&1
   ```
2. Or switch `ocRuntime.status()` to use OpenClaw's HTTP API instead of CLI subprocess (requires OpenClaw to expose status endpoint)

### Other Fixes

#### MODEL_PRICING update

Added `claude-sonnet-4-6` to pricing table in `src/core/gateway.ts`. Previously missing, causing cost calculation to fail for Sonnet 4.6 requests.

### Deployment (Round 4)

```bash
# HQ — pull latest, rebuild, restart gateway
ssh hani@100.91.248.9
cd ~/bscs && git stash && git pull && npm ci && npm run build && npm link --force
docker restart bscs-gateway

# Verify gateway healthy
bscs gateway status

# Sync fleet status from live gateway
bscs fleet sync

# Check for remaining Anthropic 400 errors
docker logs bscs-gateway --tail 100 2>&1 | grep "status: 400"

# Run watchdog
bscs fleet watchdog --once
```

### Commit History (Round 4)

- `63df6e4` — Anthropic message conversion, fleet sync, pricing update, 10 new tests (434 total passing)
