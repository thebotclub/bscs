# BSCS Fleet Operations Design

**Version:** 1.0.0  
**Date:** 2026-03-30  
**Author:** Architecture Research  
**Status:** Design Document — Opinionated, Research-Backed

---

## What This Document Is

This document defines what BSCS **does** — every operation, every lifecycle transition, every observability metric. The interface (CLI, dashboard, API) is secondary. This is about the **verbs**.

BSCS manages 20+ AI agents (OpenClaw instances) across 6 machines (4× Mac Mini M4, 1× Mac Pro Ubuntu, 1× Dell GPU server), connected via Tailscale. Agents run in Docker containers or natively.

---

## Part 1: Research Findings by Capability Area

### 1.1 Agent Orchestration Patterns (from AI frameworks)

**CrewAI** — Role-based multi-agent orchestration
- Operations: create crew, assign agents to crew, define tasks, execute crew (sequential/hierarchical), delegate tasks between agents
- Key insight: **Crews are the unit of work**, not individual agents. A crew defines which agents collaborate on what tasks.
- Process types: Sequential (pipeline), Hierarchical (manager delegates), Consensual
- Agent lifecycle: define → assign to crew → execute → complete/fail
- Lesson for BSCS: Think in terms of agent **groups** and **roles**, not just individual agents

**AutoGen (Microsoft)** — Conversation-based coordination
- Operations: register agent, subscribe to topic, publish message, send direct message, collect results
- Patterns: fan-out (one message → many processors), topic routing (message type → specific agent), direct messaging
- Key insight: **Topic-based pub/sub** for agent coordination. Agents subscribe to message types.
- Runtime manages agent registration, message delivery, and lifecycle
- Lesson for BSCS: Inter-agent communication should be topic-based, not point-to-point

**OpenAI Swarm** — Lightweight handoffs
- Operations: run (execute agent loop), handoff (transfer conversation to another agent), call function
- Key insight: **Handoffs are the primitive.** An agent hands off to another by returning a function that references the target agent.
- Stateless between calls — all state is in the message history
- Context variables passed between agents explicitly
- Lesson for BSCS: Agent handoffs/delegation should be a first-class operation

**LangGraph/LangChain** — State machine orchestration
- Operations: define graph, add nodes (agents), add edges (transitions), compile, invoke, checkpoint, resume
- Key insight: **State graph with checkpoints.** Every agent interaction modifies shared state. Can pause and resume.
- Human-in-the-loop via interrupt nodes
- Lesson for BSCS: Fleet state should be checkpointed. Operations should be resumable after failure.

**Microsoft Agent Design Patterns** — Production guidance
- Levels of complexity: direct model call → single agent with tools → multi-agent orchestration
- Patterns: Sequential, Concurrent (fan-out/fan-in), Group Chat (shared context), Handoff, Magentic (self-organizing)
- Key insight: **Use the lowest complexity that works.** Don't orchestrate when a single agent suffices.
- Lesson for BSCS: Not every agent needs fleet orchestration. Support standalone agents too.

### 1.2 Agent Observability (from AI observability tools)

**AgentOps** — Session-centric agent monitoring
- Operations: init session, track LLM call, record tool usage, end session (success/fail), replay session
- Captures: LLM calls, costs, latency, agent failures, multi-agent interactions, tool usage
- Key insight: **Session replay** — ability to replay exactly what an agent did, step by step
- Spans: session → agent → operation/task → individual LLM calls
- Lesson for BSCS: Every agent session should be traceable. Cost per session, not just per agent.

**Langfuse** — LLM engineering platform
- Operations: create trace, log generation (LLM call), log span (non-LLM work), score trace, manage prompts (version/deploy), run evaluations
- Captures: full request lifecycle, prompt→response pairs, token counts, cost, latency, user feedback
- Key insight: **Prompt management as a first-class concern.** Version, A/B test, deploy prompts without code changes.
- Based on OpenTelemetry for interop
- Lesson for BSCS: Track prompts/system instructions per agent. Know which version is running where.

**Helicone** — LLM proxy with controls
- Operations: proxy LLM calls, track cost, set rate limits, cache responses, log requests, set alerts
- Key insight: **Proxy pattern** — sit between agents and LLM providers to control cost and monitor usage
- Rate limiting per user/agent, request caching, cost alerts
- Lesson for BSCS: Consider a fleet-wide LLM proxy for cost control and unified logging

**Braintrust** — Eval and observability
- Operations: log trace, run eval, manage datasets, manage prompts (version/invoke), set alerts, compare models
- Workflow: instrument → observe → annotate → evaluate → deploy
- Key insight: **Eval-driven development.** Test prompt/model changes against datasets before deploying.
- Lesson for BSCS: Agent config changes should be testable before fleet-wide rollout

### 1.3 Infrastructure Fleet Management (from DevOps tools)

**Ansible/AWX** — Push-based fleet automation
- Operations: run playbook, run ad-hoc command, manage inventory, manage roles/collections, vault encrypt/decrypt
- Model: **Push-based, imperative.** You tell machines what to do. Idempotent modules make it safe to re-run.
- Inventory: static files or dynamic discovery. Groups and host vars.
- Key insight: **Playbooks are the unit of automation.** Named, versioned, parameterized sequences of tasks.
- No agent required on target machines (SSH-based)
- Lesson for BSCS: Fleet-wide operations should be playbook-like: named, logged, resumable

