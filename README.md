# @the-bot-club/bscs

**Bot Squad Command Suite** — CLI for managing fleets of AI coding agents across Docker containers, remote machines, and LLM providers.

```
 ██████╗ ███████╗ ██████╗███████╗
 ██╔══██╗██╔════╝██╔════╝██╔════╝
 ██████╔╝███████╗██║     ███████╗
 ██╔══██╗╚════██║██║     ╚════██║
 ██████╔╝███████║╚██████╗███████║
 ╚═════╝ ╚══════╝ ╚═════╝╚══════╝
  Command your AI fleet.
```

[![CI](https://github.com/thebotclub/bscs/actions/workflows/ci.yml/badge.svg)](https://github.com/thebotclub/bscs/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@the-bot-club/bscs)](https://www.npmjs.com/package/@the-bot-club/bscs)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

---

## What is BSCS?

BSCS lets you spin up, monitor, and orchestrate fleets of AI agents — each running in its own Docker container — across local and remote machines. It provides:

- **Agent lifecycle management** — Create, start, stop, restart, and destroy AI agent containers with role-based defaults
- **Fleet orchestration** — Manage agents across multiple machines via SSH with auto-reconciliation
- **LLM Gateway** — Portkey-inspired proxy with retries, fallback chains, load balancing, and automatic cost logging
- **MCP Server** — Model Context Protocol interface for AI-to-AI fleet control (8 tools)
- **Health monitoring** — Watchdog daemon that auto-restarts unhealthy agents
- **Cost tracking** — Per-agent, per-model spend tracking with daily budgets and alerts
- **Security** — Tribunal integration for coding agents, security auditing, secrets management via 1Password
- **Web dashboard** — Real-time fleet overview with Preact SPA

## Installation

```bash
npm install -g @the-bot-club/bscs
```

Or run from source:

```bash
git clone https://github.com/thebotclub/bscs.git
cd bscs && npm install && npm run build
npm link
```

**Requirements:** Node.js >= 20, Docker (for agent containers)

## Quick Start

```bash
# 1. Check your environment
bscs doctor

# 2. Initialize your fleet
bscs fleet init --name my-fleet --controller localhost

# 3. Create a coding agent with Tribunal protection
bscs agent create my-coder --role coding

# 4. Start the LLM Gateway for cost tracking + retries
bscs gateway start

# 5. Monitor fleet health
bscs fleet status
bscs dashboard
```

---

## Commands

### Environment

| Command | Description |
|---------|-------------|
| `bscs doctor` | Validate environment (Docker, Node.js, 1Password) |
| `bscs doctor --json` | JSON output |
| `bscs --version` | Display version with ASCII art |

### Agent Management

| Command | Description |
|---------|-------------|
| `bscs agent create <name> --role <role>` | Create a new agent container |
| `bscs agent destroy <name>` | Remove an agent container |
| `bscs agent start <name>` | Start a stopped agent |
| `bscs agent stop <name>` | Stop a running agent |
| `bscs agent restart <name>` | Restart an agent |
| `bscs agent status [name]` | Show agent status (all or specific) |
| `bscs agent logs <name>` | Stream agent container logs |
| `bscs agent shell <name>` | Open shell into agent container |

#### Agent Roles

```bash
bscs agent create my-coder --role coding              # Coding agent with Tribunal
bscs agent create thinker --role brain --model claude-opus-4  # Planning agent
bscs agent create reviewer --role review               # Code review agent
bscs agent create monitor --role ops                   # Operations agent
bscs agent create guard --role security                # Security agent
bscs agent create helper --role custom                 # Custom agent
```

| Role | Default Model | Memory | Tribunal |
|------|--------------|--------|----------|
| `coding` | claude-sonnet-4 | 4GB | Yes |
| `brain` | claude-opus-4 | 2GB | No |
| `review` | claude-sonnet-4 | 2GB | No |
| `ops` | claude-haiku-3.5 | 2GB | No |
| `security` | (default) | 2GB | No |
| `custom` | (default) | 2GB | No |

Options: `--image <image>`, `--model <model>`, `--no-start`, `--dry-run`, `--json`

### Fleet Orchestration

| Command | Description |
|---------|-------------|
| `bscs fleet init` | Initialize fleet configuration interactively |
| `bscs fleet status` | Show fleet overview across all machines |
| `bscs fleet reconcile` | Sync running containers to match config |
| `bscs fleet reconcile --dry-run` | Preview changes without applying |
| `bscs fleet watchdog` | Start the health monitoring daemon |
| `bscs fleet watchdog --once` | Run a single health check and exit |
| `bscs fleet import <file>` | Import fleet config from a shell script |

#### Watchdog Daemon

The watchdog monitors agent health and auto-restarts failed containers:

```bash
# Run continuously (default: 30s interval, max 3 restarts per agent)
bscs fleet watchdog

# Custom settings
bscs fleet watchdog --interval 60 --max-restarts 5

# One-off check
bscs fleet watchdog --once
```

### Machine Management

| Command | Description |
|---------|-------------|
| `bscs machine status` | Local machine health |
| `bscs machine bootstrap <host>` | Set up a remote machine with Docker + BSCS |
| `bscs machine add <host>` | Add existing machine to fleet |
| `bscs machine remove <host>` | Remove machine from fleet |

```bash
# Bootstrap a new worker
bscs machine bootstrap mini1 --user hani --role worker

# Preview first
bscs machine bootstrap mini1 --dry-run
```

Options: `--user <user>`, `--port <port>`, `--role <controller|worker|gpu>`, `--dry-run`, `--json`

### LLM Gateway

An OpenAI-compatible proxy that sits between your agents and LLM providers, providing:

- **Retries** with exponential backoff and Retry-After header support
- **Fallback chains** — automatically try the next model when one fails
- **Multi-provider routing** — Anthropic, OpenAI, Ollama, LiteLLM, llama.cpp (Google/Gemini not yet supported)
- **Cost logging** — every request automatically records usage to JSONL
- **Streaming passthrough** for SSE responses

| Command | Description |
|---------|-------------|
| `bscs gateway start` | Start the gateway on port 18999 |
| `bscs gateway start -p 8080` | Custom port |
| `bscs gateway status` | Check if gateway is running |

```bash
# Start the gateway
bscs gateway start

# Configure agents to use it
export OPENAI_BASE_URL=http://127.0.0.1:18999/v1

# Endpoints:
#   POST /v1/chat/completions   — OpenAI-compatible chat API
#   GET  /health                — Health check
```

#### Fallback Chain Example

Configure in `~/.config/bscs/config.json`:

```json
{
  "models": {
    "fallbacks": {
      "coding": ["claude-sonnet-4", "gpt-4o", "gemini-2.5-pro"],
      "brain": ["claude-opus-4", "gpt-4o"]
    }
  }
}
```

When `claude-sonnet-4` fails (rate limit, timeout, server error), the gateway automatically retries with `gpt-4o`, then `gemini-2.5-pro`.

### MCP Server

Start a [Model Context Protocol](https://modelcontextprotocol.io/) server for AI-to-AI fleet control:

```bash
bscs mcp serve
```

Provides 8 tools over stdio JSON-RPC:

| Tool | Description |
|------|-------------|
| `fleet_status` | Get full fleet status |
| `agent_create` | Create a new agent |
| `agent_destroy` | Remove an agent |
| `agent_logs` | Get agent container logs |
| `agent_restart` | Restart an agent |
| `fleet_reconcile` | Compute and apply reconciliation |
| `cost_report` | Generate cost reports |
| `security_audit` | Run security audit |

Add to your Claude Code MCP config (`.claude/mcp.json`):

```json
{
  "mcpServers": {
    "bscs": {
      "command": "bscs",
      "args": ["mcp", "serve"]
    }
  }
}
```

### Cost Tracking

| Command | Description |
|---------|-------------|
| `bscs cost status` | Current daily spend vs budget |
| `bscs cost report` | Today's cost report |
| `bscs cost report --period week` | Weekly report |
| `bscs cost report --by agent` | Breakdown by agent |
| `bscs cost report --by model` | Breakdown by model |
| `bscs cost report --by provider` | Breakdown by provider |
| `bscs cost budget set <amount>` | Set daily budget (USD) |
| `bscs cost budget status` | Show budget status |

Cost data is automatically recorded when using the LLM Gateway. Data stored as JSONL in `~/.config/bscs/costs/`.

### Security

| Command | Description |
|---------|-------------|
| `bscs security audit` | Run security audit on fleet |
| `bscs security baseline` | Check compliance against baseline |

### Secrets Management

Integrated with 1Password CLI (`op`) for secure API key management:

| Command | Description |
|---------|-------------|
| `bscs secrets list` | List configured secrets and their status |
| `bscs secrets health` | Verify all secrets are resolvable |
| `bscs secrets sync` | Sync secrets from 1Password to fleet |

Store API keys as `op://` references in config:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "type": "anthropic",
        "apiKey": "op://Development/Anthropic/api-key",
        "enabled": true
      }
    }
  }
}
```

### Dashboard

| Command | Description |
|---------|-------------|
| `bscs dashboard` | Start web dashboard on :3200 |
| `bscs dashboard --port 8080` | Custom port |
| `bscs dashboard --open` | Open browser automatically |

The dashboard provides:
- Fleet overview with agent status cards
- Per-machine agent breakdown
- Agent detail view with logs
- Real-time updates via SSE

### Configuration

| Command | Description |
|---------|-------------|
| `bscs config show` | Show current configuration |
| `bscs config path` | Show config directory path |
| `bscs config set <key> <value>` | Set a config value |

---

## Configuration

Config stored at `~/.config/bscs/config.json`:

```json
{
  "version": "1.0",
  "fleet": {
    "name": "my-fleet",
    "controller": "mini4"
  },
  "machines": {
    "mini1": {
      "host": "mini1.tailnet.ts.net",
      "user": "hani",
      "role": "worker",
      "port": 22
    }
  },
  "defaults": {
    "image": "ghcr.io/thebotclub/bscs:latest",
    "portRange": { "start": 19000, "end": 19999 }
  },
  "docker": {
    "security": {
      "noNewPrivileges": true,
      "capDropAll": true
    },
    "resources": {
      "coding": { "memory": "4g", "pidsLimit": 512 },
      "brain": { "memory": "2g", "pidsLimit": 128 }
    }
  },
  "models": {
    "defaults": {
      "coding": "claude-sonnet-4",
      "brain": "claude-opus-4",
      "review": "claude-sonnet-4"
    },
    "fallbacks": {
      "coding": ["claude-sonnet-4", "gpt-4o", "gemini-2.5-pro"]
    },
    "providers": {
      "anthropic": {
        "type": "anthropic",
        "apiKey": "op://Development/Anthropic/api-key",
        "enabled": true
      },
      "openai": {
        "type": "openai",
        "apiKey": "op://Development/OpenAI/api-key",
        "enabled": true
      }
    }
  },
  "budget": {
    "daily": 25.00,
    "alertThreshold": 0.8
  }
}
```

## Tribunal Integration

When creating a coding agent (`--role coding`), BSCS automatically:

1. Installs Tribunal via pip/pipx inside the container
2. Creates `.tribunal/config.json` with security rules
3. Configures `.claude/settings.json` with pre/post command hooks

**Tribunal Rules (coding agents):**
- Prevents `rm -rf /`, `sudo`, and other dangerous commands
- Requires approval for `npm publish`, `git push --force`
- Blocks file deletion of critical paths
- Logs all tool usage for auditability

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  bscs CLI                        │
│  doctor | agent | fleet | machine | gateway      │
│  cost | security | secrets | mcp | dashboard     │
├─────────────────────────────────────────────────┤
│               Core Modules                       │
│  agent.ts  fleet.ts  docker.ts  machine.ts       │
│  gateway.ts  cost.ts  watchdog.ts  security.ts   │
│  config.ts  models.ts  secrets.ts  tribunal.ts   │
├─────────────────────────────────────────────────┤
│            Infrastructure                        │
│  Docker (dockerode)  │  SSH (remote machines)    │
│  MCP Server (stdio)  │  HTTP API + SSE           │
│  LLM Gateway (proxy) │  Preact Dashboard         │
└─────────────────────────────────────────────────┘
```

