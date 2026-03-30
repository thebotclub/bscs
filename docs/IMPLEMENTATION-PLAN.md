# BSCS v2 — Detailed Implementation Plan

**Date:** 2026-03-30
**Input:** DASHBOARD-DESIGN.md + FLEET-OPERATIONS-DESIGN.md
**Approach:** Tribunal-enforced, TDD, each phase ships working code

---

## Phase 1: API Foundation + Fleet Overview (FIRST BUILD)

**Goal:** Replace the broken dashboard with something that actually works. Solid API, clean UI, real operations.

### 1A: API Overhaul (src/dashboard/server.ts → src/api/)

**Break the monolith.** Current server.ts is 2000+ lines with embedded HTML. Split into:

```
src/api/
  server.ts          — HTTP server setup, middleware, routing
  auth.ts            — Cookie-based auth (keep existing token, add cookie exchange)
  routes/
    fleet.ts         — GET /api/fleet (cached, enriched)
    agents.ts        — CRUD + actions (start/stop/restart/logs)
    machines.ts      — GET /api/machines, GET /api/machines/:name
    doctor.ts        — GET /api/doctor (async, SSE streaming results)
    config.ts        — GET/PUT agent configs
  middleware/
    auth.ts          — Bearer token + cookie validation
    cors.ts          — Origin whitelist
    errors.ts        — Consistent error responses
src/dashboard/
  index.html         — Single HTML file (built by esbuild from src/ui/)
src/ui/
  app.tsx            — Preact app root
  components/        — Reusable components
  screens/           — Fleet, Machine, Agent, Doctor, Logs
  signals.ts         — Global state (Preact Signals)
  api.ts             — API client with auth, retries, error handling
  router.ts          — Hash-based routing
  styles.css         — All styles
```

**API Endpoints (Phase 1):**

| Method | Path | What | Auth |
|--------|------|------|------|
| POST | /api/auth | Exchange token → cookie | Token |
| GET | /api/auth/check | Verify session | Cookie |
| GET | /api/fleet | Full fleet status (cached 15s) | Cookie |
| GET | /api/machines | All machines with health | Cookie |
| GET | /api/machines/:name | Machine detail | Cookie |
| GET | /api/agents | All agents | Cookie |
| GET | /api/agents/:name | Agent detail + channels | Cookie |
| POST | /api/agents/:name/start | Start agent | Cookie |
| POST | /api/agents/:name/stop | Stop agent | Cookie |
| POST | /api/agents/:name/restart | Restart agent | Cookie |
| GET | /api/agents/:name/logs | Last N log lines | Cookie |
| GET | /api/events | SSE stream for real-time updates | Cookie |

**Key improvements over current:**
- Cookie auth (no more token-in-HTML injection)
- SSE for real-time (no more WebSocket frame encoding bugs)
- Cached fleet data (no more 6-second page loads)
- Proper error responses (JSON with error codes, not HTML)
- Agent info fetched on-demand and cached (not on every fleet load)

### 1B: Fleet Overview Screen

**Layout:**
```
┌──────────┬─────────────────────────────────────────────┐
│ Sidebar  │  Fleet Overview                              │
│          │                                               │
│ ≡ Fleet  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│   Agents │  │mini1│ │mini2│ │mini3│ │mini4│ ...        │
│   Health │  │ 0/0 │ │ 0/0 │ │ 5/5 │ │ 4/4 │           │
│   Logs   │  │  ●  │ │  ●  │ │  ●  │ │  ●  │           │
│   Config │  └─────┘ └─────┘ └─────┘ └─────┘           │
│          │                                               │
│ Machines │  Agents (21)           [Filter▾] [Search]    │
│  mini1   │  ┌──────┬────────┬────┬────────┬──────────┐ │
│  mini2   │  │ Name │Machine │ ● │Channels│ Actions  │ │
│  mini3   │  ├──────┼────────┼────┼────────┼──────────┤ │
│  mini4   │  │atlas │ mini4  │ 🟢 │ 📱 TG  │ ⏹ 🔄 📋│ │
│  HQ      │  │vault │ mini4  │ 🟢 │        │ ⏹ 🔄 📋│ │
│  Dell    │  │cody  │ mini4  │ 🟢 │        │ ⏹ 🔄 📋│ │
│          │  │m3-atl│ mini3  │ 🟢 │ 📱 TG  │ ⏹ 🔄 📋│ │
│          │  └──────┴────────┴────┴────────┴──────────┘ │
│          │                                               │
│ 🩺Doctor │  Fleet Health: 17/21 running | 67/99 checks  │
└──────────┴─────────────────────────────────────────────┘
```

**Components to build:**
- `<Sidebar>` — navigation + machine list
- `<MachineCards>` — top row showing each machine's health
- `<AgentTable>` — sortable, filterable, with inline actions
- `<StatusBadge>` — color-coded status indicator
- `<ChannelBadge>` — small pills for TG/WA/DC
- `<ActionButtons>` — start/stop/restart with loading states
- `<Toast>` — notification system
- `<LoginScreen>` — token input → cookie exchange

**Agent actions must:**
- Show loading spinner on the button while executing
- Disable other actions on that agent during execution
- Show success/error inline (not just a toast)
- Auto-refresh the agent's status after action completes
- Handle SSH timeouts gracefully (show "timed out, check manually")