**Puppet/Chef** — Pull-based desired state
- Operations: define desired state (manifests/recipes), apply state, detect drift, report compliance, manage facts
- Model: **Pull-based, declarative.** Agents periodically check in and converge to desired state.
- Key insight: **Drift detection and convergence.** The system continuously pulls toward the declared state.
- Puppet: catalog compilation → apply → report. Chef: recipe → converge → report.
- Lesson for BSCS: Declare what agents SHOULD look like. Detect when they don't match. Auto-converge.

**Fleet (osquery)** — Device management and compliance
- Operations: query hosts (live SQL queries), manage policies (compliance rules), deploy software, manage profiles, track inventory
- Model: **Query-based observability.** Ask questions across your fleet using SQL.
- Key insight: **Live queries** — ask "which machines have X?" and get real-time answers across the fleet
- Policies: define compliance rules, track pass/fail per host
- Lesson for BSCS: Support fleet-wide queries ("which agents use gpt-4o?", "which agents errored today?")

**Nomad (HashiCorp)** — Job scheduling
- Operations: job run, job stop, job plan (dry-run), job status, alloc status, node status, node drain, deployment promote/fail
- Model: **Declarative job scheduling.** Submit job specs, Nomad finds where to run them.
- Key insight: **Deployment strategies** — rolling, canary, blue-green. Plan before apply. Drain nodes gracefully.
- Multi-region, multi-datacenter native
- Lesson for BSCS: Agent placement should be declarable ("run agent X on a machine with GPU")

**Kamal (37signals)** — Simple deploy to servers
- Operations: setup, deploy, redeploy, rollback [VERSION], details, audit, build, proxy manage, lock, prune, remove, secrets manage
- Model: **Imperative deploy.** SSH into servers, manage Docker containers directly.
- Key insight: **Audit log built in.** Every deploy is logged. Rollback by version. Lock to prevent concurrent deploys.
- Options: `--hosts`, `--roles`, `--primary` for targeting specific servers
- Lesson for BSCS: Deploy lock, audit trail, and host/role targeting are essential operations

### 1.4 Container Orchestration (from Docker/K8s)

**Docker Swarm** — Service orchestration
- Operations: service create, service update, service scale, service rollback, service logs, node ls, node update, node drain
- Model: **Declarative desired state.** Define replicas, Docker maintains them. Manager/worker topology.
- Key insight: **Reconciliation loop** — continuously compare actual vs desired state, take corrective action
- Rolling updates with configurable parallelism, delay, failure action (pause/rollback/continue)
- Lesson for BSCS: The reconciliation loop is THE pattern. Declare state → detect drift → converge.

**Kubernetes** — Desired state + self-healing
- Operations: apply (desired state), get (status), describe (details), logs, exec, rollout (status/history/undo), scale, drain, cordon
- Model: **Declarative + reconciliation.** Controllers watch for drift and correct it.
- Key insight: **Probes** — readiness (can it serve traffic?), liveness (is it alive?), startup (has it finished starting?)
- Health is multi-dimensional: a container can be running but not ready or not alive
- Lesson for BSCS: Agent health needs multiple probes. Running ≠ healthy ≠ productive.

**Podman Pods** — Rootless container management
- Operations: pod create, pod start/stop/restart, pod ps, pod logs, pod inspect, pod rm
- Model: **Imperative, rootless.** No daemon. Pods group related containers.
- Lesson for BSCS: Support rootless/daemonless operation for security

---

## Part 2: Complete Operations Catalog

Every operation BSCS should support, organized by domain. Each entry includes scope and safety level.

### 2.1 Agent Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `agent list` | List all agents with status, machine, model, cost | Fleet | Safe |
| `agent status <name>` | Detailed status of one agent (health, uptime, sessions, errors) | Agent | Safe |
| `agent create <name>` | Create a new agent from template or config | Agent | Confirm |
| `agent destroy <name>` | Remove agent entirely (container, workspace, config) | Agent | Destructive |
| `agent start <name>` | Start a stopped agent | Agent | Safe |
| `agent stop <name>` | Gracefully stop an agent | Agent | Confirm |
| `agent restart <name>` | Stop + start an agent | Agent | Confirm |
| `agent logs <name>` | Stream or tail agent logs | Agent | Safe |
| `agent exec <name> <cmd>` | Execute command inside agent's container/environment | Agent | Confirm |
| `agent shell <name>` | Interactive shell into agent's environment | Agent | Confirm |
| `agent inspect <name>` | Full agent configuration dump (model, channels, skills, env) | Agent | Safe |
| `agent edit <name>` | Open agent config in editor, validate, apply | Agent | Confirm |
| `agent clone <name> <new-name>` | Clone agent to same or different machine | Agent | Confirm |
| `agent move <name> <machine>` | Migrate agent to a different machine | Agent | Confirm |
| `agent promote <name>` | Promote canary/staging agent to production | Agent | Confirm |
| `agent diff <name>` | Show config drift (declared vs actual) | Agent | Safe |
| `agent history <name>` | Show config change history for agent | Agent | Safe |
| `agent rollback <name> [version]` | Revert agent to previous config version | Agent | Confirm |

