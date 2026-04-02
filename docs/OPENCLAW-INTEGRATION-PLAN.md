# OpenClaw Integration Plan

> BSCS → OpenClaw fleet management for mixed Docker + native deployments.

## Current State

What BSCS already handles that works as-is for OpenClaw:

| Capability | Status | Notes |
|---|---|---|
| `runtime: 'native'` in schema | ✅ Working | Fleet status + doctor already branch on it |
| Native health probes (curl /healthz) | ✅ Working | fleet.ts L209, doctor.ts L271 |
| `op://` secret resolution | ✅ Working | secrets.ts resolves via `op read` |
| Workspace templates (SOUL.md, AGENTS.md, MEMORY.md) | ✅ Working | templates/workspace.ts |
| Model fallback chains | ✅ Working | models.fallbacks in config |
| Per-agent model overrides | ✅ Working | models.agents in config |
| LLM gateway proxy | ✅ Working | Fully provider-agnostic |
| Cost tracking | ✅ Working | Model-based, runtime-independent |
| OpenClaw version check in doctor | ✅ Working | doctor.ts checkOpenClawVersion |
| Docker container lifecycle | ✅ Working | But hardcoded inline in agent.ts |
| Watchdog | ❌ Docker-only | Calls listBscsContainers() directly |
| Reconciliation | ❌ Docker-only | computeReconcileChanges() is container-based |
| Agent CRUD (create/destroy/start/stop) | ❌ Docker-only | No runtime dispatch in agent.ts |

---

## Phase 0: Extract AgentRuntime Interface (pure refactor)

**Goal:** Decouple agent lifecycle from Docker without changing behavior. All existing tests pass unchanged.

### 0.1 — Define the AgentRuntime interface

New file: `src/core/runtime/types.ts`

```typescript
export interface AgentRuntime {
  create(name: string, config: AgentRuntimeConfig): Promise<CreateResult>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  destroy(name: string, opts?: { force?: boolean; volumes?: boolean }): Promise<void>;
  status(name: string): Promise<RuntimeStatus>;
  logs(name: string, opts?: { tail?: number; follow?: boolean }): ChildProcess;
  shell(name: string): ChildProcess;
  list(): Promise<RuntimeStatus[]>;
  healthCheck(name: string): Promise<HealthCheckResult>;
  isAvailable(): Promise<boolean>;
}

export interface AgentRuntimeConfig {
  image?: string;
  ports?: { gateway?: number; remote?: number };
  env?: Record<string, string>;
  volumes?: Record<string, string>;
  memory?: string;
  pidsLimit?: number;
}

export interface RuntimeStatus {
  name: string;
  status: 'running' | 'stopped' | 'created' | 'missing' | 'unknown';
  containerId?: string;
  image?: string;
  ports?: { gateway?: number; remote?: number };
}

export interface CreateResult {
  name: string;
  id?: string;
  status: string;
}
```

### 0.2 — Extract DockerRuntime from existing code

New file: `src/core/runtime/docker.ts`

Move the Docker-specific logic from `agent.ts` into a class implementing `AgentRuntime`:
- `create()` → wraps `pullImage()` + `createContainer()` + `startContainer()`
- `start()` → wraps `startContainer()`
- `stop()` → wraps `stopContainer()`
- `destroy()` → wraps `stopContainer()` + `removeContainer()`
- `status()` → wraps `getContainer()`
- `logs()` → wraps `spawn('docker', ['logs', ...])`
- `shell()` → wraps `spawn('docker', ['exec', ...])`
- `list()` → wraps `listBscsContainers()`
- `healthCheck()` → wraps Docker inspect (from watchdog.ts)
- `isAvailable()` → wraps `isDockerRunning()`

### 0.3 — Add NativeRuntime (extract from fleet.ts/doctor.ts)

New file: `src/core/runtime/native.ts`

The native runtime pattern already exists scattered across fleet.ts and doctor.ts. Consolidate:
- `status()` → `curl -s http://127.0.0.1:{port}/healthz`
- `start()` → `launchctl kickstart gui/$(id -u)/ai.openclaw.{name}`
- `stop()` → `launchctl kill SIGTERM gui/$(id -u)/ai.openclaw.{name}`
- `healthCheck()` → same curl probe
- `isAvailable()` → check that `openclaw` CLI exists in PATH
- `logs()` → `openclaw gateway logs` or system log

### 0.4 — Runtime resolver + rewire agent.ts

New file: `src/core/runtime/index.ts`

```typescript
export function getRuntime(runtimeType: string): AgentRuntime {
  switch (runtimeType) {
    case 'docker': return new DockerRuntime();
    case 'native': return new NativeRuntime();
    default: throw new Error(`Unknown runtime: ${runtimeType}`);
  }
}
```

Refactor `agent.ts` functions to use `getRuntime(agentConfig.runtime)` instead of calling Docker functions directly. The public API (`createAgent`, `destroyAgent`, etc.) stays identical.

### 0.5 — Rewire watchdog.ts

Change `checkHealth()` to iterate config agents and dispatch to `runtime.healthCheck()` instead of listing Docker containers first.

Before:
```
containers = listBscsContainers()  →  match against config
```

After:
```
for agent in config.agents:
  runtime = getRuntime(agent.runtime)
  result = runtime.healthCheck(agent.name)
```

### 0.6 — Rewire fleet.ts reconciliation

Change `computeReconcileChanges()` to dispatch per-runtime:
- Docker agents: compare containers vs config (existing logic)
- Native agents: compare healthz response vs config (new)

### Validation