### 1C: Build Pipeline

```bash
# Development
cd src/ui && esbuild app.tsx --bundle --outfile=../dashboard/bundle.js --watch

# Production
esbuild src/ui/app.tsx --bundle --minify --outfile=dist/dashboard/bundle.js
# Then inject into HTML template
```

**Keep single-file deployment** — esbuild bundles everything into one JS file, inject into HTML template with inline styles.

### Tests (Phase 1)
- API auth: token exchange, cookie validation, expired cookie, invalid token
- API fleet: returns cached data, enriches with machine names
- API agents: start/stop/restart success and failure paths
- API error handling: 404, 500, timeout responses
- UI: AgentTable renders agents, filters work, sort works
- UI: ActionButtons show loading, success, error states
- UI: SSE reconnection

---

## Phase 2: Agent Detail + Machine Detail

**Goal:** Drill-down from overview to detail. Click an agent → see everything about it.

### Agent Detail Screen (hash route: #/agents/:name)
- **Overview tab:** Status, uptime, machine, runtime, model, ports, gateway health
- **Channels tab:** Connected channels with status, bot IDs, last message time
- **Config tab:** Read-only view of openclaw.json with syntax highlighting
- **Logs tab:** Streaming log viewer (SSE or polling, last 500 lines, search, level filter)

### Machine Detail Screen (hash route: #/machines/:name)
- **Agents tab:** All agents on this machine with actions
- **System tab:** CPU, memory, disk, Docker version, Node version, OpenClaw version
- **Logs tab:** System-level logs

### New API endpoints:
| Method | Path | What |
|--------|------|------|
| GET | /api/agents/:name/config | Agent's openclaw.json |
| GET | /api/agents/:name/logs/stream | SSE log stream |
| GET | /api/machines/:name/system | System metrics |
| PUT | /api/agents/:name/config | Update agent config |

---

## Phase 3: Doctor + Health

**Goal:** Async health checks that don't timeout, compliance-grid view.

### Key change: Doctor runs async
- `POST /api/doctor/run` → starts doctor, returns run ID
- `GET /api/doctor/run/:id/stream` → SSE stream of check results as they complete
- Each check reports independently (no waiting for all machines)
- UI shows results appearing in real-time as checks complete

### Health Screen
- Compliance grid: rows = agents, columns = check types
- Each cell is ✅/⚠️/❌/⏳
- Click a cell → see details + fix option
- "Fix All" runs safe auto-fixes, shows progress

### Doctor improvements:
- Separate quick checks (local, <1s) from slow checks (SSH, 5-10s)
- Show quick checks immediately, slow checks stream in
- Cache results for 5 minutes (show cached + "last checked X ago")
- Fix actions return real-time progress via SSE

---

## Phase 4: Fleet Operations (CLI + Dashboard)

**Goal:** Real fleet management beyond start/stop.

### New CLI commands:
```bash
bscs fleet apply fleet.yaml     # Declarative: converge to desired state
bscs fleet plan fleet.yaml      # Show what would change (dry run)
bscs fleet diff                  # Show drift from desired state
bscs agent clone atlas mini2     # Clone agent to another machine
bscs agent move atlas mini2      # Move agent (stop + clone + start)
bscs agent update atlas --model claude-sonnet-4  # Update config
bscs fleet update-all --image openclaw:latest    # Rolling update
bscs fleet backup                # Backup all configs
bscs observe cost --period week  # Cost report
bscs observe tokens              # Token usage across fleet
```

### fleet.yaml manifest:
```yaml
fleet:
  name: botclub
  controller: mini4

machines:
  mini4:
    role: controller
    agents:
      - atlas: { role: brain, model: claude-opus-4-6, channels: [telegram] }
      - vault: { role: security, model: claude-opus-4-6 }
      - cody: { role: coding, model: claude-sonnet-4-6 }

  mini3:
    role: worker
    agents:
      - atlas: { role: brain, model: claude-opus-4-6, channels: [telegram] }
      - vault: { role: security }
      - cody: { role: coding }
```

### Dashboard additions:
- Fleet diff view (what's different from desired state)
- Deploy view (rolling update progress)
- Cost dashboard (per agent, per model, per machine)

---

## Phase 5: Intelligence + Governance

**Goal:** BSCS becomes smart about the fleet.

- Sick agent detection (running but not productive)
- Auto-restart on failure with backoff
- Cost alerts and optimization suggestions
- Tribunal integration for code quality gates
- Audit trail of all operations
- Agent placement suggestions (which machine has capacity)

---

## Build Order for Forge

**Phase 1 is the critical build.** Everything else builds on it.

Forge should implement Phase 1 in this order:
1. API split (break server.ts monolith into api/ modules)
2. Auth middleware (cookie-based)
3. Fleet + agents + machines API routes
4. SSE endpoint for real-time updates
5. UI framework setup (Preact + HTM + esbuild)
6. Fleet Overview screen
7. Agent actions with proper states
8. Login screen
9. Bundle into single HTML
10. Tests for all of the above

**Estimated time:** 2-3 Tribunal-enforced sessions