### 2.2 Fleet Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `fleet status` | Overview: all machines, all agents, health summary | Fleet | Safe |
| `fleet query <sql-like>` | Query fleet state ("agents where model=gpt-4o", "agents where error_rate > 5%") | Fleet | Safe |
| `fleet apply <manifest>` | Apply desired state manifest to fleet | Fleet | Confirm |
| `fleet plan <manifest>` | Dry-run: show what `apply` would change without doing it | Fleet | Safe |
| `fleet diff` | Compare declared fleet state vs actual state | Fleet | Safe |
| `fleet converge` | Auto-fix all detected drift | Fleet | Confirm |
| `fleet update <component>` | Update OpenClaw/BSCS/Docker across fleet | Fleet | Confirm |
| `fleet drain <machine>` | Gracefully move all agents off a machine (for maintenance) | Machine | Confirm |
| `fleet undrain <machine>` | Re-enable a drained machine for agent placement | Machine | Safe |
| `fleet audit` | Show log of all fleet operations with who/what/when | Fleet | Safe |
| `fleet lock` | Prevent fleet changes (during maintenance) | Fleet | Confirm |
| `fleet unlock` | Re-enable fleet changes | Fleet | Safe |

### 2.3 Machine Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `machine list` | List all machines with status, agent count, resources | Fleet | Safe |
| `machine status <name>` | Detailed machine status (CPU, memory, disk, network, Docker) | Machine | Safe |
| `machine setup <name>` | Bootstrap a new machine (install deps, configure Docker, join Tailscale) | Machine | Confirm |
| `machine remove <name>` | Remove machine from fleet inventory | Machine | Destructive |
| `machine ssh <name>` | SSH into machine | Machine | Safe |
| `machine exec <name> <cmd>` | Run command on machine | Machine | Confirm |
| `machine update <name>` | Update system packages on machine | Machine | Confirm |
| `machine prune <name>` | Clean up old Docker images, volumes, logs | Machine | Confirm |
| `machine resources <name>` | Show resource utilization breakdown | Machine | Safe |

### 2.4 Config Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `config show [agent\|machine\|fleet]` | Display current configuration | Any | Safe |
| `config validate [file]` | Validate config file against schema | Any | Safe |
| `config diff <a> <b>` | Compare two config files or versions | Any | Safe |
| `config history [agent\|fleet]` | Show config change log | Any | Safe |
| `config export` | Export full fleet config as manifest | Fleet | Safe |
| `config import <manifest>` | Import fleet config from manifest | Fleet | Confirm |
| `config template list` | List available agent templates | Fleet | Safe |
| `config template show <name>` | Show template details | Fleet | Safe |

### 2.5 Secrets Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `secrets list` | List secret keys (not values) per agent/machine | Any | Safe |
| `secrets get <key>` | Retrieve a secret value | Any | Confirm |
| `secrets set <key> <value>` | Set or update a secret | Any | Confirm |
| `secrets rotate <key>` | Rotate a secret (generate new, update all consumers) | Fleet | Confirm |
| `secrets sync` | Push secrets to agents that need them | Fleet | Confirm |
| `secrets audit` | Show secret access log | Fleet | Safe |
| `secrets import <provider>` | Import secrets from 1Password/env/file | Fleet | Confirm |

### 2.6 Deploy Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `deploy <agent>` | Deploy/update agent (build, push, restart) | Agent | Confirm |
| `deploy --all` | Deploy updates to all agents | Fleet | Confirm |
| `deploy --canary <agent>` | Deploy to one instance first, wait for health check | Agent | Confirm |
| `deploy --rollback <agent> [ver]` | Roll back to previous deployment | Agent | Confirm |
| `deploy status` | Show in-progress deployments | Fleet | Safe |
| `deploy history` | Show deployment log | Fleet | Safe |
| `deploy lock` | Prevent deployments | Fleet | Confirm |
| `deploy unlock` | Allow deployments again | Fleet | Safe |

### 2.7 Observability Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `observe dashboard` | Open the web dashboard | Fleet | Safe |
| `observe cost [agent\|machine\|fleet]` | Show token usage and cost breakdown | Any | Safe |
| `observe cost --forecast` | Predict cost based on current usage trends | Fleet | Safe |
| `observe errors [agent]` | Show recent errors, grouped by type | Any | Safe |
| `observe health` | Fleet health summary with alerts | Fleet | Safe |
| `observe metrics <agent>` | Show agent-specific metrics (tokens, latency, sessions) | Agent | Safe |
| `observe trace <session-id>` | Show full trace for a specific session | Agent | Safe |
| `observe alerts list` | List active alerts | Fleet | Safe |
| `observe alerts set <rule>` | Create an alert rule | Fleet | Confirm |
| `observe alerts clear <id>` | Acknowledge/clear an alert | Fleet | Safe |

### 2.8 Doctor/Health Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `doctor` | Run all health checks across fleet | Fleet | Safe |
| `doctor <agent>` | Run health checks for specific agent | Agent | Safe |
| `doctor --fix` | Auto-fix detected issues where safe | Fleet | Confirm |
| `doctor --report` | Generate health report (exportable) | Fleet | Safe |