- All existing unit tests pass (the public API hasn't changed)
- `bscs fleet status` works for both Docker and native agents
- `bscs doctor` works unchanged
- `bscs agent create/destroy/start/stop` works for Docker agents

### Files Changed

| File | Change |
|---|---|
| `src/core/runtime/types.ts` | NEW — interface definitions |
| `src/core/runtime/docker.ts` | NEW — extracted from agent.ts + docker.ts |
| `src/core/runtime/native.ts` | NEW — extracted from fleet.ts + doctor.ts |
| `src/core/runtime/index.ts` | NEW — resolver |
| `src/core/agent.ts` | MODIFY — dispatch through runtime interface |
| `src/core/watchdog.ts` | MODIFY — dispatch through runtime interface |
| `src/core/fleet.ts` | MODIFY — reconciliation dispatch |
| `src/core/docker.ts` | UNCHANGED — still exports low-level Docker functions |

---

## Phase 1: OpenClaw Runtime + Schema Extension

**Goal:** `bscs fleet status`, `bscs agent start/stop`, `bscs doctor`, and watchdog work for OpenClaw agents on the shared gateway.

### 1.1 — Extend AgentConfig schema

In `src/util/types.ts`:

```typescript
runtime: z.enum(['docker', 'native', 'openclaw']).default('docker'),

// Add openclaw-specific config block
openclaw: z.object({
  gatewayUrl: z.string().default('http://127.0.0.1:18777'),
  workspace: z.string().optional(),       // ~/.openclaw/workspace-<name>
  channels: z.array(z.object({
    type: z.enum(['telegram', 'discord']),
    accountId: z.string(),
  })).optional(),
  model: z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).optional(),
  }).optional(),
  skills: z.array(z.string()).optional(),
  cronJobs: z.array(z.object({
    id: z.string(),
    cron: z.string(),
    message: z.string(),
    channel: z.string().optional(),
  })).optional(),
  identity: z.object({
    name: z.string(),
    emoji: z.string(),
  }).optional(),
}).optional(),
```

Key changes from original design:
- `telegramAccountId` → `channels[]` array (supports Discord too)
- `gatewayPort` → `gatewayUrl` (full URL is more flexible for remote gateways)
- `cronJobs` is inline objects, not just IDs (self-contained config)

### 1.2 — Implement OpenClawRuntime

New file: `src/core/runtime/openclaw.ts`

The OpenClaw runtime manages agents through the `openclaw` CLI and gateway HTTP API:

```
create(name)    →  openclaw agents add <name> --workspace ...
                   + generate workspace files (SOUL.md, AGENTS.md)
                   + openclaw agents bind --agent <name> --bind <channel>:<accountId>
start(name)     →  openclaw config set agent.<name>.enabled true
                   (shared gateway — no container to start)
stop(name)      →  openclaw config set agent.<name>.enabled false
restart(name)   →  stop + start (or openclaw gateway restart if needed)
destroy(name)   →  openclaw agents delete <name>
                   + unbind all channels
                   + cleanup workspace
status(name)    →  GET gatewayUrl/healthz → parse per-agent status
                   OR openclaw agents list --json → find agent
logs(name)      →  openclaw gateway logs --agent <name>
shell(name)     →  not applicable (throw "OpenClaw agents don't have shells")
list()          →  openclaw agents list --json
healthCheck()   →  GET gatewayUrl/healthz + GET gatewayUrl/readyz
isAvailable()   →  which openclaw + GET gatewayUrl/healthz
```

Prerequisite check: `isAvailable()` verifies both the CLI binary and gateway reachability. Used by doctor and before any operation.

### 1.3 — Wire into runtime resolver

```typescript
// src/core/runtime/index.ts
case 'openclaw': return new OpenClawRuntime();
```

### 1.4 — Extend doctor.ts

Add OpenClaw-runtime agent checks:
- Gateway reachability (HTTP probe)
- Agent registered in gateway (agent list)
- Channel bindings active
- Workspace files exist

### 1.5 — OpenClaw defaults in config.ts

```typescript
openclaw: {
  gatewayUrl: 'http://127.0.0.1:18777',
  workspaceBase: '~/.openclaw/workspaces',
},
```

### Validation

- `bscs fleet status` shows OpenClaw agents with correct status from gateway healthz
- `bscs doctor` checks OpenClaw gateway + per-agent registration
- `bscs agent start/stop <name>` enables/disables agent in gateway config
- Watchdog detects unhealthy OpenClaw agents via HTTP probe
- Existing Docker + native agents still work unchanged

### Files Changed

| File | Change |
|---|---|
| `src/util/types.ts` | MODIFY — add 'openclaw' to runtime enum, add openclaw config block |
| `src/core/runtime/openclaw.ts` | NEW — OpenClawRuntime class |
| `src/core/runtime/index.ts` | MODIFY — add openclaw case |
| `src/core/config.ts` | MODIFY — add openclaw defaults |
| `src/core/doctor.ts` | MODIFY — add openclaw agent checks |
| `src/templates/workspace.ts` | MODIFY — add OpenClaw-flavored workspace generation |

---

## Phase 2: Fleet Import + Channel Management

**Goal:** Import existing OpenClaw agents into BSCS config. Manage channel bindings through BSCS.

### 2.1 — Fleet import from live gateway

New command: `bscs fleet import --from-openclaw [gatewayUrl]`

Queries `openclaw agents list --json` and populates `config.agents` with:
- Agent name, role (inferred from workspace SOUL.md or set to 'custom')
- Runtime: 'openclaw'
- Gateway URL
- Workspace path
- Current channel bindings
- Current model assignment
- Cron jobs

This is the migration path — run once to bring existing 8 agents under BSCS management.

### 2.2 — Channel bind/unbind commands

```
bscs agent bind <name> --channel telegram --account-id <id>
bscs agent unbind <name> --channel telegram
```

Calls `openclaw agents bind/unbind` under the hood and updates config.

### 2.3 — Agent create for OpenClaw

Extend `bscs agent create` to accept `--runtime openclaw`:

```
bscs agent create myagent --role coding --runtime openclaw \
  --model claude-sonnet-4 \
  --bind telegram:12345
```

This calls `OpenClawRuntime.create()` which:
1. Runs `openclaw agents add`
2. Generates workspace from templates (SOUL.md with role-appropriate content)
3. Binds channels
4. Sets model config
5. Saves to BSCS config

### Validation

- `bscs fleet import --from-openclaw` discovers all 8 running agents
- `bscs fleet status` shows them all with live status
- `bscs agent bind/unbind` modifies channel bindings
- `bscs agent create --runtime openclaw` creates new agents

### Files Changed

| File | Change |
|---|---|
| `src/core/fleet.ts` | MODIFY — add importFromOpenClaw() |
| `src/cli/fleet/index.ts` | MODIFY — add import subcommand |
| `src/cli/agent/index.ts` | MODIFY — add bind/unbind subcommands, --runtime flag on create |
| `src/core/agent.ts` | MODIFY — pass runtime-specific options through to OpenClawRuntime |

---

## Phase 3: Reconciliation + Watchdog for Shared Gateway

**Goal:** BSCS keeps the shared gateway in sync with desired state and auto-recovers from failures.

### 3.1 — OpenClaw reconciliation semantics

For `runtime: 'openclaw'`, reconciliation means:

| Desired State | Actual State | Action |
|---|---|---|
| Agent in config | Not in gateway agent list | `openclaw agents add` + bind channels |
| Agent enabled | Gateway reports agent inactive | `openclaw config set agent.X.enabled true` |
| Agent in config | Channel binding mismatch | Rebind channels |
| Agent NOT in config | In gateway agent list | Flag as orphaned (don't auto-delete) |
| Model mismatch | Config ≠ gateway | `openclaw config set` to update model |

### 3.2 — Shared gateway watchdog

The gateway is a single process hosting all agents. Watchdog behavior:

1. **Gateway-level health:** `GET /healthz` — if gateway is down, all agents are down. Alert immediately. Auto-restart via `openclaw gateway restart` or `launchctl kickstart`.
2. **Per-agent health:** `GET /readyz` or `openclaw agents list --json` — check individual agent status within the gateway.
3. **Blast radius handling:** If gateway restart is needed, log that all N agents will be affected. Cooldown should be longer for gateway-level restarts (all agents vs one container).

### 3.3 — Extend fleet reconcile command

`bscs fleet reconcile` already does dry-run + apply. Extend it:
- Docker agents: existing container-based reconciliation
- Native agents: check process health, restart via launchctl
- OpenClaw agents: compare config vs gateway state, apply config changes

### Validation

- `bscs fleet reconcile` shows OpenClaw-specific changes (agent missing from gateway, channel mismatch, model drift)
- `bscs fleet reconcile --apply` fixes drift
- Watchdog auto-restarts gateway when /healthz fails
- Watchdog doesn't restart gateway repeatedly during cooldown

### Files Changed

| File | Change |
|---|---|
| `src/core/fleet.ts` | MODIFY — reconciliation for openclaw runtime |
| `src/core/watchdog.ts` | MODIFY — gateway-level + per-agent health for openclaw |
| `src/core/runtime/openclaw.ts` | MODIFY — add reconcile helpers (listAgents, getBindings, etc.) |

---

## Phase 4: MCP Tools for AI-to-AI Fleet Control

**Goal:** An agent can manage other OpenClaw agents through MCP tools.

### 4.1 — Extend existing MCP tools with runtime awareness

The existing tools (`agent_create`, `agent_destroy`, `agent_restart`, `fleet_status`, `fleet_reconcile`) already work through the runtime interface after Phase 0. They naturally support OpenClaw agents. Add the `runtime` parameter to `agent_create`:

```typescript
server.tool('agent_create', {
  name: z.string(),
  role: z.enum([...]),
  runtime: z.enum(['docker', 'native', 'openclaw']).optional(),
  model: z.string().optional(),
  channels: z.array(...).optional(),  // for openclaw
});
```

### 4.2 — New OpenClaw-specific MCP tools

These are genuinely new capabilities, not runtime variants of existing ones:

| Tool | Parameters | Description |
|---|---|---|
| `agent_bind` | name, channel (telegram\|discord), accountId | Bind agent to messaging channel |
| `agent_unbind` | name, channel | Unbind agent from channel |
| `cron_add` | agentName, cron, message, channel? | Create scheduled job |
| `cron_remove` | agentName, cronId | Remove scheduled job |
| `cron_list` | agentName? | List cron jobs |
| `agent_config_set` | agentName, path, value | Set OpenClaw config value |
| `secrets_audit` | agentName? | Audit secret references |

### Validation

- An agent can call `fleet_status` and see all agents across runtimes
- An agent can call `agent_create` with `runtime: 'openclaw'` to create a new OpenClaw agent
- An agent can call `agent_bind` to connect another agent to Telegram
- An agent can call `cron_add` to schedule tasks for other agents

### Files Changed

| File | Change |
|---|---|
| `src/mcp/server.ts` | MODIFY — extend agent_create params, add new tools |
| `src/core/agent.ts` | MODIFY — add bind/unbind/configSet operations |

---

## Phase 5: Cron, Skills, and Full Orchestration

**Goal:** BSCS manages the full OpenClaw agent lifecycle including scheduling, skills, and identity.

### 5.1 — Cron job management

```
bscs agent cron add <name> --cron "0 9 * * *" --message "Good morning check-in" --channel telegram
bscs agent cron list [name]
bscs agent cron remove <name> <cronId>
```

Backed by `openclaw config set` for the cron configuration. BSCS stores the cron definitions in its config for reconciliation — if they drift from the gateway, `bscs fleet reconcile` corrects them.

### 5.2 — Skills inventory

Track per-agent skills in config:

```json
{
  "openclaw": {
    "skills": ["code-review", "github-pr", "jira-lookup", "web-search"]
  }
}
```

Commands:
```
bscs agent skills list <name>
bscs agent skills add <name> <skill>
bscs agent skills remove <name> <skill>
```

### 5.3 — Identity management

Agent identity (name, emoji) stored in config and synced to gateway:

```
bscs agent identity set <name> --display-name "Atlas 🗺️"
```

### 5.4 — Dashboard integration

The existing dashboard renders agent status from `getFleetStatus()`. After Phase 0, this already works for all runtimes. In Phase 5, extend the dashboard to show:
- Channel bindings (which agent is on which Telegram/Discord)
- Cron schedules (next run time)
- Skills inventory
- Model assignment + fallback chain

### Validation

- `bscs agent cron add/list/remove` works
- `bscs fleet reconcile` detects cron drift and corrects it
- Dashboard shows full agent detail for OpenClaw agents
- Skills are tracked and visible

### Files Changed

| File | Change |
|---|---|
| `src/cli/agent/index.ts` | MODIFY — add cron, skills, identity subcommands |
| `src/core/agent.ts` | MODIFY — add cron/skills/identity operations |
| `src/core/runtime/openclaw.ts` | MODIFY — cron/skills/identity via openclaw CLI |
| `src/util/types.ts` | MODIFY — cronJobs and skills already in schema from Phase 1 |
| `src/dashboard/server.ts` | MODIFY — serve extended agent data |
| `src/ui/components/AgentTable.ts` | MODIFY — display channels, cron, skills |

---

## Execution Order and Dependencies

```
Phase 0 ─── Pure refactor, zero new features
  │         Extract runtime interface, rewire agent.ts + watchdog + fleet
  │         Prerequisite for everything else
  │
Phase 1 ─── OpenClawRuntime + schema
  │         Agents show up in fleet status, doctor, watchdog
  │         Can start/stop agents via BSCS
  │
Phase 2 ─── Import existing fleet + channel management
  │         This is where BSCS starts managing your real 8 agents
  │         Run once: bscs fleet import --from-openclaw
  │
Phase 3 ─── Reconciliation + auto-recovery
  │         BSCS keeps fleet in sync, restarts failures
  │         Watchdog monitors gateway health
  │
Phase 4 ─── MCP tools
  │         AI-to-AI fleet control
  │         Agents can manage each other
  │
Phase 5 ─── Full orchestration
            Cron, skills, identity, dashboard
```

Phases 4 and 5 are independent of each other and can be done in either order.

---

## Per-Agent Container Mode (Future)

Not in this plan — add later when you want isolated failure domains:

- Each agent gets its own Docker container running `openclaw gateway`
- BSCS uses DockerRuntime underneath but with OpenClaw config generation
- Lets you spread agents across mini1-4
- Schema: `runtime: 'openclaw'` + `openclaw.mode: 'shared' | 'isolated'`
- The isolated mode is a DockerRuntime + OpenClaw config template, not a new runtime

---

## Testing Strategy

Each phase has its own test layer:

| Phase | Test Type | What |
|---|---|---|
| 0 | Unit | DockerRuntime and NativeRuntime pass all existing agent/watchdog/fleet tests |
| 0 | Unit | Runtime resolver returns correct type |
| 1 | Unit | OpenClawRuntime with mocked CLI exec + HTTP |
| 1 | Integration | Against local openclaw gateway (if available) |
| 2 | Integration | Import from live gateway, verify config |
| 3 | Unit | Reconciliation diff computation for openclaw agents |
| 4 | Unit | MCP tool registration + parameter validation |
| 5 | Unit | Cron/skills CRUD operations |

Mock strategy: OpenClawRuntime needs injectable exec and HTTP functions (same pattern as `setDocker()` in docker.ts). Add `setExecCommand()` and `setHttpClient()` for testing.

---

## What You Get at Each Phase

| Phase | You can do this |
|---|---|
| After 0 | Nothing new visible — but the code is refactored and ready |
| After 1 | `bscs fleet status` shows OpenClaw agents. `bscs doctor` checks gateway. Watchdog monitors gateway health |
| After 2 | **All 8 agents under BSCS management.** `bscs fleet status` is your single pane of glass. You can bind/unbind channels |
| After 3 | BSCS auto-recovers from gateway crashes. `bscs fleet reconcile` fixes drift. You stop manually managing agent config |
| After 4 | Your agents can manage each other. An ops agent can restart a coding agent via MCP |
| After 5 | Full lifecycle management — cron scheduling, skills, identity — all through BSCS |

---
---

# Work Packages — Subcontractor Assignments

> PM workflow per ticket: **Develop → Code Review → Architecture Validation → Test**
>
> Every ticket has a single owner, concrete deliverables, acceptance criteria,
> and gates that must pass before the ticket is done.

## Conventions

- **Branch naming:** `phase-N/WP-XX-short-desc` (e.g. `phase-0/WP-01-runtime-interface`)
- **PR rule:** Every PR requires passing `npm test`, `npm run typecheck`, `npm run lint` before review
- **Review rule:** Reviewer is a different person than the developer. Reviewer checks code quality, test coverage, and adherence to the interface contract
- **Arch validation:** PM (you) validates that the work fits the overall design — no scope drift, no broken contracts, no over-engineering
- **Test gate:** All existing tests pass (`vitest run`). New code has unit tests. Integration tests where specified

---

## Phase 0 — Extract AgentRuntime Interface

> **Blocking:** Everything depends on this. No parallel work until Phase 0 is merged.

### WP-01: AgentRuntime Interface Definition

| Field | Value |
|---|---|
| **Assignee** | Dev A (architecture) |
| **Branch** | `phase-0/WP-01-runtime-interface` |
| **Depends on** | Nothing |
| **Deliverables** | `src/core/runtime/types.ts` — AgentRuntime interface, AgentRuntimeConfig, RuntimeStatus, CreateResult, HealthCheckResult types |

**Acceptance Criteria:**
1. Interface covers all lifecycle ops: `create`, `start`, `stop`, `restart`, `destroy`, `status`, `logs`, `shell`, `list`, `healthCheck`, `isAvailable`
2. Types are generic enough for Docker, native, and OpenClaw (no Docker-specific fields leak in)
3. `HealthCheckResult` matches the existing shape in `watchdog.ts` (name, status, restartNeeded, lastCheck, error)
4. `ChildProcess` return type for `logs()` and `shell()` matches existing `agent.ts` signatures
5. File exports only types/interfaces — no implementation
6. `npm run typecheck` passes

**Review checklist:**
- [ ] No Docker-specific types in the interface
- [ ] Compatible with existing `agent.test.ts` mock shapes
- [ ] No optional fields that should be required (or vice versa)

**Arch validation:**
- [ ] Interface can express all operations in `agent.ts` `createAgent/destroyAgent/startAgent/stopAgent/restartAgent/logsAgent/shellAgent`
- [ ] Interface can express the watchdog health check flow
- [ ] Interface can express the fleet reconciliation flow

---

### WP-02: DockerRuntime Extraction

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-0/WP-02-docker-runtime` |
| **Depends on** | WP-01 |
| **Deliverables** | `src/core/runtime/docker.ts` — DockerRuntime class implementing AgentRuntime |

**Acceptance Criteria:**
1. Class wraps all functions from `src/core/docker.ts`: `pullImage`, `createContainer`, `startContainer`, `stopContainer`, `removeContainer`, `getContainer`, `listBscsContainers`, `isDockerRunning`
2. `healthCheck()` wraps the Docker inspect logic currently in `watchdog.ts` (container status check)
3. Has `setDocker()` passthrough for test mocking (delegates to existing `docker.ts` mock point)
4. All method signatures match the AgentRuntime interface from WP-01
5. Container naming convention (`openclaw_${name}`) preserved
6. `npm run typecheck` passes
7. No behavior change — pure extraction

**Review checklist:**
- [ ] No business logic added — just wrapping existing docker.ts calls
- [ ] Error handling preserved (same exceptions thrown)
- [ ] Container name prefix logic matches existing code exactly

**Test requirements:**
- New file: `test/unit/core/runtime/docker.test.ts`
- Tests mirror existing `docker.test.ts` patterns (mock dockerode)
- Minimum: `create`, `start`, `stop`, `destroy`, `status`, `list`, `healthCheck`, `isAvailable`

---

### WP-03: NativeRuntime Extraction

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-0/WP-03-native-runtime` |
| **Depends on** | WP-01 |
| **Deliverables** | `src/core/runtime/native.ts` — NativeRuntime class implementing AgentRuntime |

**Acceptance Criteria:**
1. `status()` does `curl -s http://127.0.0.1:{port}/healthz` — extracted from `fleet.ts` L209-L227
2. `healthCheck()` same probe — extracted from `doctor.ts` L271-L282
3. `start()` does `launchctl kickstart` — extracted from `doctor.ts` fix command pattern
4. `stop()` does `launchctl kill SIGTERM`
5. `shell()` throws `UserError('Native agents do not support shell access')`
6. `logs()` does `openclaw gateway logs` or reads system log
7. `isAvailable()` checks `which openclaw` returns 0
8. Injectable exec function for testing: `setExecCommand(fn)` 
9. `npm run typecheck` passes

**Review checklist:**
- [ ] Health probe logic matches existing `fleet.ts` and `doctor.ts` exactly
- [ ] `launchctl` commands use the same pattern as `doctor.ts` fixCommand
- [ ] No hardcoded paths — port comes from agent config

**Test requirements:**
- New file: `test/unit/core/runtime/native.test.ts`
- Mock `child_process.execFileSync` and HTTP calls
- Test: healthy probe, unhealthy probe, start, stop, isAvailable (found/not found)

---

### WP-04: Runtime Resolver + agent.ts Rewire

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-0/WP-04-runtime-resolver` |
| **Depends on** | WP-02, WP-03 |
| **Deliverables** | `src/core/runtime/index.ts` + modified `src/core/agent.ts` |

**Acceptance Criteria:**
1. `getRuntime('docker')` returns `DockerRuntime`, `getRuntime('native')` returns `NativeRuntime`
2. `getRuntime('unknown')` throws descriptive error
3. `agent.ts` functions (`createAgent`, `destroyAgent`, `startAgent`, `stopAgent`, `restartAgent`, `logsAgent`, `shellAgent`, `getAgentStatus`, `getAllAgentStatuses`) dispatch through `getRuntime(agentConfig.runtime)` instead of calling Docker functions directly
4. The public API of agent.ts is **unchanged** — same function signatures, same return types
5. `allocatePorts()` remains runtime-agnostic (it already is)
6. `setupTribunal()` remains Docker/coding specific (only called for `role === 'coding'`)
7. **All existing tests in `test/unit/core/agent.test.ts` pass without modification**
8. `npm run typecheck` && `npm run lint` pass

**This is the critical ticket.** If existing tests break, the refactor is wrong.

**Review checklist:**
- [ ] No new public exports from agent.ts
- [ ] No behavior change for Docker agents
- [ ] agent.test.ts passes **unmodified**
- [ ] Import paths are clean (no circular dependencies)

**Arch validation:**
- [ ] The dispatch point is clean — one `getRuntime()` call per function, not scattered conditionals
- [ ] Config loading happens in agent.ts, runtime only gets what it needs
- [ ] No information about OpenClaw leaks into Phase 0 code

---

### WP-05: Watchdog Rewire

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-0/WP-05-watchdog-rewire` |
| **Depends on** | WP-04 |
| **Deliverables** | Modified `src/core/watchdog.ts` |

**Acceptance Criteria:**
1. `checkHealth()` iterates `config.agents` and calls `getRuntime(agent.runtime).healthCheck(name)` instead of calling `listBscsContainers()` then matching
2. `restartUnhealthy()` calls `getRuntime(agent.runtime).start(name)` instead of `startContainer(name)`
3. Docker agents: identical behavior to current code
4. Native agents: health check via HTTP probe (was not checked by watchdog before — this is a **net new capability** but it's correct)
5. Cooldown and max-restart logic unchanged
6. **All existing tests in `test/unit/core/watchdog.test.ts` pass** (may need mock updates since the dispatch path changes, but behavior is identical)
7. `npm run typecheck` passes

**Review checklist:**
- [ ] No direct Docker imports remaining in watchdog.ts
- [ ] Cooldown logic untouched
- [ ] `resetRestartCounts()` export still works (used in tests)

**Test requirements:**
- Update mocks in `watchdog.test.ts` if needed (mock runtime instead of docker directly)
- Add test: native agent health check returns healthy/unhealthy
- Existing tests must pass

---

### WP-06: Fleet Reconciliation Rewire

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-0/WP-06-fleet-reconcile-rewire` |
| **Depends on** | WP-04 |
| **Deliverables** | Modified `src/core/fleet.ts` (`computeReconcileChanges` + `applyReconcileChange`) |

**Acceptance Criteria:**
1. `computeReconcileChanges()` groups agents by runtime, then dispatches:
   - Docker: existing container-vs-config comparison (unchanged logic)
   - Native: status probe vs config — if config says running but probe says stopped, generate `start` change
2. `applyReconcileChange()` calls `getRuntime(runtime).start/stop/create` instead of Docker functions directly
3. `getFleetStatus()` is **not changed in this ticket** — it already handles native runtime
4. **All existing tests in `test/unit/core/fleet.test.ts` pass**
5. `npm run typecheck` passes

**Review checklist:**
- [ ] Docker reconciliation logic is byte-for-byte identical
- [ ] Native reconciliation is simple and correct (start if stopped, flag if missing)
- [ ] No orphan detection for native (you can't list native processes globally)

**Test requirements:**
- Add test: native agent reconciliation generates start change when probe fails
- Existing fleet tests pass unmodified

---

### WP-07: Phase 0 Integration Test + Sign-off

| Field | Value |
|---|---|
| **Assignee** | Dev B (test), PM (arch validation) |
| **Branch** | `phase-0/WP-07-integration` |
| **Depends on** | WP-04, WP-05, WP-06 |
| **Deliverables** | All Phase 0 branches merged to a `phase-0` integration branch |

**Gate Criteria (all must pass):**
1. `npm run typecheck` — zero errors
2. `npm run lint` — zero errors
3. `npm test` — all existing unit tests pass
4. New runtime tests pass: `docker.test.ts`, `native.test.ts`
5. No circular dependency: `npx madge --circular src/`
6. Manual smoke test: `bscs fleet status` on a machine with Docker agents
7. Manual smoke test: `bscs doctor` runs clean
8. `src/core/agent.ts` has zero direct imports from `src/core/docker.ts`
9. `src/core/watchdog.ts` has zero direct imports from `src/core/docker.ts`
10. `src/core/fleet.ts` reconciliation functions have zero direct imports from `src/core/docker.ts`

**Arch validation (PM):**
- [ ] Runtime interface is clean and minimal
- [ ] No over-abstraction (no factory patterns, no DI containers)
- [ ] Adding a new runtime means: one new file + one case in the resolver. Nothing else
- [ ] The phase-0 diff introduces zero new user-facing features

**When this passes → merge to `main`, tag `v0.2.0-alpha.1`**

---

## Phase 1 — OpenClaw Runtime + Schema

> Can start in parallel: WP-08 + WP-09 (no dependency between them)

### WP-08: Schema Extension

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-1/WP-08-schema` |
| **Depends on** | Phase 0 merged |
| **Deliverables** | Modified `src/util/types.ts` + modified `src/core/config.ts` |

**Acceptance Criteria:**
1. `runtime` enum: `z.enum(['docker', 'native', 'openclaw']).default('docker')`
2. `openclaw` optional block added to `AgentConfigSchema` with: `gatewayUrl`, `workspace`, `channels[]`, `model` (primary + fallbacks), `skills`, `cronJobs`, `identity`
3. Channel type enum: `z.enum(['telegram', 'discord'])` — extensible later
4. All fields optional or with sensible defaults (existing configs don't break)
5. `config.ts` DEFAULT_CONFIG gains `openclaw` defaults block (`gatewayUrl: 'http://127.0.0.1:18777'`)
6. `examples/fleet-config.json` updated with an example OpenClaw agent entry
7. **All existing tests pass** — schema is backward-compatible
8. `npm run typecheck` passes

**Review checklist:**
- [ ] No required fields that would break existing configs on parse
- [ ] `channels[].accountId` is opaque string (not a number — Telegram IDs can be large)
- [ ] `cronJobs[].cron` is string, not validated as cron expression (validation is OpenClaw's job)
- [ ] `gatewayUrl` default includes protocol

**Test requirements:**
- Add to `test/unit/core/config.test.ts`: parse config with openclaw agent, parse config without openclaw block (backward compat)

---

### WP-09: OpenClawRuntime Implementation

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-1/WP-09-openclaw-runtime` |
| **Depends on** | Phase 0 merged |
| **Deliverables** | `src/core/runtime/openclaw.ts` + modified `src/core/runtime/index.ts` |

**Acceptance Criteria:**
1. `OpenClawRuntime` class implements `AgentRuntime` interface
2. `isAvailable()` — checks `which openclaw` (CLI exists) + `GET gatewayUrl/healthz` (gateway reachable)
3. `create(name, config)` — calls `openclaw agents add <name>`, generates workspace via existing `templates/workspace.ts`, calls `openclaw agents bind` for each channel
4. `start(name)` — calls `openclaw config set agent.<name>.enabled true`
5. `stop(name)` — calls `openclaw config set agent.<name>.enabled false`
6. `restart(name)` — stop + start
7. `destroy(name)` — calls `openclaw agents delete <name>` + cleanup workspace
8. `status(name)` — `GET gatewayUrl/healthz` parsed for agent status, fallback to `openclaw agents list --json`
9. `logs(name)` — spawns `openclaw gateway logs --agent <name>`
10. `shell(name)` — throws `UserError('OpenClaw agents on shared gateway do not support shell access')`
11. `list()` — parses `openclaw agents list --json`
12. `healthCheck(name)` — `GET gatewayUrl/healthz` + `GET gatewayUrl/readyz`
13. Injectable exec and HTTP for testing: `setExecCommand(fn)`, `setHttpClient(fn)`
14. All CLI commands use `execFileSync` (not `exec`) — no shell injection
15. Resolver updated: `getRuntime('openclaw')` returns `OpenClawRuntime`
16. `npm run typecheck` passes

**Review checklist:**
- [ ] No `exec()` or `execSync()` — only `execFileSync()` with array args (injection-safe)
- [ ] HTTP calls have timeouts (3s for health, 10s for list)
- [ ] Gateway URL comes from agent config, not hardcoded
- [ ] Error messages are descriptive: "OpenClaw CLI not found", "Gateway not reachable at {url}"
- [ ] Workspace cleanup in destroy() doesn't use `rm -rf` — uses `fs.rmSync` with path validation

**Test requirements:**
- New file: `test/unit/core/runtime/openclaw.test.ts`
- Mock exec and HTTP client
- Tests: create (verify CLI args), start/stop (verify config set), destroy (verify cleanup), status (parse healthz), list (parse JSON), isAvailable (both checks), healthCheck (healthy/unhealthy/gateway-down)
- Test: shell throws UserError

---

### WP-10: Doctor + Watchdog OpenClaw Support

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-1/WP-10-doctor-watchdog-openclaw` |
| **Depends on** | WP-08, WP-09 |
| **Deliverables** | Modified `src/core/doctor.ts`, modified `src/core/watchdog.ts` |

**Acceptance Criteria:**
1. `doctor.ts` `checkAgentContainer()`: add `runtime === 'openclaw'` branch
   - Checks gateway reachability
   - Checks agent registered in gateway via `openclaw agents list --json`
   - Provides fix commands: `openclaw gateway restart`
2. `watchdog.ts`: OpenClaw health checks go through `OpenClawRuntime.healthCheck()` (already wired by Phase 0, but validate it works with real OpenClaw responses)
3. Watchdog: for shared gateway, if gateway is down, mark **all** openclaw agents unhealthy in one check (don't probe each individually when gateway is unreachable)
4. Watchdog: gateway restart cooldown is 3x normal cooldown (blast radius awareness)
5. `npm run typecheck` passes

**Review checklist:**
- [ ] Doctor fix commands don't auto-execute dangerous operations
- [ ] Watchdog doesn't restart gateway once per agent (dedup to one restart)
- [ ] Healthz timeout is reasonable (3s)

**Test requirements:**
- Add to `doctor.test.ts`: openclaw agent with healthy gateway, openclaw agent with dead gateway
- Add to `watchdog.test.ts`: multiple openclaw agents on same gateway, verify single restart

---

### WP-11: Phase 1 Integration + Smoke Test

| Field | Value |
|---|---|
| **Assignee** | Dev A (test), PM (arch validation) |
| **Branch** | `phase-1/WP-11-integration` |
| **Depends on** | WP-08, WP-09, WP-10 |

**Gate Criteria:**
1. `npm run typecheck` && `npm run lint` && `npm test` — all pass
2. Manual: Add an openclaw agent to config JSON, run `bscs fleet status` — agent appears with status from gateway
3. Manual: `bscs doctor` — openclaw checks appear and pass/fail correctly
4. Manual: `bscs agent stop <openclaw-agent>` — calls openclaw config set
5. Schema backward compat: existing config without openclaw block loads without error
6. Config with openclaw block round-trips through save/load

**Arch validation (PM):**
- [ ] OpenClawRuntime doesn't import from DockerRuntime or vice versa
- [ ] No openclaw-specific logic in agent.ts — all behind the runtime interface
- [ ] Schema is extensible (adding a new channel type = one enum value)

**When this passes → merge to `main`, tag `v0.2.0-alpha.2`**

---

## Phase 2 — Fleet Import + Channel Management

### WP-12: Fleet Import from OpenClaw Gateway

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-2/WP-12-fleet-import` |
| **Depends on** | Phase 1 merged |
| **Deliverables** | New `importFromOpenClaw()` in `src/core/fleet.ts` + CLI wiring in `src/cli/fleet/index.ts` |

**Acceptance Criteria:**
1. `bscs fleet import --from-openclaw [gatewayUrl]` queries `openclaw agents list --json`
2. For each discovered agent, populates config with: name, `runtime: 'openclaw'`, gateway URL, workspace path, channels, model, skills, cron jobs
3. Role inferred from workspace `SOUL.md` if readable, otherwise `'custom'`
4. Does NOT overwrite agents already in config (skip with warning)
5. Dry-run by default: prints what would be imported. `--apply` to write config
6. Outputs summary: N agents imported, N skipped
7. `npm run typecheck` passes

**Review checklist:**
- [ ] Dry-run is default — safe by default
- [ ] Doesn't clobber existing agents
- [ ] Handles gateway unreachable gracefully (error message, not crash)
- [ ] JSON parsing from `openclaw agents list` has error handling

**Test requirements:**
- Mock `openclaw agents list --json` output
- Test: import 3 agents, verify config populated correctly
- Test: skip already-existing agent
- Test: gateway unreachable → error

---

### WP-13: Channel Bind/Unbind

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-2/WP-13-channel-bind` |
| **Depends on** | Phase 1 merged |
| **Deliverables** | `bindChannel()` / `unbindChannel()` in `src/core/agent.ts` + CLI in `src/cli/agent/index.ts` |

**Acceptance Criteria:**
1. `bscs agent bind <name> --channel telegram --account-id <id>` calls `openclaw agents bind`
2. `bscs agent unbind <name> --channel telegram` calls `openclaw agents unbind`
3. Both update `config.agents[name].openclaw.channels` array
4. Validates agent exists and is `runtime: 'openclaw'` — throws if Docker agent
5. `npm run typecheck` passes

**Review checklist:**
- [ ] account-id validated as non-empty string
- [ ] Unbind removes from config array, doesn't leave stale entry
- [ ] Works for agents with no existing channels (first bind)

**Test requirements:**
- Test: bind adds to channels array
- Test: unbind removes from channels array
- Test: bind on Docker agent throws

---

### WP-14: Agent Create with --runtime openclaw

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-2/WP-14-openclaw-create` |
| **Depends on** | WP-12 |
| **Deliverables** | Modified `src/cli/agent/index.ts` + modified `src/core/agent.ts` |

**Acceptance Criteria:**
1. `bscs agent create <name> --role coding --runtime openclaw [--model X] [--bind telegram:123]`
2. Dispatches to `OpenClawRuntime.create()` which calls `openclaw agents add`, generates workspace, binds channels
3. Saves to config with `runtime: 'openclaw'` and full openclaw block
4. `--bind` flag accepts `channel:accountId` format, can be repeated
5. Without `--runtime`, defaults to `'docker'` (existing behavior preserved)
6. `npm run typecheck` passes

**Review checklist:**
- [ ] `--bind` parsing is strict: exactly `type:id` format
- [ ] Default runtime is still `docker` — backward compatible
- [ ] Channel types validated against enum

**Test requirements:**
- Test: create with --runtime openclaw calls OpenClawRuntime.create
- Test: create without --runtime calls DockerRuntime.create
- Test: --bind parsing

---

### WP-15: Phase 2 Integration + Live Test

| Field | Value |
|---|---|
| **Assignee** | PM (live test on HQ) |
| **Branch** | `phase-2/WP-15-integration` |
| **Depends on** | WP-12, WP-13, WP-14 |

**Gate Criteria:**
1. All automated tests pass
2. **Live test on HQ:** `bscs fleet import --from-openclaw` discovers all 8 agents
3. `bscs fleet import --from-openclaw --apply` writes config correctly
4. `bscs fleet status` shows all 8 agents with live status
5. `bscs agent bind <name> --channel telegram --account-id <id>` succeeds
6. `bscs agent create test-agent --role custom --runtime openclaw` creates a new agent

**When this passes → merge to `main`, tag `v0.2.0-beta.1`**

---

## Phase 3 — Reconciliation + Watchdog

### WP-16: OpenClaw Reconciliation Logic

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-3/WP-16-openclaw-reconcile` |
| **Depends on** | Phase 2 merged |
| **Deliverables** | Modified `src/core/fleet.ts`, modified `src/core/runtime/openclaw.ts` |

**Acceptance Criteria:**
1. `OpenClawRuntime` gains: `listAgents()`, `getBindings(name)`, `getModel(name)` — reconciliation helpers
2. `computeReconcileChanges()` for `runtime: 'openclaw'`:
   - Agent in config but not in gateway → `create` action
   - Agent disabled in gateway but should be running → `enable` action
   - Channel binding mismatch → `rebind` action
   - Model mismatch → `config-update` action
   - Agent in gateway but not in config → `orphaned` warning (no auto-delete)
3. `applyReconcileChange()` handles new action types via OpenClawRuntime
4. `npm run typecheck` passes

**Review checklist:**
- [ ] Orphaned agents are warned, not deleted
- [ ] Rebind does unbind-all then bind-correct (not incremental — simpler and correct)
- [ ] Model comparison is case-insensitive

**Test requirements:**
- Test each reconciliation case: missing agent, disabled agent, binding mismatch, model mismatch, orphaned
- Test applyReconcileChange for each new action type

---

### WP-17: Gateway-Aware Watchdog

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-3/WP-17-gateway-watchdog` |
| **Depends on** | Phase 2 merged |
| **Deliverables** | Modified `src/core/watchdog.ts` |

**Acceptance Criteria:**
1. Group openclaw agents by `gatewayUrl` before checking health
2. One health probe per gateway, not per agent
3. If gateway is down: mark all agents on that gateway unhealthy, issue one restart
4. Gateway restart cooldown: `cooldownMs * 3` (configurable via watchdog config)
5. If gateway is up but individual agent is unhealthy: restart just that agent via `openclaw config set`
6. `npm run typecheck` passes

**Review checklist:**
- [ ] Grouping by gatewayUrl is correct (agents on different gateways are independent)
- [ ] Single restart per gateway per cooldown window
- [ ] Restart count tracked per-gateway, not per-agent for gateway-level restarts

**Test requirements:**
- Test: 4 agents on same gateway, gateway down → 1 restart, 4 marked unhealthy
- Test: gateway up, 1 agent unhealthy → only that agent restarted
- Test: gateway cooldown prevents rapid restarts

---

### WP-18: Phase 3 Integration

| Field | Value |
|---|---|
| **Assignee** | Dev A (test), PM (arch validation) |
| **Branch** | `phase-3/WP-18-integration` |
| **Depends on** | WP-16, WP-17 |

**Gate Criteria:**
1. All automated tests pass
2. `bscs fleet reconcile` on imported fleet shows correct diff
3. `bscs fleet reconcile --apply` fixes drift
4. Watchdog correctly handles gateway down scenario (kill gateway, wait, verify restart)
5. Watchdog cooldown prevents restart storm

**When this passes → merge to `main`, tag `v0.2.0-rc.1`**

---

## Phase 4 — MCP Tools

### WP-19: Runtime-Aware MCP Tools

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-4/WP-19-mcp-runtime` |
| **Depends on** | Phase 3 merged |
| **Deliverables** | Modified `src/mcp/server.ts` |

**Acceptance Criteria:**
1. `agent_create` tool gains optional `runtime` and `channels` parameters
2. All existing MCP tools work for OpenClaw agents (they go through agent.ts which dispatches to runtime)
3. No breaking changes to existing tool schemas
4. `npm run typecheck` passes

**Test requirements:**
- Existing MCP tests pass unchanged
- New test: agent_create with runtime=openclaw

---

### WP-20: New Channel + Cron MCP Tools

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-4/WP-20-mcp-new-tools` |
| **Depends on** | WP-19 |
| **Deliverables** | Modified `src/mcp/server.ts` + supporting functions in `src/core/agent.ts` |

**Acceptance Criteria:**
1. New tools registered: `agent_bind`, `agent_unbind`, `cron_add`, `cron_remove`, `cron_list`, `agent_config_set`, `secrets_audit`
2. Each tool has zod parameter validation
3. Each tool returns JSON in `{ type: 'text', text: JSON.stringify(...) }` format (matching existing pattern)
4. Error handling matches existing pattern (try/catch, isError flag)
5. `npm run typecheck` passes

**Test requirements:**
- New file: `test/unit/mcp/openclaw-tools.test.ts`
- Test each tool: valid params → success, invalid params → error

---

### WP-21: Phase 4 Integration

| Field | Value |
|---|---|
| **Assignee** | PM |
| **Branch** | `phase-4/WP-21-integration` |
| **Depends on** | WP-19, WP-20 |

**Gate Criteria:**
1. All automated tests pass
2. MCP server starts without error: `bscs mcp`
3. Tool listing includes all new tools
4. Manual: call `fleet_status` via MCP, see openclaw agents
5. Manual: call `agent_bind` via MCP, verify binding applied

**When this passes → merge to `main`**

---

## Phase 5 — Full Orchestration

### WP-22: Cron + Skills CLI Commands

| Field | Value |
|---|---|
| **Assignee** | Dev B |
| **Branch** | `phase-5/WP-22-cron-skills-cli` |
| **Depends on** | Phase 4 merged |
| **Deliverables** | Modified `src/cli/agent/index.ts`, new operations in `src/core/agent.ts`, modified `src/core/runtime/openclaw.ts` |

**Acceptance Criteria:**
1. `bscs agent cron add/list/remove` — full CRUD
2. `bscs agent skills list/add/remove` — full CRUD
3. `bscs agent identity set` — set display name + emoji
4. All commands sync to both BSCS config and openclaw gateway
5. `npm run typecheck` passes

**Test requirements:**
- Test each CRUD operation
- Test: cron add updates config and calls openclaw CLI

---

### WP-23: Dashboard Integration

| Field | Value |
|---|---|
| **Assignee** | Dev A |
| **Branch** | `phase-5/WP-23-dashboard` |
| **Depends on** | Phase 4 merged |
| **Deliverables** | Modified `src/ui/components/AgentTable.ts`, modified `src/dashboard/server.ts` |

**Acceptance Criteria:**
1. Agent table shows: channels (badges), cron count, skills count, model + fallbacks
2. `runtime` column shows docker/native/openclaw with appropriate styling
3. Dashboard API endpoint includes openclaw-specific fields
4. No JS errors in browser console
5. `npm run build:ui` passes

**Review checklist:**
- [ ] No sensitive data exposed in dashboard (no API keys, no account IDs in DOM)
- [ ] Graceful fallback for agents with no openclaw block

---

### WP-24: Phase 5 Integration + Final Release

| Field | Value |
|---|---|
| **Assignee** | PM |
| **Branch** | `phase-5/WP-24-integration` |
| **Depends on** | WP-22, WP-23 |

**Gate Criteria:**
1. Full test suite passes
2. Dashboard renders all agent types correctly
3. Cron/skills CLI works end-to-end on HQ
4. `bscs fleet reconcile` detects cron drift
5. All 8 agents visible and manageable through BSCS

**When this passes → merge to `main`, tag `v0.2.0`**

---

## Summary: Ticket Dependency Graph

```
WP-01 ─────┬── WP-02 ──┬── WP-04 ──┬── WP-05 ──┐
           │            │           └── WP-06 ──┤
           └── WP-03 ──┘                        ├── WP-07 (Phase 0 gate)
                                                │
                        ┌── WP-08 ──┐           │
                        ├── WP-09 ──┤── WP-10 ──┤── WP-11 (Phase 1 gate)
                        │           │           │
              ┌── WP-12 ┤── WP-14 ──┤           │
              ├── WP-13 ┘           ├── WP-15 ──┤ (Phase 2 gate)
              │                     │           │
              ├── WP-16 ────────────┤           │
              ├── WP-17 ────────────┤── WP-18 ──┤ (Phase 3 gate)
              │                     │           │
              ├── WP-19 ── WP-20 ──┤── WP-21 ──┤ (Phase 4 gate)
              │                     │           │
              ├── WP-22 ────────────┤           │
              └── WP-23 ────────────┤── WP-24 ──┘ (Phase 5 gate — v0.2.0)
```

## Parallel Work Opportunities

| Time | Dev A | Dev B |
|---|---|---|
| Phase 0 start | WP-01 (interface) | — (blocked) |
| Phase 0 | WP-02 (DockerRuntime) | WP-03 (NativeRuntime) — **parallel** |
| Phase 0 | WP-04 (resolver + agent.ts) | WP-05 (watchdog) after WP-04 |
| Phase 0 | WP-06 (fleet reconcile) | WP-07 (integration test) |
| Phase 1 | WP-09 (OpenClawRuntime) | WP-08 (schema) — **parallel** |
| Phase 1 | — | WP-10 (doctor + watchdog) |
| Phase 2 | WP-12 (import) + WP-14 (create) | WP-13 (bind/unbind) — **parallel** |
| Phase 3 | WP-16 (reconciliation) | WP-17 (watchdog) — **parallel** |
| Phase 4 | WP-20 (new MCP tools) | WP-19 (runtime-aware MCP) |
| Phase 5 | WP-23 (dashboard) | WP-22 (cron/skills CLI) — **parallel** |
