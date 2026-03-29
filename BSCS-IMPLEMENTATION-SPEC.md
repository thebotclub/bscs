# BSCS Implementation Specification

**Version:** 1.0.0 — Implementation Ready
**Date:** 2026-03-29
**Purpose:** A developer opens this file and starts coding. Every decision is made.

---

## Part 1: Architecture Decision Records (ADRs)

### ADR-001: Language Choice

- **Decision:** TypeScript rewrite (Option A). All bash logic ported to TS.
- **Rationale:** OpenClaw is Node-based, npm distribution is native, TypeScript gives type safety and testability. The bash CLI has ~2,000 lines of logic across 12 files — porting is 2-3 weeks, not months. Maintaining two languages (Option B/C) creates permanent tech debt that costs more than the one-time port.
- **Alternatives rejected:** Option B (bash stays, TS wrapper) — two languages forever. Option C (bash + TS for new features) — same two-language problem, plus inconsistent UX between old and new commands.

### ADR-002: CLI Framework

- **Decision:** `commander` (npm: commander)
- **Rationale:** Mature, excellent TypeScript support, built-in subcommand model matches our noun-verb CLI structure. 50M weekly downloads, battle-tested. Lighter than oclif, more structured than yargs.
- **Alternatives rejected:** `oclif` (too heavy, plugin system we don't need), `yargs` (less structured for deep subcommands), `citty` (too new, small ecosystem).

### ADR-003: Docker Integration

- **Decision:** `dockerode` (npm: dockerode) — programmatic Docker API via Unix socket.
- **Rationale:** Direct Docker Engine API access. No shelling out to `docker` CLI. Supports all operations we need: create, start, stop, inspect, logs, exec, stats. Handles streaming (logs, exec) natively.
- **Alternatives rejected:** Shelling out to `docker` CLI (fragile parsing, no streaming), `docker-compose` library (we generate our own compose, don't need a library for it).

### ADR-004: Dashboard Technology

- **Decision:** Fastify (API) + Preact with HTM (UI). No build step for the SPA — HTM provides JSX-like syntax via tagged template literals.
- **Rationale:** Lightweight stack. Fastify is the fastest Node.js HTTP framework. Preact+HTM means no webpack/vite/esbuild build pipeline for the dashboard UI — the JS files are served directly. Total dashboard dependency footprint: ~200KB.
- **Alternatives rejected:** Express (slower), React (needs build toolchain), Svelte (needs compiler), plain HTML (too limited for live updates).

### ADR-005: Config Format

- **Decision:** JSON with comments (JSONC) at `~/.config/bscs/config.json`. Parsed with `jsonc-parser`.
- **Rationale:** Machine-readable, VS Code native support, no YAML type coercion bugs (`yes` becoming `true`, `3.10` becoming `3.1`). XDG-compliant location.
- **Alternatives rejected:** YAML (type coercion bugs, significant whitespace), TOML (less familiar, poor tooling), dotenv (too flat for nested config).

### ADR-006: Distribution Method

- **Decision:** npm primary (`npm install -g @botsquad/bscs`). Secondary: standalone binary via `bun build --compile` distributed on GitHub Releases.
- **Rationale:** npm is native to the OpenClaw ecosystem. `bun build --compile` produces a single binary for machines without Node.js. No need for Homebrew tap until v1.1+.
- **Alternatives rejected:** Homebrew-first (smaller audience), Docker-only (need host CLI for fleet management), `pkg` (deprecated, bun compile is better).

### ADR-007: Testing Strategy

- **Decision:** Vitest for unit + integration tests. No separate E2E framework — integration tests with real Docker constitute E2E.
- **Rationale:** Vitest is fast, TypeScript-native, Jest-compatible API. Mocking Docker via `dockerode` mock is straightforward. Real Docker tests run in CI via GitHub Actions (Docker is available).
- **Alternatives rejected:** Jest (slower, requires ts-jest config), Mocha (more boilerplate), Playwright (overkill for CLI + simple dashboard).

### ADR-008: Tribunal Bundling

- **Decision:** Pre-installed in Docker golden image via `pip install tribunal`. For host agents: installed via `pip` in a managed venv at `/opt/tribunal/`.
- **Rationale:** Zero-config for coding agents. Tribunal is infrastructure, not optional. Version pinned in Dockerfile build arg for fleet consistency. Host-based agents get a clean venv to avoid polluting system Python.
- **Alternatives rejected:** Runtime install on first use (slow, unreliable), npm wrapper (Tribunal is Python), Docker sidecar (unnecessary complexity for a library).

### ADR-009: Template Engine

- **Decision:** Handlebars (npm: handlebars)
- **Rationale:** Logic-less templates, familiar syntax, used for generating agent configs (settings.yaml, .claude/settings.json, docker-compose fragments). Simple enough for the job; no need for a full template language.
- **Alternatives rejected:** EJS (too much logic in templates), Mustache (no partials), plain string interpolation (unmaintainable for multi-file templates).

### ADR-010: Logging

- **Decision:** `pino` for structured JSON logging. Human-readable output via `pino-pretty` in development.
- **Rationale:** Fastest Node.js logger. Structured JSON output means logs are machine-parseable (important for fleet-agent and sentinel log aggregation). `pino-pretty` makes it readable for humans during development.
- **Alternatives rejected:** `winston` (slower, more config), `console.log` (no structure), `bunyan` (unmaintained).

### ADR-011: Schema Validation

- **Decision:** `zod` for all config validation and type generation.
- **Rationale:** TypeScript-first, runtime validation with static type inference. Define the schema once, get both runtime validation and TypeScript types. Used for config files, CLI input validation, API request/response validation.
- **Alternatives rejected:** `joi` (no TS type inference), `ajv` + JSON Schema (verbose, separate type definitions), `io-ts` (steeper learning curve).

---

## Part 2: Repository Structure

```
bscs/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                           # Lint + typecheck + test on PR
│   │   ├── release.yml                      # semantic-release → npm + GitHub Release
│   │   └── docker.yml                       # Multi-arch Docker image build + push
│   └── ISSUE_TEMPLATE/
│       └── bug_report.md                    # Bug report template
├── bin/
│   └── bscs.ts                              # CLI entry point (#!/usr/bin/env tsx)
├── src/
│   ├── cli/
│   │   ├── index.ts                         # Root commander program, global flags (--json, --quiet, --no-color)
│   │   ├── agent/
│   │   │   ├── create.ts                    # bscs agent create — container + workspace + config
│   │   │   ├── destroy.ts                   # bscs agent destroy — stop + remove container + optional volume cleanup
│   │   │   ├── status.ts                    # bscs agent status — single or all agents
│   │   │   ├── start.ts                     # bscs agent start — start stopped container
│   │   │   ├── stop.ts                      # bscs agent stop — graceful stop
│   │   │   ├── restart.ts                   # bscs agent restart — stop + start
│   │   │   ├── logs.ts                      # bscs agent logs — tail container logs
│   │   │   ├── shell.ts                     # bscs agent shell — docker exec -it bash
│   │   │   ├── update.ts                    # bscs agent update — pull new image, recreate
│   │   │   ├── clone.ts                     # bscs agent clone — duplicate agent config to new name
│   │   │   ├── reconfigure.ts               # bscs agent reconfigure — re-apply config without recreate
│   │   │   └── pair.ts                      # bscs agent pair — generate pairing QR/code
│   │   ├── fleet/
│   │   │   ├── init.ts                      # bscs fleet init — first-run setup wizard
│   │   │   ├── status.ts                    # bscs fleet status — fleet-wide overview
│   │   │   ├── reconcile.ts                 # bscs fleet reconcile — ensure running matches config
│   │   │   ├── backup.ts                    # bscs fleet backup — tar workspaces + configs
│   │   │   ├── restore.ts                   # bscs fleet restore — untar + recreate
│   │   │   ├── watchdog.ts                  # bscs fleet watchdog — health check loop
│   │   │   ├── import.ts                    # bscs fleet import — from legacy fleet.sh
│   │   │   ├── install-crons.ts             # bscs fleet install-crons — LaunchAgent/systemd/cron
│   │   │   └── upgrade.ts                   # bscs fleet upgrade — rolling image update
│   │   ├── machine/
│   │   │   ├── bootstrap.ts                 # bscs machine bootstrap — 23-step machine setup via SSH
│   │   │   ├── harden.ts                    # bscs machine harden — security hardening
│   │   │   └── status.ts                    # bscs machine status — machine health info
│   │   ├── cost/
│   │   │   ├── report.ts                    # bscs cost report — spend breakdown
│   │   │   └── budget.ts                    # bscs cost budget — set/check budget
│   │   ├── security/
│   │   │   ├── audit.ts                     # bscs security audit — run security checks
│   │   │   └── baseline.ts                  # bscs security baseline — check compliance
│   │   ├── tribunal/
│   │   │   ├── status.ts                    # bscs tribunal status — tribunal health per agent
│   │   │   ├── sync.ts                      # bscs tribunal sync — vault rule sync
│   │   │   ├── enable.ts                    # bscs tribunal enable — activate on agent
│   │   │   ├── disable.ts                   # bscs tribunal disable — deactivate (preserves config)
│   │   │   ├── update.ts                    # bscs tribunal update — pip upgrade in container
│   │   │   ├── report.ts                    # bscs tribunal report — quality metrics
│   │   │   └── vault.ts                     # bscs tribunal vault — connect/status/push
│   │   ├── config/
│   │   │   ├── show.ts                      # bscs config show — dump current config
│   │   │   ├── set.ts                       # bscs config set — set a config key
│   │   │   ├── path.ts                      # bscs config path — print config location
│   │   │   └── models/
│   │   │       ├── providers.ts             # bscs config models providers — add/remove/test/status
│   │   │       ├── defaults.ts              # bscs config models defaults — show/set/reset
│   │   │       ├── fallbacks.ts             # bscs config models fallbacks — show/set/test
│   │   │       ├── routing.ts               # bscs config models routing — rules management
│   │   │       ├── assign.ts                # bscs config models assign/unassign
│   │   │       ├── list.ts                  # bscs config models list — all available models
│   │   │       └── costs.ts                 # bscs config models costs — per-model spend
│   │   ├── secrets/
│   │   │   ├── list.ts                      # bscs secrets list — all managed secrets
│   │   │   ├── sync.ts                      # bscs secrets sync — 1Password → fleet
│   │   │   ├── check.ts                     # bscs secrets check — validate all
│   │   │   ├── rotate.ts                    # bscs secrets rotate — key rotation flow
│   │   │   └── audit.ts                     # bscs secrets audit — access trail
│   │   ├── dashboard/
│   │   │   ├── start.ts                     # bscs dashboard — start web UI
│   │   │   ├── stop.ts                      # bscs dashboard stop
│   │   │   └── status.ts                    # bscs dashboard status
│   │   ├── mcp.ts                           # bscs mcp serve — start MCP tool server
│   │   ├── doctor.ts                        # bscs doctor — environment health check
│   │   └── version.ts                       # bscs version — print version + ASCII art
│   ├── core/
│   │   ├── docker.ts                        # Docker container lifecycle via dockerode
│   │   ├── config.ts                        # Agent config generation + validation (zod)
│   │   ├── ports.ts                         # Port allocation/release (file-based lock)
│   │   ├── naming.ts                        # Agent naming conventions + validation
│   │   ├── health.ts                        # Health check logic (container + machine)
│   │   ├── secrets.ts                       # Secret resolution (1Password op:// refs)
│   │   ├── models.ts                        # Model/provider management + fallback chains
│   │   ├── templates.ts                     # Workspace template rendering (Handlebars)
│   │   ├── tribunal.ts                      # Tribunal config generation + profile selection
│   │   ├── claude-code.ts                   # Claude Code settings.json + mcp.json generation
│   │   └── ssh.ts                           # SSH command execution on remote machines
│   ├── plugins/
│   │   ├── loader.ts                        # Plugin discovery + lazy loading
│   │   ├── plugin.ts                        # Plugin interface definition
│   │   ├── agentguard.ts                    # AgentGuard policy enforcement plugin
│   │   ├── onepassword.ts                   # 1Password CLI integration plugin
│   │   └── tailscale.ts                     # Tailscale network discovery plugin
│   ├── dashboard/
│   │   ├── server.ts                        # Fastify HTTP server + static file serving
│   │   ├── websocket.ts                     # WebSocket push for live updates
│   │   └── routes/
│   │       ├── fleet.ts                     # GET /api/fleet — fleet overview
│   │       ├── agents.ts                    # GET/POST/DELETE /api/agents
│   │       ├── models.ts                    # GET /api/models — providers, routing stats
│   │       ├── costs.ts                     # GET /api/costs — spend data
│   │       ├── secrets.ts                   # GET /api/secrets — secret health (no values!)
│   │       └── tribunal.ts                  # GET /api/tribunal — quality metrics
│   ├── dashboard-ui/
│   │   ├── index.html                       # SPA shell
│   │   ├── app.js                           # HTM + Preact root app + router
│   │   ├── pages/
│   │   │   ├── home.js                      # Fleet overview page
│   │   │   ├── agents.js                    # Agent list + detail page
│   │   │   ├── models.js                    # Model/provider management page
│   │   │   ├── costs.js                     # Cost breakdown + charts page
│   │   │   └── security.js                  # Security + Tribunal quality page
│   │   └── components/
│   │       ├── agent-card.js                # Agent status card component
│   │       ├── metric-card.js               # Numeric metric card
│   │       ├── status-badge.js              # Colored status indicator
│   │       └── chart.js                     # Cost/resource chart (Chart.js wrapper)
│   ├── mcp/
│   │   ├── server.ts                        # MCP server setup + tool registration
│   │   └── tools/
│   │       ├── fleet-status.ts              # fleet_status MCP tool
│   │       ├── agent-create.ts              # agent_create MCP tool
│   │       ├── agent-destroy.ts             # agent_destroy MCP tool
│   │       ├── agent-logs.ts                # agent_logs MCP tool
│   │       ├── agent-restart.ts             # agent_restart MCP tool
│   │       ├── fleet-reconcile.ts           # fleet_reconcile MCP tool
│   │       ├── cost-report.ts               # cost_report MCP tool
│   │       └── security-audit.ts            # security_audit MCP tool
│   ├── sentinels/
│   │   ├── cost-sentinel.ts                 # Daily cost monitoring + budget alerts
│   │   └── security-sentinel.ts             # Weekly security assessment
│   └── util/
│       ├── logger.ts                        # pino logger setup
│       ├── output.ts                        # Output formatting (human table / JSON / quiet)
│       └── types.ts                         # Shared TypeScript types + zod schemas
├── templates/
│   ├── base/
│   │   ├── AGENTS.md.hbs                    # Base agent instructions template
│   │   ├── SOUL.md.hbs                      # Base personality template
│   │   └── USER.md.hbs                      # User context template
│   ├── atlas/
│   │   ├── AGENTS.md.hbs                    # Atlas-specific (brain/planner)
│   │   └── SOUL.md.hbs                      # Atlas personality
│   ├── vault/
│   │   ├── AGENTS.md.hbs                    # Vault-specific (security)
│   │   └── SOUL.md.hbs                      # Vault personality
│   ├── cody/
│   │   ├── AGENTS.md.hbs                    # Cody-specific (coding assistant)
│   │   └── SOUL.md.hbs                      # Cody personality
│   ├── coding/
│   │   ├── AGENTS.md.hbs                    # Coding agent with Tribunal instructions
│   │   ├── SOUL.md.hbs                      # Coding-focused personality
│   │   └── .tribunal/
│   │       └── config.json                  # Full Tribunal profile
│   ├── review/
│   │   ├── AGENTS.md.hbs                    # Review agent template
│   │   └── .tribunal/
│   │       └── config.json                  # Review-only Tribunal profile
│   ├── custom/
│   │   ├── AGENTS.md.hbs                    # Minimal custom template
│   │   └── SOUL.md.hbs                      # Minimal personality
│   └── tribunal-profiles/
│       ├── full.json                        # All hooks, TDD, gates, Endless Mode
│       ├── review.json                      # Review hooks only
│       ├── light.json                       # file_checker + audit_logger only
│       └── none.json                        # Tribunal installed but inactive
├── configs/
│   ├── launchagents/
│   │   ├── com.botsquad.bscs.watchdog.plist # macOS LaunchAgent for watchdog
│   │   ├── com.botsquad.bscs.secrets.plist  # macOS LaunchAgent for secret sync
│   │   └── com.botsquad.bscs.dashboard.plist# macOS LaunchAgent for dashboard
│   ├── systemd/
│   │   ├── bscs-watchdog.service            # Linux systemd unit for watchdog
│   │   ├── bscs-secrets.service             # Linux systemd unit for secret sync
│   │   └── bscs-dashboard.service           # Linux systemd unit for dashboard
│   └── firewall/
│       ├── pf.conf.hbs                      # macOS pf firewall rules template
│       └── ufw-rules.hbs                    # Linux ufw rules template
├── skills/
│   ├── fleet-agent/
│   │   └── SKILL.md                         # Fleet agent skill (inbox/outbox protocol)
│   ├── fleet-mcp-server/
│   │   └── SKILL.md                         # MCP server skill for agents
│   ├── security-setup/
│   │   └── SKILL.md                         # Security audit skill
│   ├── cost-tracker/
│   │   └── SKILL.md                         # Cost tracking skill
│   └── rbac/
│       └── SKILL.md                         # Authorization control skill
├── workflows/
│   ├── fleet-commander.yml                  # Natural language fleet control
│   ├── cost-sentinel.yml                    # Cost monitoring workflow
│   └── security-sentinel.yml               # Security monitoring workflow
├── docs/
│   ├── getting-started.md                   # Quickstart tutorial
│   ├── architecture.md                      # System architecture + diagrams
│   ├── machine-setup-macos.md               # macOS machine setup guide
│   ├── machine-setup-linux.md               # Linux machine setup guide
│   ├── security-baseline.md                 # Security hardening reference
│   ├── dashboard.md                         # Dashboard setup + usage
│   ├── model-management.md                  # Model/provider guide
│   ├── secret-management.md                 # Secrets + 1Password guide
│   ├── tribunal-integration.md              # Tribunal integration guide
│   ├── tribunal-profiles.md                 # Tribunal profile reference
│   ├── code-quality.md                      # Fleet code quality guide
│   ├── upgrading.md                         # Migration from fleet.sh
│   └── integrations/
│       ├── agentguard.md                    # AgentGuard setup
│       ├── onepassword.md                   # 1Password setup
│       └── litellm.md                       # LiteLLM proxy setup
├── test/
│   ├── unit/
│   │   ├── core/
│   │   │   ├── docker.test.ts               # Docker module tests (mocked dockerode)
│   │   │   ├── config.test.ts               # Config generation tests
│   │   │   ├── ports.test.ts                # Port allocation tests
│   │   │   ├── naming.test.ts               # Naming convention tests
│   │   │   ├── health.test.ts               # Health check tests
│   │   │   ├── models.test.ts               # Model management tests
│   │   │   ├── secrets.test.ts              # Secret resolution tests (mocked op)
│   │   │   ├── templates.test.ts            # Template rendering tests
│   │   │   ├── tribunal.test.ts             # Tribunal config tests
│   │   │   └── claude-code.test.ts          # Claude Code config tests
│   │   └── util/
│   │       └── output.test.ts               # Output formatting tests
│   ├── integration/
│   │   ├── agent-lifecycle.test.ts          # Create/start/stop/destroy with real Docker
│   │   ├── fleet-reconcile.test.ts          # Reconcile with real Docker
│   │   └── dashboard-api.test.ts            # Dashboard API endpoint tests
│   └── fixtures/
│       ├── config.json                      # Sample BSCS config for tests
│       ├── agent-config.json                # Sample agent config
│       └── docker-inspect.json              # Mock Docker inspect output
├── Dockerfile                               # Golden fleet image (multi-stage)
├── docker-compose.yml                       # Default compose for single-machine setup
├── package.json                             # @botsquad/bscs
├── tsconfig.json                            # TypeScript config
├── vitest.config.ts                         # Vitest config
├── .eslintrc.json                           # ESLint config
├── .prettierrc                              # Prettier config
├── .commitlintrc.json                       # Conventional commits config
├── .releaserc.json                          # semantic-release config
├── LICENSE                                  # Apache-2.0
└── README.md                                # Project README
```

---

## Part 3: File-by-File Migration Map

### From `koshaji/openclaw-fleet`

| Source File | Disposition | Destination / Notes |
|---|---|---|
| `fleet.sh` | **REWRITE** | Logic distributed across `src/cli/agent/*` and `src/cli/fleet/*`. Command parsing → commander. Each bash function → TS function. |
| `lib/docker.sh` | **REWRITE** | → `src/core/docker.ts`. Shell-outs to `docker` CLI replaced with `dockerode` API calls. |
| `lib/config.sh` | **REWRITE** | → `src/core/config.ts`. Bash string interpolation → Handlebars templates + zod validation. |
| `lib/health.sh` | **REWRITE** | → `src/core/health.ts`. `curl` health checks → `fetch()` + dockerode health status. |
| `lib/secrets.sh` | **REWRITE** | → `src/core/secrets.ts`. `op read` calls preserved but wrapped in async TS. Added key lifecycle. |
| `lib/agentguard.sh` | **REWRITE** | → `src/plugins/agentguard.ts`. Becomes a lazy-loaded plugin. |
| `lib/ports.sh` | **REWRITE** | → `src/core/ports.ts`. Port file locking → same approach in TS (atomic file writes). |
| `lib/models.sh` | **REWRITE** | → `src/core/models.ts`. Massively extended with provider management, fallbacks, routing. |
| `lib/maintain.sh` | **MERGE** | → Logic split into `src/cli/fleet/reconcile.ts` (reconcile) and `src/cli/fleet/watchdog.ts` (watchdog). |
| `lib/doctor.sh` | **REWRITE** | → `src/cli/doctor.ts`. Same checks, TS implementation. |
| `lib/naming.sh` | **REWRITE** | → `src/core/naming.ts`. Simple port — naming rules are just string validation. |
| `lib/common.sh` | **MERGE** | → `src/util/logger.ts` (logging), `src/util/output.ts` (colors/formatting). Bash color codes → chalk. |

### From `thebotclub/fleet-bootstrap`

| Source File | Disposition | Destination / Notes |
|---|---|---|
| `bootstrap.sh` | **REWRITE** | → `src/cli/machine/bootstrap.ts`. 23 steps become TS functions executed via SSH. Same logic, typed. |
| `generate-configs.py` | **REWRITE** | → `src/core/templates.ts`. Python Jinja2 → TypeScript Handlebars. Same template concept. |
| `Dockerfile.fleet` | **KEEP** | → `Dockerfile`. Renamed, updated to multi-stage (build bscs + install Tribunal + Claude Code). |
| `docker-compose-atlas.yml` | **MERGE** | → `docker-compose.yml` (single file with Docker profiles) + generated per-agent compose via `src/core/docker.ts`. |
| `docker-compose-vault.yml` | **MERGE** | Same as above. |
| `docker-compose-cody.yml` | **MERGE** | Same as above. |
| `sync-keys.sh` | **REWRITE** | → `src/core/secrets.ts` + `src/cli/secrets/sync.ts`. Bash cron → TS command + LaunchAgent plist. |
| `update-keys.sh` | **MERGE** | → Merged into `src/core/secrets.ts` (key update logic is part of sync). |
| `workspace-templates/atlas/` | **KEEP** | → `templates/atlas/`. Converted to Handlebars (.hbs) templates. |
| `workspace-templates/vault/` | **KEEP** | → `templates/vault/`. Same. |
| `workspace-templates/cody/` | **KEEP** | → `templates/cody/`. Same. |
| `workspace-templates/base/` | **KEEP** | → `templates/base/`. Same. |
| `FLEET-ROUTINE.md` | **REWRITE** | → `configs/launchagents/` + `configs/systemd/`. Cron definitions become installable service configs. |
| `machine-setup-macos.md` | **KEEP** | → `docs/machine-setup-macos.md`. |
| `machine-setup-linux.md` | **KEEP** | → `docs/machine-setup-linux.md`. |

### From `koshaji/openclaw-config`

| Source File | Disposition | Destination / Notes |
|---|---|---|
| `skills/fleet-agent/` | **KEEP** | → `skills/fleet-agent/`. Core fleet skill, no changes. |
| `skills/fleet-mcp-server/` | **KEEP** | → `skills/fleet-mcp-server/`. Core fleet skill. |
| `skills/security-setup/` | **KEEP** | → `skills/security-setup/`. |
| `skills/cost-tracker/` | **KEEP** | → `skills/cost-tracker/`. |
| `skills/rbac/` | **KEEP** | → `skills/rbac/`. |
| `skills/asana/` | **DROP** | Third-party integration — stays in openclaw-config. Not fleet management. |
| `skills/fathom/` | **DROP** | Same. |
| `skills/other-third-party/*` | **DROP** | Same. Non-fleet skills stay in openclaw-config. |
| `workflows/fleet-commander/` | **KEEP** | → `workflows/fleet-commander.yml`. |
| `workflows/cost-sentinel/` | **KEEP** | → `workflows/cost-sentinel.yml`. |
| `workflows/security-sentinel/` | **KEEP** | → `workflows/security-sentinel.yml`. |
| `workflows/agent-swarm/` | **DROP** | Not needed for v1.0. Revisit if needed. |
| `workflows/calendar-steward/` | **DROP** | Not fleet management. Stays in openclaw-config. |
| `workflows/contact-steward/` | **DROP** | Same. |
| `workflows/email-steward/` | **DROP** | Same. |
| `workflows/task-steward/` | **DROP** | Same. |
| `devops/machine-setup-*.md` | **KEEP** | → `docs/`. Already covered above. |
| `devops/health-check-spec.md` | **MERGE** | → Content informs `src/core/health.ts` implementation. Doc not needed separately. |
| `devops/security-baseline.md` | **KEEP** | → `docs/security-baseline.md`. |
| `devops/launchagents/` | **KEEP** | → `configs/launchagents/`. |
| `scripts/session-*.sh` | **DROP** | Session management is OpenClaw's job, not fleet management. |
| `scripts/audit-*.sh` | **MERGE** | → Logic moves into `src/cli/security/audit.ts`. |
| `scripts/watchdog.sh` | **REWRITE** | → `src/cli/fleet/watchdog.ts`. |
| `docs/integrations/*` | **KEEP** | → `docs/integrations/`. |
| `gap-closing-plan/` | **DROP** | Superseded by this spec. |

---

## Part 4: Implementation Phases

### Phase 0: Repository Setup (3 days)

**Goal:** Empty but buildable repo with CI, linting, and the first passing test.

**Files to create:**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.json`, `.prettierrc`, `.commitlintrc.json`, `.releaserc.json`
- `.github/workflows/ci.yml`
- `bin/bscs.ts` (minimal — prints version)
- `src/cli/index.ts` (commander setup with `version` command only)
- `src/cli/version.ts` (prints ASCII art + version)
- `src/util/logger.ts` (pino setup)
- `src/util/output.ts` (stub with `formatTable()`, `formatJson()`)
- `src/util/types.ts` (initial zod schemas: `BscsConfig`, `AgentConfig`)
- `test/unit/util/output.test.ts` (first test — formatting)
- `README.md`, `LICENSE`

**Dependencies:**
```json
{
  "dependencies": {
    "commander": "^13.0.0",
    "chalk": "^5.4.0",
    "pino": "^9.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.4.0",
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0",
    "semantic-release": "^24.0.0",
    "@types/node": "^22.0.0"
  }
}
```

**Test criteria:**
- `npm run build` succeeds (tsc compiles)
- `npm run lint` passes
- `npm test` passes (1 test)
- `npx tsx bin/bscs.ts --version` prints version
- CI workflow runs on push and passes

**Estimated effort:** 8 hours

**Commands that work:**
```bash
bscs --version
bscs --help
```

---

### Phase 1: Core Modules + Agent Lifecycle (2 weeks)

**Goal:** Create, start, stop, destroy, and inspect agents on localhost via Docker.

**Files to create:**
- `src/core/docker.ts`
- `src/core/config.ts`
- `src/core/ports.ts`
- `src/core/naming.ts`
- `src/core/health.ts`
- `src/core/templates.ts`
- `src/core/secrets.ts`
- `src/cli/agent/create.ts`
- `src/cli/agent/destroy.ts`
- `src/cli/agent/status.ts`
- `src/cli/agent/start.ts`
- `src/cli/agent/stop.ts`
- `src/cli/agent/restart.ts`
- `src/cli/agent/logs.ts`
- `src/cli/agent/shell.ts`
- `src/cli/agent/update.ts`
- `src/cli/agent/clone.ts`
- `src/cli/agent/reconfigure.ts`
- `src/cli/agent/pair.ts`
- `src/cli/fleet/status.ts`
- `src/cli/doctor.ts`
- `templates/base/*`, `templates/atlas/*`, `templates/custom/*`
- `Dockerfile`
- Unit tests for all core modules

**Dependencies (add):**
```json
{
  "dockerode": "^4.0.0",
  "@types/dockerode": "^3.3.0",
  "handlebars": "^4.7.0",
  "ora": "^8.0.0",
  "cli-table3": "^0.6.0",
  "inquirer": "^12.0.0"
}
```

**System requirements:** Docker Engine running on localhost.

**Test criteria:**
- `bscs agent create test-agent --template custom` → container created and running
- `bscs agent status` → table showing test-agent as running with uptime
- `bscs agent logs test-agent --lines 10` → shows last 10 log lines
- `bscs agent stop test-agent` → container stopped
- `bscs agent start test-agent` → container started
- `bscs agent restart test-agent` → container restarted
- `bscs agent destroy test-agent --force` → container removed
- `bscs fleet status` → shows fleet overview with 0 agents
- `bscs doctor` → shows Docker ✓, all checks passing
- `bscs agent status --json` → valid JSON output
- Unit tests: >70% coverage on `src/core/`

**Estimated effort:** 65 hours

**Commands that work:**
```bash
bscs agent create <name> [--template atlas|vault|cody|custom]
bscs agent destroy <name> [--force]
bscs agent status [name] [--json] [--watch]
bscs agent logs <name> [--lines N] [--follow]
bscs agent shell <name>
bscs agent start|stop|restart <name>
bscs agent update <name> [--image tag]
bscs agent clone <source> <dest>
bscs agent reconfigure <name>
bscs agent pair <name>
bscs fleet status [--json] [--wide]
bscs doctor [--quiet]
```

---

### Phase 2: Fleet Operations + Remote (2 weeks)

**Goal:** Multi-machine fleet management, reconciliation, backup/restore, and the fleet-agent inbox/outbox protocol.

**Files to create:**
- `src/core/ssh.ts`
- `src/cli/fleet/reconcile.ts`
- `src/cli/fleet/backup.ts`
- `src/cli/fleet/restore.ts`
- `src/cli/fleet/watchdog.ts`
- `src/cli/fleet/init.ts`
- `src/cli/fleet/import.ts`
- `src/cli/fleet/install-crons.ts`
- `src/cli/fleet/upgrade.ts`
- `src/cli/machine/bootstrap.ts`
- `src/cli/machine/harden.ts`
- `src/cli/machine/status.ts`
- `src/plugins/loader.ts`
- `src/plugins/plugin.ts`
- `src/plugins/tailscale.ts`
- `src/plugins/onepassword.ts`
- `src/plugins/agentguard.ts`
- `configs/launchagents/*`
- `configs/systemd/*`
- Integration tests for fleet operations

**Dependencies (add):**
```json
{
  "ssh2": "^1.16.0",
  "@types/ssh2": "^1.15.0"
}
```

**Test criteria:**
- `bscs fleet init` → interactive wizard produces valid `~/.config/bscs/config.json`
- `bscs fleet reconcile --dry-run` → shows what would change
- `bscs fleet reconcile` → creates/updates/removes containers to match config
- `bscs fleet backup --output ./test-backup/` → tarball created
- `bscs fleet restore ./test-backup/fleet-*.tar.gz` → containers recreated from backup
- `bscs fleet watchdog` → runs one health check cycle, reports results
- `bscs machine status` → shows localhost machine info
- `bscs fleet import --from-fleet-sh ~/.fleet/config` → imports legacy config
- `bscs fleet install-crons` → installs LaunchAgent (macOS) or systemd (Linux)
- `bscs fleet upgrade --rolling --dry-run` → shows upgrade plan

**Estimated effort:** 60 hours

**Commands that work (cumulative):**
All Phase 1 commands, plus:
```bash
bscs fleet init
bscs fleet reconcile [--dry-run] [--version X.Y.Z]
bscs fleet backup [--output path]
bscs fleet restore <path>
bscs fleet watchdog [--daemon]
bscs fleet import --from-fleet-sh <path>
bscs fleet install-crons
bscs fleet upgrade [--rolling]
bscs machine bootstrap [--profile mini|hq|gpu]
bscs machine harden [--check-only]
bscs machine status
```

---

### Phase 3: Tribunal + Models + Secrets (2 weeks)

**Goal:** Tribunal integration for coding agents, model/provider management, and secret lifecycle.

**Files to create:**
- `src/core/tribunal.ts`
- `src/core/claude-code.ts`
- `src/core/models.ts` (extended)
- `src/core/secrets.ts` (extended)
- `src/cli/tribunal/*` (all 7 files)
- `src/cli/config/models/*` (all 7 files)
- `src/cli/secrets/*` (all 5 files)
- `templates/coding/*`, `templates/review/*`, `templates/tribunal-profiles/*`
- Unit tests for tribunal, models, secrets

**Dependencies (add):** None — uses existing deps.

**Test criteria:**
- `bscs agent create forge-test --role coding` → container with Tribunal configured
- `bscs tribunal status forge-test` → shows Tribunal profile, hook count, health
- `bscs tribunal report --fleet` → shows quality metrics table
- `bscs config models providers add test-anthropic --type anthropic --api-key "test-key"` → provider added
- `bscs config models providers status` → shows provider health
- `bscs config models defaults set coding claude-sonnet-4` → default set
- `bscs config models fallbacks set coding "claude-sonnet-4,gpt-4o"` → fallback configured
- `bscs secrets check` → validates all op:// references
- `bscs secrets list` → shows all managed secrets

**Estimated effort:** 60 hours

**Commands that work (cumulative):**
All Phase 1+2 commands, plus:
```bash
bscs agent create <name> --role coding|review|brain|ops
bscs tribunal status [name] [--fleet]
bscs tribunal enable|disable <name>
bscs tribunal sync [name] [--all]
bscs tribunal update [name] [--all]
bscs tribunal report [name] [--fleet] [--period range]
bscs tribunal vault connect|status|push
bscs config models providers list|add|remove|test|status
bscs config models defaults show|set|reset
bscs config models fallbacks show|set|test
bscs config models routing show|add-rule|remove-rule|stats
bscs config models assign|unassign <agent> [model]
bscs config models list [--costs]
bscs config models costs [--period range] [--by group]
bscs secrets list|sync|check|rotate|audit
```

---

### Phase 4: Sentinels + MCP + Dashboard (2 weeks)

**Goal:** Background monitoring, MCP server for AI-native operations, and the web dashboard.

**Files to create:**
- `src/sentinels/cost-sentinel.ts`
- `src/sentinels/security-sentinel.ts`
- `src/cli/cost/report.ts`
- `src/cli/cost/budget.ts`
- `src/cli/security/audit.ts`
- `src/cli/security/baseline.ts`
- `src/mcp/server.ts`
- `src/mcp/tools/*` (all 8 files)
- `src/cli/mcp.ts`
- `src/dashboard/server.ts`
- `src/dashboard/websocket.ts`
- `src/dashboard/routes/*` (all 6 files)
- `src/dashboard-ui/*` (all files)
- `src/cli/dashboard/*` (all 3 files)

**Dependencies (add):**
```json
{
  "fastify": "^5.0.0",
  "@fastify/static": "^8.0.0",
  "@fastify/websocket": "^11.0.0",
  "@modelcontextprotocol/sdk": "^1.0.0"
}
```

**Test criteria:**
- `bscs cost report --period today` → shows today's spend
- `bscs cost budget set 10` → sets $10 daily budget
- `bscs cost budget status` → shows current vs budget
- `bscs security audit` → runs checks, shows results
- `bscs security baseline` → checks compliance
- `bscs mcp serve` → starts MCP server, responds to tool calls
- `bscs dashboard` → starts web UI on :3200
- `bscs dashboard --open` → opens browser
- `curl http://localhost:3200/api/fleet` → returns fleet JSON
- Dashboard home page shows fleet overview with live data

**Estimated effort:** 70 hours

**Commands that work (cumulative):**
All previous commands, plus:
```bash
bscs cost report [--period range] [--by agent|model|provider]
bscs cost budget set <amount>
bscs cost budget status
bscs security audit [--fix]
bscs security baseline
bscs mcp serve [--port N]
bscs dashboard [--port N] [--daemon] [--open]
bscs dashboard stop
bscs dashboard status
```

---

### Phase 5: Polish + Docs + Release (1 week)

**Goal:** Documentation, install script, shell completions, performance tuning, v1.0.0 release.

**Files to create:**
- All `docs/*.md` files
- `skills/*` (port from openclaw-config)
- `workflows/*` (port from openclaw-config)
- Shell completion scripts (auto-generated from commander)

**Dependencies (add):** None.

**Test criteria:**
- `npm install -g @botsquad/bscs` → installs globally
- `bscs --help` → shows all commands
- Tab completion works in zsh
- CLI startup time < 200ms (`time bscs --version`)
- All docs render correctly in GitHub
- Full cycle test: fresh machine → `bscs fleet init` → `bscs agent create` → `bscs fleet status` → `bscs dashboard`

**Estimated effort:** 35 hours

**Commands that work:** All commands. Full CLI.

---

### Phase Summary

| Phase | Goal | Effort | Calendar |
|---|---|---|---|
| 0 | Repo setup, CI, skeleton | 8h | 3 days |
| 1 | Core modules + agent lifecycle | 65h | 2 weeks |
| 2 | Fleet operations + remote | 60h | 2 weeks |
| 3 | Tribunal + models + secrets | 60h | 2 weeks |
| 4 | Sentinels + MCP + dashboard | 70h | 2 weeks |
| 5 | Polish + docs + release | 35h | 1 week |
| **Total** | **v1.0.0** | **298h** | **~10 weeks** |

---

## Part 5: Core Module Specifications

### Module 1: CLI Entry Point + Command Router

**Purpose:** Parse CLI arguments, route to command handlers, manage global options.

**Inputs/Outputs:**
- Input: `process.argv`
- Output: Delegates to command handler, which produces stdout/stderr + exit code

**Key functions:**

```typescript
// bin/bscs.ts
#!/usr/bin/env tsx
import { createProgram } from '../src/cli/index.js';
const program = createProgram();
program.parse(process.argv);

// src/cli/index.ts
export function createProgram(): Command {
  const program = new Command('bscs')
    .version(version, '-V, --version')
    .option('--json', 'Output as JSON')
    .option('--quiet', 'Minimal output')
    .option('--no-color', 'Disable colors');

  // Register all subcommand groups
  registerAgentCommands(program);
  registerFleetCommands(program);
  registerMachineCommands(program);
  registerCostCommands(program);
  registerSecurityCommands(program);
  registerTribunalCommands(program);
  registerConfigCommands(program);
  registerSecretsCommands(program);
  registerDashboardCommands(program);
  program.addCommand(createDoctorCommand());
  program.addCommand(createMcpCommand());

  return program;
}
```

**Error handling:** Commander handles unknown commands/options. Each command handler wraps its body in try/catch. Errors produce formatted messages (see §3.5 in BSCS-PLAN.md) and exit with code 1.

**Dependencies:** `commander`, `chalk`, `pino`

**Source:** New (no direct bash equivalent — fleet.sh used case/esac).

---

### Module 2: Agent Lifecycle (create/destroy/start/stop/restart)

**Purpose:** Manage individual OpenClaw agent containers — full lifecycle from creation to removal.

**Inputs/Outputs:**
- Input: Agent name, template, machine, options
- Output: Docker container operations, workspace files, stdout status

**Key functions:**

```typescript
// src/core/docker.ts

/** Create a new agent container with workspace + config */
async function createAgent(opts: CreateAgentOpts): Promise<AgentInfo>
// opts: { name, template, machine, model, channel, port, role, tribunalProfile }
// Returns: { name, containerId, port, status, machine }

/** Destroy an agent — stop container, optionally remove volumes */
async function destroyAgent(name: string, opts?: { removeVolumes?: boolean }): Promise<void>

/** Start a stopped agent container */
async function startAgent(name: string): Promise<void>

/** Gracefully stop an agent container (SIGTERM, 10s timeout, then SIGKILL) */
async function stopAgent(name: string): Promise<void>

/** Restart = stop + start */
async function restartAgent(name: string): Promise<void>

/** Get status of one or all agents */
async function getAgentStatus(name?: string): Promise<AgentStatus[]>
// Returns: [{ name, containerId, status, uptime, model, machine, health, tribunalProfile }]

/** Stream container logs */
async function getAgentLogs(name: string, opts: { lines: number; follow: boolean }): Promise<ReadableStream>

/** Execute interactive shell in container */
async function execShell(name: string): Promise<void>
// Uses dockerode.exec with { AttachStdin: true, AttachStdout: true, Tty: true }

/** Pull new image and recreate container (preserving volumes) */
async function updateAgent(name: string, image?: string): Promise<void>

/** Clone agent config to new name */
async function cloneAgent(source: string, dest: string): Promise<AgentInfo>

/** Re-apply config to running agent without recreate */
async function reconfigureAgent(name: string): Promise<void>
```

**Error handling:**
- Container not found → clear error with `bscs agent status` hint
- Docker not running → `bscs doctor` hint
- Port conflict → auto-pick next available, warn user
- Image pull failure → retry once, then error with offline hint

**Dependencies:** `dockerode`, `src/core/config.ts`, `src/core/ports.ts`, `src/core/naming.ts`, `src/core/templates.ts`

**Source:** `openclaw-fleet/lib/docker.sh` (container operations), `openclaw-fleet/fleet.sh` (command routing)

---

### Module 3: Fleet Operations (status/reconcile/health)

**Purpose:** Fleet-wide operations across all machines and agents.

**Inputs/Outputs:**
- Input: Fleet config, Docker state across machines
- Output: Fleet status, reconciliation actions, health reports

**Key functions:**

```typescript
// src/cli/fleet/status.ts
/** Aggregate status from all machines */
async function fleetStatus(opts: { wide?: boolean }): Promise<FleetOverview>
// Returns: { machines: MachineStatus[], agents: AgentStatus[], cost: DailyCost, security: BaselineStatus }

// src/cli/fleet/reconcile.ts
/** Compare desired state (config) vs actual state (Docker), produce a plan, optionally apply */
async function reconcile(opts: { dryRun?: boolean; version?: string }): Promise<ReconcileResult>
// Returns: { toCreate: string[], toUpdate: string[], toRemove: string[], applied: boolean }

// src/core/health.ts
/** Check health of a single agent (container health + OpenClaw gateway ping) */
async function checkAgentHealth(name: string): Promise<HealthResult>
// Returns: { container: 'healthy'|'unhealthy'|'stopped', gateway: 'ok'|'unreachable', latencyMs: number }

/** Check health of a machine (SSH reachable, Docker running, disk space, load) */
async function checkMachineHealth(machine: string): Promise<MachineHealth>
// Returns: { reachable, docker, diskPercent, loadAvg, cpuPercent, memUsedGb, memTotalGb }
```

**Error handling:**
- Machine unreachable → mark as `unreachable` in status, don't fail the whole fleet status
- SSH timeout → 10s timeout, mark machine as degraded
- Docker not running on remote → show in status as `docker: ✗`

**Dependencies:** `src/core/docker.ts`, `src/core/ssh.ts`, `src/core/health.ts`, `src/core/config.ts`

**Source:** `openclaw-fleet/lib/health.sh`, `openclaw-fleet/lib/maintain.sh`

---

### Module 4: Docker Integration (container management)

**Purpose:** Low-level Docker API wrapper. All Docker operations go through this module.

**Inputs/Outputs:**
- Input: Container configs, image names, exec commands
- Output: Docker API responses, container IDs, streams

**Key functions:**

```typescript
// src/core/docker.ts (lower-level functions used by Module 2)

/** Get a dockerode instance (local or remote via SSH tunnel) */
function getDocker(machine?: string): Dockerode
// Local: connects via /var/run/docker.sock
// Remote: SSH tunnel to remote Docker socket

/** Create container with BSCS-standard labels and security settings */
async function createContainer(opts: ContainerCreateOpts): Promise<Dockerode.Container>
// Always sets labels: { 'bscs.agent': name, 'bscs.role': role, 'bscs.template': template }
// Always applies: noNewPrivileges, capDrop=['ALL'], pidsLimit, tmpfs on /tmp

/** List containers with BSCS labels */
async function listBscsContainers(machine?: string): Promise<ContainerInfo[]>
// Filters by label 'bscs.agent'

/** Get container stats (CPU, memory, network, PIDs) */
async function getContainerStats(containerId: string): Promise<ContainerStats>

/** Docker exec in container, returns stdout */
async function containerExec(containerId: string, cmd: string[]): Promise<{ stdout: string; exitCode: number }>
```

**Error handling:**
- Docker socket not found → "Docker not running. Run `bscs doctor` for details."
- Container create fails → parse Docker error, provide actionable message
- Image not found → `docker pull` first, then retry

**Dependencies:** `dockerode`

**Source:** `openclaw-fleet/lib/docker.sh`

---

### Module 5: Config Generation (OpenClaw configs from templates)

**Purpose:** Generate OpenClaw agent configurations from templates and BSCS config.

**Inputs/Outputs:**
- Input: Template name, agent config values (name, model, channel, etc.)
- Output: Rendered workspace files (AGENTS.md, SOUL.md, settings.yaml, etc.)

**Key functions:**

```typescript
// src/core/config.ts

/** Validate agent configuration against schema */
function validateAgentConfig(config: unknown): AgentConfig
// Uses zod schema. Throws ZodError with clear field-level messages.

/** Generate the full set of workspace files for an agent */
async function generateWorkspace(agent: AgentConfig): Promise<Map<string, string>>
// Returns: Map of { relativePath → fileContents }
// e.g., { 'AGENTS.md' → '...', 'SOUL.md' → '...', '.env' → '...' }

// src/core/templates.ts

/** Render a Handlebars template with agent context */
function renderTemplate(templatePath: string, context: TemplateContext): string

/** Load all template files from a template directory */
async function loadTemplateSet(templateName: string): Promise<TemplateFile[]>
// Loads from templates/<templateName>/, falling back to templates/base/ for missing files
```

**Error handling:**
- Template not found → list available templates in error message
- Missing required template variable → clear error showing which variable and which template
- Invalid settings.yaml → validate against OpenClaw schema before writing

**Dependencies:** `handlebars`, `zod`, `src/core/naming.ts`

**Source:** `fleet-bootstrap/generate-configs.py` (Python Jinja2 → TS Handlebars), `openclaw-fleet/lib/config.sh`

---

### Module 6: Secret Management (1Password integration)

**Purpose:** Resolve `op://` references to real values, manage key lifecycle, sync secrets to fleet.

**Inputs/Outputs:**
- Input: Config with `op://` references
- Output: Resolved secret values (injected into container env, never written to disk)

**Key functions:**

```typescript
// src/core/secrets.ts

/** Resolve an op:// reference to its value */
async function resolveSecret(ref: string): Promise<string>
// Calls: op read "op://vault/item/field"
// Caches resolved values for the duration of the process (not persisted)

/** Resolve all op:// references in a config object */
async function resolveAllSecrets(config: Record<string, unknown>): Promise<Record<string, unknown>>
// Deep-walks the config, resolves any string matching /^op:\/\//

/** Check if all secrets in the config are valid */
async function checkSecrets(): Promise<SecretCheckResult[]>
// Returns: [{ ref, status: 'valid'|'invalid'|'not-found', keyAge?: number }]

/** Sync changed secrets to running containers */
async function syncSecrets(agents?: string[]): Promise<SyncResult[]>
// Compares resolved values with container env, updates if changed

/** Get key age for a 1Password item */
async function getKeyAge(ref: string): Promise<{ days: number; lastModified: Date }>

// src/plugins/onepassword.ts
/** Plugin: checks if 'op' CLI is installed and authenticated */
```

**Error handling:**
- `op` not installed → "1Password CLI not found. Install: https://1password.com/downloads/command-line/"
- `op` not authenticated → "Run `op signin` first"
- Item not found → show exact `op://` reference that failed
- Network error → "1Password service unreachable. Secrets using cached values."

**Dependencies:** Child process (`op` CLI), `src/plugins/onepassword.ts`

**Source:** `openclaw-fleet/lib/secrets.sh`, `fleet-bootstrap/sync-keys.sh`

---

### Module 7: Model/Provider Management

**Purpose:** Manage AI model providers, per-role defaults, fallback chains, and routing rules.

**Inputs/Outputs:**
- Input: BSCS config (models section), provider API endpoints
- Output: Provider health status, model assignments, cost data

**Key functions:**

```typescript
// src/core/models.ts

/** List all configured providers with their status */
async function listProviders(): Promise<ProviderStatus[]>
// Returns: [{ name, type, status, latencyMs, modelCount, enabled }]

/** Test a provider (connectivity + auth + list models) */
async function testProvider(name: string): Promise<ProviderTestResult>
// Makes minimal API call: Anthropic /v1/messages (tiny), OpenAI /v1/models, etc.

/** Get the effective model for an agent (per-agent override → role default → global default) */
function getEffectiveModel(agentName: string, role: AgentRole): string

/** Get the fallback chain for a role */
function getFallbackChain(role: AgentRole): string[]

/** Test a fallback chain (try each model in order) */
async function testFallbackChain(role: AgentRole): Promise<FallbackTestResult[]>

/** Get cost data by grouping (agent, model, provider) for a time period */
async function getCostReport(period: string, groupBy: string): Promise<CostReport>
// Reads from cost sentinel's accumulated data (JSON file at ~/.config/bscs/costs/)

/** Auto-discover local Ollama instances via Tailscale */
async function discoverLocalProviders(): Promise<DiscoveredProvider[]>
```

**Error handling:**
- Provider unreachable → mark as down, suggest checking the service
- Invalid API key → clear message, suggest `bscs secrets rotate <provider>`
- Unknown model name → list available models for the provider

**Dependencies:** `fetch` (Node built-in), `src/core/secrets.ts` (resolve API keys), `src/plugins/tailscale.ts` (discovery)

**Source:** `openclaw-fleet/lib/models.sh` (basic model config), massively extended

---

### Module 8: Dashboard Server

**Purpose:** Web-based fleet monitoring UI — visual layer over the same data the CLI reads.

**Inputs/Outputs:**
- Input: HTTP requests, WebSocket connections
- Output: JSON API responses, static SPA files, WebSocket push events

**Key functions:**

```typescript
// src/dashboard/server.ts

/** Start the dashboard Fastify server */
async function startDashboard(opts: { port: number; host: string; auth?: string }): Promise<void>
// Registers routes, serves static files from dashboard-ui/, starts WebSocket

/** Stop the running dashboard */
async function stopDashboard(): Promise<void>

// src/dashboard/routes/fleet.ts
/** GET /api/fleet → FleetOverview (same data as bscs fleet status --json) */

// src/dashboard/routes/agents.ts
/** GET /api/agents → AgentStatus[] */
/** GET /api/agents/:name → AgentDetail (stats, logs, config) */
/** POST /api/agents/:name/restart → restart agent */
/** POST /api/agents/:name/stop → stop agent */
/** DELETE /api/agents/:name → destroy agent (requires ?confirm=true) */

// src/dashboard/routes/models.ts
/** GET /api/models/providers → ProviderStatus[] */
/** GET /api/models/routing/stats → RoutingStats */

// src/dashboard/routes/costs.ts
/** GET /api/costs?period=week&by=agent → CostReport */

// src/dashboard/websocket.ts
/** Push agent status changes, health transitions, cost updates to connected clients */
async function broadcastUpdate(event: DashboardEvent): void
// Events: agent-status-change, machine-health-change, cost-update, tribunal-gate-result
```

**Error handling:**
- Port already in use → try next port, inform user
- Dashboard crash → auto-restart in daemon mode (LaunchAgent handles it)
- WebSocket disconnect → client auto-reconnects (exponential backoff in SPA)

**Dependencies:** `fastify`, `@fastify/static`, `@fastify/websocket`

**Source:** New (no bash equivalent).

---

### Module 9: Watchdog/Health Monitor

**Purpose:** Periodic health checks on all agents and machines. Alert on degradation. Optionally auto-heal.

**Inputs/Outputs:**
- Input: Fleet config, health check interval
- Output: Health reports, alerts (via configured channel), auto-heal actions

**Key functions:**

```typescript
// src/cli/fleet/watchdog.ts

/** Run a single health check cycle */
async function runWatchdogCycle(): Promise<WatchdogReport>
// 1. Check all machines (SSH/Tailscale ping)
// 2. Check all agents (container health + gateway ping)
// 3. Check all providers (API connectivity)
// 4. Check secret validity
// 5. Compare against last cycle for state transitions
// Returns: { machines, agents, providers, secrets, alerts: Alert[] }

/** Run as daemon — cycle every 5 minutes */
async function runWatchdogDaemon(): Promise<void>
// Loops: runWatchdogCycle() → sleep 5min → repeat
// Sends alerts on state transitions (healthy→unhealthy, etc.)

/** Auto-heal actions */
async function autoHeal(agent: string, issue: HealthIssue): Promise<boolean>
// container stopped unexpectedly → restart
// gateway unreachable → restart OpenClaw process inside container
// health check failing → log, don't restart (avoid restart loops)
```

**Error handling:**
- Watchdog itself crashes → LaunchAgent/systemd auto-restarts it
- Alert channel unreachable → log locally, retry next cycle
- Auto-heal makes things worse → max 3 restart attempts per hour per agent

**Dependencies:** `src/core/health.ts`, `src/core/docker.ts`, `src/core/models.ts`, `src/core/secrets.ts`

**Source:** `openclaw-fleet/lib/health.sh`, `openclaw-config/scripts/watchdog.sh`

---

### Module 10: Machine Bootstrap (remote setup via SSH)

**Purpose:** Set up a fresh machine (macOS or Linux) to join the fleet — install Docker, configure security, set up crons.

**Inputs/Outputs:**
- Input: Machine hostname/IP, SSH credentials, profile (mini/hq/gpu)
- Output: Machine ready to host BSCS agents

**Key functions:**

```typescript
// src/cli/machine/bootstrap.ts

/** Run the full bootstrap sequence on a remote machine */
async function bootstrapMachine(host: string, opts: BootstrapOpts): Promise<BootstrapResult>
// Profile 'mini': Docker, Node.js, 1Password CLI, Tribunal, Claude Code, firewall, crons
// Profile 'hq': Same + Tailscale exit node config
// Profile 'gpu': Same + NVIDIA drivers + CUDA + llama.cpp

// Steps (executed via SSH):
const BOOTSTRAP_STEPS = [
  'check-os',           // Detect macOS/Linux, version
  'check-ssh',          // Verify SSH access
  'install-homebrew',   // macOS only
  'install-docker',     // Docker Engine
  'install-node',       // Node.js 22 LTS
  'install-bscs',       // npm install -g @botsquad/bscs
  'install-op',         // 1Password CLI
  'install-tribunal',   // pip install tribunal
  'install-claude-code', // npm install -g @anthropic-ai/claude-code
  'configure-docker',   // Daemon settings, log rotation
  'configure-firewall', // pf (macOS) or ufw (Linux)
  'configure-ssh',      // Disable password auth, key-only
  'pull-image',         // docker pull ghcr.io/thebotclub/bscs:latest
  'create-dirs',        // /opt/bscs, ~/.config/bscs
  'install-crons',      // Watchdog, secret sync, backups
  'verify',             // bscs doctor on remote machine
] as const;

// src/cli/machine/harden.ts
/** Apply security hardening to a machine */
async function hardenMachine(host: string, opts: { checkOnly?: boolean }): Promise<HardenResult>
// Checks: SSH config, firewall, open ports, Docker security, file permissions
```

**Error handling:**
- SSH connection fails → clear error with Tailscale/key hints
- Step fails → stop, show which step, suggest `--skip <step>` to continue
- Already bootstrapped → detect, warn, offer `--force`

**Dependencies:** `ssh2`, `src/core/ssh.ts`

**Source:** `fleet-bootstrap/bootstrap.sh` (23 steps — same logic, TS implementation)

---

### Module 11: Tribunal Integration (install + configure)

**Purpose:** Configure Tribunal for coding agents — profile selection, config generation, metrics collection.

**Inputs/Outputs:**
- Input: Agent role, Tribunal profile preference
- Output: `.tribunal/config.json`, `.claude/settings.json` hooks, `.claude/mcp.json` servers

**Key functions:**

```typescript
// src/core/tribunal.ts

/** Determine Tribunal profile for an agent role */
function tribunalProfileForRole(role: AgentRole): TribunalProfile
// coding → 'full', review → 'review', devops → 'light', everything else → 'none'

/** Generate .tribunal/config.json for a profile */
function generateTribunalConfig(profile: TribunalProfile): TribunalConfig
// Reads from templates/tribunal-profiles/<profile>.json

/** Get Tribunal status from a running agent */
async function getTribunalStatus(agentName: string): Promise<TribunalStatus>
// Runs `tribunal doctor --json` inside container via docker exec

/** Collect quality metrics from agent's Tribunal audit DB */
async function getTribunalMetrics(agentName: string): Promise<TribunalMetrics>
// Runs `tribunal report --json` inside container

/** Collect fleet-wide metrics */
async function getFleetTribunalMetrics(): Promise<FleetTribunalMetrics>
// Calls getTribunalMetrics for each coding agent, aggregates

// src/core/claude-code.ts

/** Generate .claude/settings.json with Tribunal hooks */
function generateClaudeSettings(role: AgentRole, profile: TribunalProfile): ClaudeSettings

/** Generate .claude/mcp.json with Tribunal + fleet MCP servers */
function generateClaudeMcp(profile: TribunalProfile): ClaudeMcpConfig
```

**Error handling:**
- Tribunal not in container → warn (not fatal), agent works without it
- Tribunal hooks failing → log to agent stderr, don't block agent operations
- Metrics unavailable → return empty metrics, show `—` in reports

**Dependencies:** `src/core/docker.ts` (for exec), `handlebars` (for config templates)

**Source:** New — implements design from BSCS-TRIBUNAL-INTEGRATION.md §6.3-§6.7

---

### Module 12: Cost Tracking

**Purpose:** Track API spend per agent/model/provider, enforce budgets, generate reports.

**Inputs/Outputs:**
- Input: Agent logs (token counts), provider pricing, budget config
- Output: Cost reports, budget alerts

**Key functions:**

```typescript
// src/sentinels/cost-sentinel.ts

/** Run a cost check cycle (called by watchdog or cron) */
async function runCostCheck(): Promise<CostCheckResult>
// 1. Read token counts from agent logs (or provider usage APIs)
// 2. Calculate cost using published pricing
// 3. Compare against daily budget
// 4. Write to ~/.config/bscs/costs/YYYY-MM-DD.json
// 5. Alert if over budget

/** Get cost data for a period */
async function getCostData(period: string): Promise<DailyCost[]>
// Reads from ~/.config/bscs/costs/ directory

/** Model pricing table (updated periodically) */
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'claude-opus-4': { inputPer1M: 15.0, outputPer1M: 75.0 },
  'claude-sonnet-4': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-3.5': { inputPer1M: 0.80, outputPer1M: 4.0 },
  'gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.0 },
  // ... etc
};
```

**Error handling:**
- Token counts unavailable → estimate from log line lengths (rough but better than nothing)
- Provider usage API unavailable → fall back to local token counting
- Cost file corrupted → recreate from provider APIs if possible

**Dependencies:** `src/core/models.ts`, `src/core/docker.ts` (read agent logs), `pino`

**Source:** `openclaw-config/skills/cost-tracker/cost-tracker`, `openclaw-config/workflows/cost-sentinel/`

---

### Module 13: Security Audit

**Purpose:** Check fleet security posture — firewall, SSH, Docker, file permissions, keys, compliance.

**Inputs/Outputs:**
- Input: Machine SSH access, Docker API, config files
- Output: Audit report with findings (pass/warn/fail per check)

**Key functions:**

```typescript
// src/cli/security/audit.ts

/** Run security audit on all machines */
async function runSecurityAudit(opts: { fix?: boolean }): Promise<AuditReport>

// Individual checks:
async function checkSSHConfig(machine: string): Promise<AuditCheck>
// Password auth disabled? Root login disabled? Key-only?

async function checkFirewall(machine: string): Promise<AuditCheck>
// pf/ufw enabled? Only needed ports open?

async function checkDockerSecurity(machine: string): Promise<AuditCheck>
// No privileged containers? Cap drop ALL? Pids limit set?

async function checkFilePermissions(machine: string): Promise<AuditCheck>
// Config files 600? SSH keys 600? No world-readable secrets?

async function checkKeyAge(): Promise<AuditCheck>
// Any API keys > 90 days old?

async function checkContainerSecurity(agent: string): Promise<AuditCheck>
// noNewPrivileges? Read-only rootfs? Tmpfs on /tmp?
```

**Error handling:**
- Check fails to run → mark as `error` (not `fail`), continue with other checks
- `--fix` can't fix an issue → report it as manual action needed
- Remote machine unreachable → skip that machine, note in report

**Dependencies:** `src/core/ssh.ts`, `src/core/docker.ts`, `src/core/secrets.ts`

**Source:** `openclaw-config/skills/security-setup/security-setup`, `openclaw-config/devops/security-baseline.md`

---

## Part 6: Config File Schemas

### `bscs.json` — Main BSCS Config

Location: `~/.config/bscs/config.json`

```typescript
// src/util/types.ts

import { z } from 'zod';

export const MachineSchema = z.object({
  host: z.string(),                              // IP or hostname (Tailscale IP preferred)
  user: z.string().default('hani'),              // SSH user
  role: z.enum(['controller', 'worker', 'gpu']), // Machine role
  port: z.number().default(22),                  // SSH port
});

export const DockerSecuritySchema = z.object({
  noNewPrivileges: z.boolean().default(true),
  capDropAll: z.boolean().default(true),
  tmpfs: z.boolean().default(true),
  pidsLimit: z.number().default(256),
  readOnlyRootfs: z.boolean().default(false),
});

export const DockerResourcesSchema = z.object({
  coding: z.object({ memory: z.string().default('4g'), pidsLimit: z.number().default(512) }),
  review: z.object({ memory: z.string().default('2g'), pidsLimit: z.number().default(256) }),
  brain: z.object({ memory: z.string().default('1g'), pidsLimit: z.number().default(128) }),
  default: z.object({ memory: z.string().default('2g'), pidsLimit: z.number().default(256) }),
});

export const ProviderSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'google', 'ollama', 'llamacpp', 'litellm']),
  apiKey: z.string().optional(),                  // op:// reference or literal
  baseUrl: z.string().optional(),                 // For local/custom providers
  local: z.boolean().default(false),
  gpu: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const RoutingRuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  condition: z.object({
    taskType: z.array(z.string()).optional(),
    estimatedTokens: z.object({
      min: z.number().optional(),
      max: z.number().optional(),
    }).optional(),
  }),
  model: z.string(),
  provider: z.string().optional(),
});

export const TribunalConfigSchema = z.object({
  version: z.string().nullable().default(null),   // null = latest
  defaultProfile: z.enum(['full', 'review', 'light', 'none']).default('full'),
  autoUpdate: z.boolean().default(false),
  vault: z.object({
    repo: z.string().default('thebotclub/tribunal-vault'),
    token: z.string().optional(),                 // op:// reference
    autoSync: z.boolean().default(false),
    syncSchedule: z.enum(['daily', 'weekly', 'manual']).default('manual'),
  }).default({}),
});

export const BscsConfigSchema = z.object({
  fleet: z.object({
    name: z.string(),
    controller: z.string(),                       // Machine name that is the controller
  }),
  machines: z.record(z.string(), MachineSchema),
  docker: z.object({
    image: z.string().default('ghcr.io/thebotclub/bscs:latest'),
    registry: z.string().default('ghcr.io'),
    security: DockerSecuritySchema.default({}),
    resources: DockerResourcesSchema.default({}),
  }).default({}),
  plugins: z.object({
    agentguard: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().optional(),
    }).default({}),
    onepassword: z.object({
      enabled: z.boolean().default(true),
      vault: z.string().default('bscs'),
    }).default({}),
    tailscale: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
  }).default({}),
  models: z.object({
    providers: z.record(z.string(), ProviderSchema).default({}),
    defaults: z.record(z.string(), z.string()).default({
      coding: 'claude-sonnet-4',
      brain: 'claude-opus-4',
      review: 'claude-sonnet-4',
      ops: 'claude-haiku-3.5',
    }),
    fallbacks: z.record(z.string(), z.array(z.string())).default({}),
    routing: z.object({
      rules: z.array(RoutingRuleSchema).default([]),
      costThreshold: z.number().default(0.05),
      localFirst: z.boolean().default(false),
    }).default({}),
    agents: z.record(z.string(), z.object({
      model: z.string(),
      fallback: z.array(z.string()).optional(),
      apiKey: z.string().optional(),
    })).default({}),
  }).default({}),
  tribunal: TribunalConfigSchema.default({}),
  cost: z.object({
    dailyBudget: z.number().default(10.0),
    alertChannel: z.string().optional(),
    alertTarget: z.string().optional(),
  }).default({}),
  security: z.object({
    baselineProfile: z.enum(['strict', 'standard', 'relaxed']).default('strict'),
    auditSchedule: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
  }).default({}),
  dashboard: z.object({
    port: z.number().default(3200),
    host: z.string().default('0.0.0.0'),
    auth: z.enum(['basic', 'none']).nullable().default(null),
    autoStart: z.boolean().default(false),
  }).default({}),
});

export type BscsConfig = z.infer<typeof BscsConfigSchema>;
```

### Agent Config (per-agent settings)

```typescript
export const AgentRoleSchema = z.enum([
  'coding', 'review', 'brain', 'security', 'ops', 'marketing', 'custom'
]);

export const AgentConfigSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'Agent name: lowercase alphanumeric + hyphens, 2-31 chars'),
  template: z.enum(['atlas', 'vault', 'cody', 'coding', 'review', 'custom']).default('custom'),
  role: AgentRoleSchema.default('custom'),
  machine: z.string().default('localhost'),
  model: z.string().optional(),                    // Override. Falls back to role default.
  channel: z.string().optional(),                  // telegram, discord, slack
  port: z.number().optional(),                     // Auto-assigned if omitted
  tribunalProfile: z.enum(['full', 'review', 'light', 'none']).optional(), // Auto from role if omitted
  env: z.record(z.string(), z.string()).default({}), // Extra env vars
  resources: z.object({
    memory: z.string().optional(),
    pidsLimit: z.number().optional(),
  }).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
```

### Fleet Inventory (machines + roles)

The fleet inventory is the `machines` field in `bscs.json`. No separate file.

```typescript
// Example machine inventory (part of BscsConfig)
{
  "machines": {
    "mini1": { "host": "100.64.0.1", "user": "hani", "role": "worker" },
    "mini2": { "host": "100.64.0.2", "user": "hani", "role": "worker" },
    "mini3": { "host": "100.64.0.3", "user": "hani", "role": "worker" },
    "mini4": { "host": "100.64.0.4", "user": "hani", "role": "controller" },
    "hq":    { "host": "100.64.0.5", "user": "hani", "role": "worker" },
    "gpu":   { "host": "100.64.0.6", "user": "hani", "role": "gpu" }
  }
}
```

### Cost Budget Config

Part of `bscs.json` under the `cost` key. No separate file.

### Cost Data (daily files)

Location: `~/.config/bscs/costs/YYYY-MM-DD.json`

```typescript
export const DailyCostSchema = z.object({
  date: z.string(),                               // YYYY-MM-DD
  totalSpend: z.number(),
  budget: z.number(),
  byAgent: z.record(z.string(), z.number()),      // { 'forge4': 1.20, 'atlas-1': 0.85 }
  byModel: z.record(z.string(), z.object({
    requests: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cost: z.number(),
  })),
  byProvider: z.record(z.string(), z.number()),   // { 'anthropic': 3.50, 'openai': 0.30 }
});
```

---

## Part 7: Testing Strategy

### Unit Tests

**Framework:** Vitest

**What's mocked:**
- `dockerode` — mock the Docker API. Tests get a fake Docker client that responds with fixture data.
- `op` CLI — mock `child_process.execFile` for `op read` calls. Return fixture secrets.
- `ssh2` — mock SSH connections. Tests get a fake SSH client.
- `fetch` — mock provider API calls (model list, health checks).

**What's NOT mocked:**
- Zod schemas (test validation with real data)
- Handlebars templates (test rendering with real templates)
- Port allocation (test with real file system in temp dir)
- Config read/write (test with real files in temp dir)

**Coverage target:** >70% on `src/core/`, >50% on `src/cli/`.

**Run:** `npm test` or `vitest`

### Integration Tests

**How to test without 5 machines:**

1. **Local Docker tests** — All agent lifecycle tests run against local Docker. CI has Docker available via GitHub Actions `services: docker`. These test create/start/stop/destroy/logs/exec.

2. **Single-machine fleet** — Fleet operations (reconcile, backup, restore, watchdog) test against localhost only. The machine is `localhost` in the test config.

3. **SSH mocking for multi-machine** — Remote operations use a mock SSH server (via `ssh2` library's server mode). Bootstrap and harden commands test against this mock.

4. **Dashboard API tests** — Start Fastify server on random port, hit endpoints with `fetch`, verify JSON responses.

**Run:** `npm run test:integration` (requires Docker)

### E2E Test

**What constitutes "it works":**

1. `bscs fleet init` → creates valid config file
2. `bscs agent create test-e2e --template custom` → container running
3. `bscs agent status test-e2e` → shows healthy
4. `bscs fleet status` → shows 1 machine, 1 agent
5. `bscs agent logs test-e2e --lines 5` → shows log output
6. `bscs agent stop test-e2e` → container stopped
7. `bscs agent start test-e2e` → container started
8. `bscs agent destroy test-e2e --force` → container removed
9. `bscs doctor` → all checks pass

**Run:** `npm run test:e2e` (requires Docker, runs ~60 seconds)

### CI Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck    # tsc --noEmit

  test-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm test -- --coverage

  test-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run test:integration

  docker-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - run: docker buildx build --platform linux/arm64,linux/amd64 .
```

---

## Part 8: First 10 Commands a Developer Runs

```bash
# 1. Clone the repo
git clone git@github.com:thebotclub/bscs.git && cd bscs

# 2. Install dependencies
npm install

# 3. Build TypeScript
npm run build

# 4. Run the test suite
npm test

# 5. Link the CLI globally for local dev
npm link

# 6. Verify the CLI works
bscs --version

# 7. Run the doctor to check your environment
bscs doctor

# 8. Create a test agent (requires Docker running)
bscs agent create dev-test --template custom

# 9. Check it's running
bscs agent status

# 10. Clean up
bscs agent destroy dev-test --force
```

**Expected `package.json` scripts:**

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch bin/bscs.ts",
    "lint": "eslint src/ bin/ test/",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "test:coverage": "vitest run --coverage",
    "prepare": "npm run build"
  },
  "bin": {
    "bscs": "./dist/bin/bscs.js"
  }
}
```

---

## Appendix: Docker Label Convention

All BSCS containers use these labels for discovery and management:

```
bscs.agent=<name>           # Agent name (e.g., "forge4")
bscs.role=<role>            # Agent role (e.g., "coding")
bscs.template=<template>    # Template used (e.g., "coding")
bscs.machine=<machine>      # Machine name (e.g., "mini4")
bscs.version=<version>      # BSCS version that created it
bscs.created=<ISO8601>      # Creation timestamp
```

`bscs agent status` finds agents by filtering containers with `label=bscs.agent`. This is the same approach `fleet.sh` uses, ensuring backward compatibility during migration.

## Appendix: Port Allocation

Ports are allocated from a range (default: 3400-3500) using a file-based lock at `~/.config/bscs/ports.json`:

```json
{
  "allocated": {
    "3400": "atlas-1",
    "3401": "vault-1",
    "3402": "forge4"
  },
  "range": { "min": 3400, "max": 3500 }
}
```

`allocatePort()` finds the first unallocated port in range. `releasePort()` removes the allocation on agent destroy. Atomic file writes prevent race conditions.

## Appendix: ASCII Art Logo

```
 ██████╗ ███████╗ ██████╗███████╗
 ██╔══██╗██╔════╝██╔════╝██╔════╝
 ██████╔╝███████╗██║     ███████╗
 ██╔══██╗╚════██║██║     ╚════██║
 ██████╔╝███████║╚██████╗███████║
 ╚═════╝ ╚══════╝ ╚═════╝╚══════╝
  Command your AI fleet.
```

---

*This document is implementation-ready. Every decision is made. A developer — human or AI — can start coding from Phase 0 right now.*