### 2.9 Tribunal (Governance) Operations

| Command | What It Does | Scope | Safety |
|---------|-------------|-------|--------|
| `tribunal review <agent>` | Evaluate agent performance and behavior | Agent | Safe |
| `tribunal verdict <agent>` | Get pass/warn/fail verdict for agent | Agent | Safe |
| `tribunal history <agent>` | Show past tribunal reviews | Agent | Safe |
| `tribunal policy list` | List governance policies | Fleet | Safe |
| `tribunal policy set <rule>` | Create/update governance policy | Fleet | Confirm |

---

## Part 3: Operational Model Recommendation

### 3.1 Hybrid: Declarative Core + Imperative Overrides

BSCS should be **primarily declarative with imperative escape hatches.**

**Why declarative as default:**
- Puppet/Chef/Kubernetes all prove: desired state + reconciliation is the most reliable model for fleet management
- Configuration drift is inevitable when managing 20+ agents across 6 machines
- Declarative state can be version controlled, diffed, and audited
- Rollback is trivial: apply the previous state file

**Why imperative as escape hatch:**
- Emergency operations (force-stop a runaway agent) can't wait for reconciliation
- Ad-hoc investigation (`agent exec`, `agent shell`, `fleet query`) is inherently imperative
- Some operations are one-shot (prune, drain, setup) and don't fit a desired-state model

**The model:**

```
fleet.yaml (desired state)
    ↓
bscs plan (show changes)
    ↓
bscs apply (execute changes)
    ↓
reconciliation loop (detect drift, alert or auto-fix)
    ↓
bscs status (verify)
```

Imperative commands (`agent restart`, `machine exec`, `fleet drain`) work alongside this and are logged in the audit trail.

### 3.2 Fleet Manifest Format

```yaml
# fleet.yaml — The source of truth
fleet:
  name: botsquad
  tailscale_network: botsquad

machines:
  mini4:
    host: mini4.tail.net
    role: primary
    os: darwin
    arch: arm64
    max_agents: 8
    
  mini-bravo:
    host: mini-bravo.tail.net
    role: worker
    os: darwin
    arch: arm64
    max_agents: 6

  gpu-server:
    host: dell-gpu.tail.net
    role: worker
    os: linux
    arch: amd64
    gpu: true
    max_agents: 4

agents:
  atlas:
    machine: mini4
    runtime: docker
    image: openclaw:latest
    model: anthropic/claude-sonnet-4-20250514
    channels:
      - telegram
      - discord
    skills:
      - github
      - coding-agent
    secrets:
      ANTHROPIC_API_KEY: op://vault/anthropic/key
      TELEGRAM_TOKEN: op://vault/telegram/atlas
    resources:
      memory: 512M
    health:
      check_interval: 60s
      restart_on_failure: true
      max_restart_count: 3

  # ... more agents

defaults:
  runtime: docker
  image: openclaw:latest
  model: anthropic/claude-sonnet-4-20250514
  health:
    check_interval: 60s
    restart_on_failure: true
```

### 3.3 Drift Handling

**Three drift responses:**

1. **Alert only** (default for most config): Detect drift, notify operator, wait for manual action
2. **Auto-converge** (opt-in for safe properties): Automatically fix drift (e.g., restart a crashed agent)
3. **Accept drift** (opt-in for dynamic properties): Some things change at runtime (memory usage, session count) — not drift