**Tech Stack:**
- **Runtime:** Node.js >= 20, TypeScript 5.7, ESM
- **CLI:** Commander.js with noun-verb subcommands
- **Docker:** dockerode (Unix socket API)
- **Validation:** Zod schemas with TypeScript type inference
- **Logging:** pino (structured JSON, `op://` secret redaction)
- **UI:** Preact + HTM + @preact/signals, esbuild-bundled
- **MCP:** @modelcontextprotocol/sdk (stdio transport)
- **Testing:** Vitest (424 tests, ~2.5s)

## Docker

```bash
# Build
docker build -t bscs .

# Run
docker run bscs doctor
docker run bscs fleet status
```

The Dockerfile uses a multi-stage build (node:22-alpine) with a non-root `bscs` user.

## Development

```bash
# Install dependencies
npm install

# Dev mode with auto-reload
npm run dev

# Build
npm run build

# Lint
npm run lint

# Type check
npm run typecheck

# Run tests
npm test                         # Unit tests (424 tests)
npm run test:integration         # Integration tests (requires Docker)
npm run test:e2e                 # End-to-end tests
npm run test:coverage            # With coverage report

# Link for local CLI testing
npm link
bscs doctor
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error |
| 2 | Partial success (some operations failed) |

## Troubleshooting

<details>
<summary><strong>Docker not running</strong></summary>

```
Error: Docker is not running
```

Start Docker Desktop or the Docker daemon: `sudo systemctl start docker`

</details>

<details>
<summary><strong>Permission denied</strong></summary>

```
Error: permission denied
```

Add your user to the docker group:
```bash
sudo usermod -aG docker $USER
```

</details>

<details>
<summary><strong>Agent already exists</strong></summary>

```
Error: Agent "my-agent" already exists
```

Remove it first: `bscs agent destroy my-agent`

</details>

<details>
<summary><strong>SSH connection failed</strong></summary>

1. Ensure SSH key is configured: `ssh-copy-id user@host`
2. Check host is reachable: `ping host`
3. Verify SSH port: `ssh -p <port> user@host`

</details>

<details>
<summary><strong>No available ports</strong></summary>

Adjust port range in config:
```json
{ "defaults": { "portRange": { "start": 18000, "end": 18999 } } }
```

</details>

<details>
<summary><strong>Gateway returns 502 "All providers failed"</strong></summary>

All models in the fallback chain returned errors. Debug:
```bash
# Check gateway logs
docker logs bscs-gateway --tail 50

# Test individual provider directly
curl -s http://127.0.0.1:18999/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hello"}]}'
```

Common causes:
- Expired or invalid API key in `~/.config/bscs/config.json`
- Provider rate limited (429) — gateway retries 3x with backoff
- Provider endpoint unreachable — check network/DNS

</details>

<details>
<summary><strong>Per-agent cost tracking shows "unknown"</strong></summary>

Agents must send the `x-bscs-agent` header for per-agent cost attribution:
```bash
# In agent config, add the header:
OPENAI_EXTRA_HEADERS='{"x-bscs-agent":"atlas"}'
```

Without this header, costs are logged under agent name `unknown`.

</details>

<details>
<summary><strong>Graceful shutdown takes up to 10 seconds</strong></summary>

The gateway drains in-flight requests before shutting down. `docker restart bscs-gateway` may take up to 10s. This is by design — it prevents request loss.

</details>

## License

Apache-2.0 — See [LICENSE](LICENSE)