**What counts as drift:**
- Agent is declared in manifest but not running → **restart or alert**
- Agent is running but config doesn't match manifest → **alert**
- Agent is running that's NOT in manifest → **alert** (rogue agent)
- Agent health check fails → **auto-restart** (up to max_restart_count), then **alert**
- Machine unreachable → **alert** (can't auto-fix network)

### 3.4 Failure Recovery

| Failure Type | Auto Response | Manual Escalation |
|---|---|---|
| Agent crashes | Restart (up to N times) | Alert after N restarts |
| Agent health check fails | Restart | Alert + tribunal review |
| Machine unreachable | Alert immediately | Offer `fleet drain` for migration |
| LLM API error (rate limit) | Backoff + retry | Alert if persistent |
| LLM API error (auth) | Alert immediately | Requires human (key rotation) |
| Disk full | Alert + auto-prune if enabled | Manual cleanup |
| OOM kill | Restart + alert | Suggest resource adjustment |

### 3.5 What's Automated vs Manual

**Automated:**
- Crash restart (with limits)
- Health monitoring
- Drift detection
- Cost tracking
- Log collection
- Docker image pruning (scheduled)

**Manual (requires human):**
- Agent creation/destruction
- Fleet manifest changes
- Secret rotation
- Machine setup/removal
- Model changes
- Channel configuration
- Cross-machine agent migration

**Configurable:**
- Drift auto-convergence (per property)
- Alert thresholds
- Auto-restart limits
- Cost budget enforcement (alert vs hard-stop)

---

## Part 4: Agent Lifecycle Design

### 4.1 From Idea to Production

```
┌─────────┐     ┌──────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐
│  DEFINE  │ ──→ │ VALIDATE │ ──→ │  DEPLOY  │ ──→ │ MONITOR │ ──→ │  RETIRE  │
│          │     │          │     │          │     │         │     │          │
│ Write    │     │ Config   │     │ Container│     │ Health  │     │ Drain    │
│ agent    │     │ check    │     │ or native│     │ checks  │     │ sessions │
│ config   │     │ Secrets  │     │ Start    │     │ Cost    │     │ Archive  │
│ Choose   │     │ verify   │     │ Health   │     │ Alerts  │     │ Remove   │
│ machine  │     │ Dry-run  │     │ gate     │     │ Tribunal│     │ config   │
└─────────┘     └──────────┘     └──────────┘     └─────────┘     └──────────┘
```

**Step 1: Define**
```bash
bscs agent create myagent --template default --machine mini4
# Creates agent config file, opens in editor
# OR: add to fleet.yaml manifest
```

**Step 2: Validate**
```bash
bscs config validate
bscs fleet plan
# Shows: "Will create agent 'myagent' on mini4 (docker, claude-sonnet-4-20250514)"
# Checks: secrets exist, machine has capacity, no naming conflicts
```

**Step 3: Deploy**
```bash
bscs fleet apply
# OR: bscs deploy myagent
# Pulls image, creates container, injects secrets, starts agent
# Waits for health check to pass before reporting success
```

**Step 4: Monitor**
```bash
bscs agent status myagent    # point-in-time
bscs observe metrics myagent  # ongoing metrics
bscs tribunal review myagent  # governance review
```

**Step 5: Retire**
```bash
bscs agent stop myagent       # graceful stop (finish active sessions)
bscs agent destroy myagent    # remove container, workspace (confirms first)
# Agent removed from manifest
```

### 4.2 Updating Agent Config

```bash
# Option A: Edit manifest
vim fleet.yaml
bscs fleet plan        # see what changes
bscs fleet apply       # apply changes (rolling restart if needed)

# Option B: Direct edit
bscs agent edit myagent       # opens config, validates on save
# Triggers restart if model/channels/skills changed
# Hot-reload if only workspace files changed

# Option C: Targeted update
bscs agent set myagent model=anthropic/claude-opus-4-20250514
bscs agent set myagent --add-skill coding-agent
bscs agent set myagent --add-channel discord
```

**Config version control:** Every config change is versioned (git-like). `agent history` shows the log. `agent rollback` reverts.

### 4.3 Cloning and Migration

```bash
# Clone: create identical agent on same or different machine
bscs agent clone atlas atlas-staging --machine mini-bravo
# Copies: config, workspace files, skills
# Does NOT copy: secrets (re-injected), active sessions, memory files

# Move: migrate agent to different machine
bscs agent move atlas --to gpu-server
# 1. Creates new instance on target
# 2. Waits for health check
# 3. Transfers workspace (rsync over Tailscale)
# 4. Stops old instance
# 5. Updates DNS/routing
```

### 4.4 Agent States

```
                    ┌─────────┐
        create ──→  │ CREATED │
                    └────┬────┘
                         │ start
                    ┌────▼────┐
              ┌──── │ STARTING│
              │     └────┬────┘
              │          │ health check passes
              │     ┌────▼────┐
              │     │ RUNNING │ ←── restart
              │     └────┬────┘
              │          │
              │    ┌─────┴──────┐
              │    │            │
         ┌────▼───▼┐    ┌──────▼──┐
         │  FAILED  │    │ STOPPING│
         └────┬─────┘    └────┬────┘
              │               │
              │          ┌────▼────┐
              │          │ STOPPED │
              │          └────┬────┘
              │               │ destroy
              └───────────────▼
                        ┌──────────┐
                        │ DESTROYED│
                        └──────────┘
```

Additional states:
- **DRAINING** — accepting no new sessions, finishing existing ones
- **SICK** — running but health checks failing (the most dangerous state)
- **ORPHANED** — running but not in manifest (rogue)

---

## Part 5: Fleet Intelligence

### 5.1 What BSCS Knows That Individual Agents Don't

| Knowledge | Why It Matters |
|-----------|---------------|
| Total fleet cost per hour/day/month | Budget management across all agents |
| Cost per agent relative to peers | Identify expensive outliers |
| Model usage distribution | Know which models the fleet relies on |
| Machine resource headroom | Know where to place new agents |
| Agent placement constraints | GPU-required agents, geographic requirements |
| Cross-agent error correlation | "All agents on mini4 failing" vs "one agent broken" |
| Fleet-wide config versions | "17 agents on claude-sonnet, 3 still on haiku" |
| Channel coverage | "Discord covered by 5 agents, WhatsApp by 1" |
| Skill distribution | "Only 2 agents have coding-agent skill" |
| Secret expiry dates | "API key for anthropic expires in 3 days" |

### 5.2 Cost Optimization

**Cost tracking:**
- Token usage per agent, per model, per session
- Cost per agent per hour/day/month
- Cost per machine (sum of agents on it)
- Fleet total with trend line

**Cost controls:**
- Budget caps per agent (warn at 80%, hard-stop at 100%)
- Fleet-wide daily/monthly budget
- Model cost comparison: "switching agent X from opus to sonnet saves $Y/day"
- Cost anomaly detection: "agent Y cost spiked 300% in last hour"

**Optimization suggestions:**
```bash
bscs observe cost --optimize
# Output:
# 💰 Cost Optimization Report
# 
# 1. Agent 'researcher' uses claude-opus-4-20250514 but 80% of calls are simple lookups
#    → Suggest: Switch to claude-sonnet-4-20250514, save ~$15/day
#
# 2. Agent 'writer' averages 2 sessions/day, idles 22h
#    → Suggest: Move to on-demand startup, save ~$3/day in container costs
#
# 3. Fleet uses 4 different Anthropic API keys with separate billing
#    → Suggest: Consolidate to single org billing for volume discount
```

### 5.3 Agent Placement

**Placement rules (in fleet manifest):**
```yaml
agents:
  gpu-researcher:
    placement:
      requires: [gpu]          # Must be on a GPU machine
      prefers: [high-memory]   # Prefer high-memory, but not required
      avoids: [primary]        # Don't put on the primary management node
      
  critical-agent:
    placement:
      machine: mini4           # Pin to specific machine
      
  flexible-agent:
    placement:
      auto: true               # BSCS chooses based on current load
```

**Auto-placement algorithm:**
1. Filter machines by hard requirements (GPU, OS, arch)
2. Sort by available resources (memory, CPU headroom)
3. Prefer machines with fewer agents (spread workload)
4. Prefer machines already running similar agents (shared image cache)
5. Respect max_agents limit per machine

### 5.4 Inter-Agent Communication

For BSCS's scope, inter-agent communication is **out of scope for orchestration** but **in scope for observability.** OpenClaw handles agent-to-agent communication through channels. BSCS should:

- Track which agents talk to which agents
- Monitor cross-agent session chains
- Detect communication failures (agent A tries to reach agent B, B is down)
- Provide a topology view ("who talks to whom")

---

## Part 6: Observability Design for AI-Specific Metrics

### 6.1 The Three Pillars for AI Agents

Traditional observability has three pillars: logs, metrics, traces. AI agents add a fourth: **evaluations.**

| Pillar | What It Captures | Examples |
|--------|-----------------|---------|
| **Logs** | Raw event stream | Agent started, received message, called API, sent response |
| **Metrics** | Aggregated measurements | Tokens/hour, cost/day, error rate, latency p50/p95 |
| **Traces** | Request lifecycle | User message → agent processing → LLM calls → tool use → response |
| **Evaluations** | Quality assessment | Tribunal scores, user feedback, self-assessment |

### 6.2 AI-Specific Metrics Catalog

**Token Metrics:**
- `tokens.input` — Input tokens per call/session/agent/fleet
- `tokens.output` — Output tokens per call/session/agent/fleet
- `tokens.total` — Total tokens
- `tokens.cache_hit_rate` — Prompt caching effectiveness

**Cost Metrics:**
- `cost.per_session` — Cost of a single user interaction
- `cost.per_agent.daily` — Daily cost per agent
- `cost.per_machine.daily` — Daily cost per machine
- `cost.fleet.daily` — Fleet-wide daily cost
- `cost.trend` — 7-day cost trend (up/down/stable)
- `cost.forecast.monthly` — Projected monthly cost

**Performance Metrics:**
- `latency.first_token` — Time to first token (responsiveness)
- `latency.full_response` — End-to-end response time
- `latency.tool_call` — Time spent in tool execution
- `latency.llm_call` — Time spent waiting for LLM API

**Health Metrics:**
- `health.status` — Current health state (healthy/degraded/down)
- `health.uptime` — Percentage uptime over period
- `health.restart_count` — Number of restarts in period
- `health.last_seen` — When agent last reported in
- `health.last_response` — When agent last successfully responded to a user

**Activity Metrics:**
- `sessions.active` — Currently active sessions
- `sessions.total.daily` — Total sessions per day
- `sessions.avg_duration` — Average session length
- `messages.in.daily` — Inbound messages per day
- `messages.out.daily` — Outbound messages per day

**Error Metrics:**
- `errors.rate` — Error percentage over period
- `errors.llm_api` — LLM API errors (rate limits, auth, network)
- `errors.tool` — Tool execution errors
- `errors.timeout` — Timeout errors
- `errors.oom` — Out-of-memory events

**Quality Metrics (from Tribunal):**
- `quality.tribunal_score` — Latest tribunal review score
- `quality.user_satisfaction` — User feedback aggregation
- `quality.response_relevance` — Self-assessed response quality

### 6.3 Detecting a "Sick" Agent

A sick agent is **technically running but functionally broken.** This is the hardest failure mode to detect.

**Sick agent indicators:**

| Signal | What It Means | Detection |
|--------|--------------|-----------|
| Running but no responses in 30min | Agent may be hung/deadlocked | `health.last_response` > threshold |
| Error rate suddenly > 50% | Something broke (API key, config, dependency) | `errors.rate` spike detection |
| Response latency 10x normal | Agent overloaded or upstream slow | `latency.full_response` anomaly |
| Token usage drops to near-zero | Agent not making LLM calls (stuck in tool loop?) | `tokens.total` anomaly |
| Memory climbing continuously | Memory leak | `resources.memory` trend |
| Same error repeating in loop | Agent stuck in error-retry cycle | Log pattern detection |
| Docker: healthy but agent: unresponsive | Container fine, application broken | Application-level health check (not just container) |

**Health check levels:**

1. **Container alive** — is the Docker container running? (necessary but not sufficient)
2. **Process running** — is the OpenClaw process alive inside the container?
3. **Gateway responsive** — does the OpenClaw gateway respond to HTTP health check?
4. **Agent functional** — can the agent process a test message? (full integration check)
5. **Agent productive** — has the agent successfully handled a real user message recently?

BSCS should check all five levels, escalating alerts as deeper checks fail.

### 6.4 Alerting Rules

```yaml
# Example alert configuration
alerts:
  agent_down:
    condition: health.status == "down"
    for: 2m
    severity: critical
    action: restart + notify
    
  high_cost:
    condition: cost.per_agent.daily > $10
    severity: warning
    action: notify
    
  high_error_rate:
    condition: errors.rate > 20%
    for: 5m
    severity: critical
    action: notify
    
  sick_agent:
    condition: health.last_response > 30m AND health.status == "healthy"
    severity: critical
    action: restart + tribunal_review + notify
    
  cost_anomaly:
    condition: cost.per_agent.hourly > 3x rolling_avg
    severity: warning
    action: notify
    
  fleet_budget:
    condition: cost.fleet.daily > $50
    severity: critical
    action: notify (+ optional: stop non-essential agents)
```

---

## Part 7: Security & Compliance

### 7.1 Audit Trail

Every mutating operation is logged:

```json
{
  "timestamp": "2026-03-30T12:00:00Z",
  "operation": "agent.restart",
  "target": "atlas",
  "initiator": "hani@cli",
  "machine": "mini4",
  "reason": "manual restart via CLI",
  "result": "success",
  "duration_ms": 3400
}
```

`bscs fleet audit` shows this log. Filterable by time, operation, agent, initiator.

### 7.2 Secret Management

**Integration with 1Password:**
- Secrets referenced in config as `op://vault/item/field`
- BSCS resolves at deploy time, injects into environment
- Secrets never stored in BSCS config files
- `bscs secrets sync` re-injects from 1Password to running agents

**Secret rotation workflow:**
```bash
bscs secrets rotate ANTHROPIC_API_KEY
# 1. Reads new key from 1Password
# 2. Updates all agents that use this key
# 3. Restarts affected agents (rolling, not all at once)
# 4. Verifies each agent works with new key
# 5. Logs the rotation in audit trail
```

### 7.3 Agent Isolation

| Level | Description | When to Use |
|-------|------------|-------------|
| **Container** (default) | Agent runs in Docker container. Network, filesystem, process isolation. | Most agents |
| **Container + network policy** | Container with restricted network access (only Tailscale + LLM APIs) | Security-sensitive agents |
| **Native** | Agent runs directly on host OS. Shares filesystem and network. | Development or when Docker overhead matters |

### 7.4 AgentGuard Integration

AgentGuard (external security service) provides:
- **Policy enforcement:** Define what agents can/cannot do
- **Content filtering:** Block harmful outputs
- **Rate limiting:** Per-agent, per-channel limits

BSCS integration:
```bash
bscs agent set myagent --agentguard-policy strict
bscs tribunal review myagent --include-agentguard  # Include AgentGuard violations
bscs observe errors myagent --type agentguard      # Show policy violations
```

---

## Part 8: Priority Matrix

### Phase 1: Foundation (Build First)
*These are blocking — nothing else works without them.*

| Capability | Why First |
|-----------|-----------|
| `agent list/status/start/stop/restart` | Basic agent lifecycle — the absolute minimum |
| `machine list/status` | Know what you're working with |
| `fleet status` | Single view of the whole fleet |
| `agent logs` | Can't debug without logs |
| `config validate` | Catch errors before they break things |
| Agent health checks (levels 1-3) | Know when things break |
| Audit trail | Log everything from day one |

### Phase 2: Operations (Build Second)
*These make BSCS actually useful for daily management.*

| Capability | Why Second |
|-----------|-----------|
| `agent create/destroy` | Agent lifecycle management |
| `deploy` with rollback | Safe deployment workflow |
| `secrets` integration (1Password) | Proper secret management |
| `agent edit/set` | Config changes without manual file editing |
| `observe cost` | Know what you're spending |
| `doctor` health checks | Automated problem detection |
| Fleet manifest (`fleet.yaml`) | Declarative state definition |

### Phase 3: Intelligence (Build Third)
*These make BSCS smart.*

| Capability | Why Third |
|-----------|-----------|
| `fleet plan/apply/diff` | Declarative fleet management |
| Drift detection + convergence | Self-healing fleet |
| `fleet query` | Ad-hoc fleet interrogation |
| `observe metrics` full suite | AI-specific observability |
| Sick agent detection | Catch functional failures |
| Cost optimization suggestions | Save money |
| `agent clone/move` | Agent mobility |

### Phase 4: Governance (Build Fourth)
*These make BSCS trustworthy.*

| Capability | Why Fourth |
|-----------|-----------|
| `tribunal` integration | Automated agent evaluation |
| Alert rules + notification | Proactive monitoring |
| `fleet drain/undrain` | Maintenance operations |
| Auto-placement | Intelligent agent scheduling |
| AgentGuard integration | Security policy enforcement |
| Config versioning + rollback | Full change management |

---

## Part 9: Mapping to CLI Commands and Dashboard Screens

### CLI Command Tree

```
bscs
├── agent
│   ├── list           # List all agents
│   ├── status <name>  # Agent details
│   ├── create <name>  # Create agent
│   ├── destroy <name> # Remove agent
│   ├── start <name>   # Start agent
│   ├── stop <name>    # Stop agent
│   ├── restart <name> # Restart agent
│   ├── logs <name>    # View/stream logs
│   ├── exec <name>    # Run command in agent
│   ├── shell <name>   # Interactive shell
│   ├── inspect <name> # Full config dump
│   ├── edit <name>    # Edit config
│   ├── set <name>     # Update single property
│   ├── clone <name>   # Clone agent
│   ├── move <name>    # Migrate agent
│   ├── diff <name>    # Config drift
│   ├── history <name> # Config changelog
│   └── rollback <name># Revert config
├── fleet
│   ├── status         # Fleet overview
│   ├── plan           # Dry-run manifest
│   ├── apply          # Apply manifest
│   ├── diff           # Declared vs actual
│   ├── converge       # Fix drift
│   ├── query          # Query fleet state
│   ├── update         # Update components
│   ├── drain          # Drain machine
│   ├── undrain        # Undrain machine
│   ├── audit          # Operation log
│   ├── lock           # Lock fleet
│   └── unlock         # Unlock fleet
├── machine
│   ├── list           # List machines
│   ├── status <name>  # Machine details
│   ├── setup <name>   # Bootstrap machine
│   ├── remove <name>  # Remove from fleet
│   ├── ssh <name>     # SSH into machine
│   ├── exec <name>    # Run command
│   ├── update <name>  # Update packages
│   ├── prune <name>   # Clean up
│   └── resources      # Resource breakdown
├── config
│   ├── show           # Show config
│   ├── validate       # Validate config
│   ├── diff           # Compare configs
│   ├── history        # Change log
│   ├── export         # Export manifest
│   ├── import         # Import manifest
│   └── template       # Manage templates
├── secrets
│   ├── list           # List keys
│   ├── get            # Get value
│   ├── set            # Set value
│   ├── rotate         # Rotate secret
│   ├── sync           # Push to agents
│   ├── audit          # Access log
│   └── import         # Import from provider
├── deploy
│   ├── <agent>        # Deploy agent
│   ├── status         # In-progress deploys
│   ├── history        # Deploy log
│   ├── lock           # Lock deploys
│   └── unlock         # Unlock deploys
├── observe
│   ├── dashboard      # Open web UI
│   ├── cost           # Cost breakdown
│   ├── errors         # Error summary
│   ├── health         # Health summary
│   ├── metrics        # Agent metrics
│   ├── trace          # Session trace
│   └── alerts         # Alert management
├── doctor             # Health checks
└── tribunal           # Governance
```

### Dashboard Screens (derived from operations)

The dashboard is NOT a separate design — it's a visual representation of the same operations:

| Screen | Backed By | Primary Operations |
|--------|----------|-------------------|
| **Fleet Overview** | `fleet status` | Status of all machines + agents, health indicators, cost summary |
| **Agent Detail** | `agent status` + `observe metrics` | Single agent deep-dive: health, metrics, logs, config, history |
| **Machine Detail** | `machine status` + `machine resources` | Machine health, resource usage, agent list |
| **Cost Center** | `observe cost` | Cost breakdown by agent/machine/model, trends, forecasts, optimization suggestions |
| **Deploy Center** | `deploy status` + `deploy history` | Active deployments, deploy log, rollback buttons |
| **Fleet Config** | `config show` + `fleet diff` | Manifest editor, drift visualization, plan preview |
| **Alerts & Health** | `observe alerts` + `doctor` | Active alerts, health check results, auto-fix actions |
| **Audit Log** | `fleet audit` | Searchable/filterable operation log |
| **Tribunal** | `tribunal review` | Agent governance scores, violation history, policy management |
| **Topology** | `fleet status` (enriched) | Visual map: machines → agents → channels, with health colors |

**Key principle:** Every dashboard action maps to a CLI command. The dashboard doesn't have operations the CLI doesn't have. They are two interfaces to the same engine.

---

## Summary: What BSCS Actually Does

BSCS is a **fleet operations engine** for AI agents. In one sentence:

> **BSCS declares what your fleet of AI agents should look like, detects when reality drifts from that declaration, and gives you the tools to converge — or does it automatically.**

The core loop:
1. **Declare** desired state (fleet manifest)
2. **Deploy** agents to machines
3. **Monitor** health, cost, performance, quality
4. **Detect** drift, failures, anomalies
5. **Respond** — auto-heal what's safe, alert on what's not
6. **Audit** — every operation logged, every config change versioned

It's Kubernetes concepts applied to AI agents, with Kamal's simplicity, Ansible's fleet targeting, AgentOps' observability, and Langfuse's AI-specific metrics — without requiring any of those tools.
