# BSCS Fleet Dashboard — Design Document

**Author:** Mini4 (Architecture Subagent)  
**Date:** 2026-03-30  
**Status:** Proposal  

---

## Table of Contents

1. [Research Findings](#1-research-findings)
2. [What's Wrong with the Current Dashboard](#2-whats-wrong-with-the-current-dashboard)
3. [Information Architecture](#3-information-architecture)
4. [Screen Designs](#4-screen-designs)
5. [Technical Architecture](#5-technical-architecture)
6. [API Design](#6-api-design)
7. [Implementation Plan](#7-implementation-plan)
8. [What to Keep vs Rebuild](#8-what-to-keep-vs-rebuild)

---

## 1. Research Findings

### Portainer — Container Lifecycle Management

**What works:**
- **Environment switcher** at the top — one click to jump between Docker hosts. This is the #1 pattern BSCS needs: machine switching without nesting.
- **Container list as a table** with inline status badges (running/stopped/paused) and action buttons (start/stop/restart/remove) directly in each row. No modal, no confirmation page — just act.
- **Integrated log viewer** and **console/terminal** per container, accessible from tabs on the container detail page.
- **Stacks view** groups related containers — analogous to how BSCS could group agents by machine or by project.
- **Quick actions column** in tables — every row has a ▶️⏹🔄 set of buttons.

**What doesn't work:**
- Navigation is deep. Getting from the dashboard to a container's logs is: Home → Environment → Containers → Container → Logs tab. That's 4 clicks.
- The dashboard home page is nearly useless — it just shows environment cards with container counts. No at-a-glance health.
- Mobile experience is poor — tables don't collapse well.

**Key takeaway for BSCS:** Steal the environment switcher concept, but flatten the navigation. Agent actions should be 1-2 clicks max from any screen.

---

### Rancher — Cluster Health & Multi-Machine Views

**What works:**
- **Cluster explorer** landing page shows a grid of clusters with health status (green/yellow/red) and key metrics (nodes, pods, CPU, memory) visible without clicking in.
- **Top nav for cluster switching** + left sidebar for resource navigation within a cluster. Two-axis navigation that scales.
- **Conditions-based health** — instead of binary up/down, shows specific conditions (MemoryPressure, DiskPressure, etc.) as colored chips.
- **Events timeline** on detail pages — shows recent events (restarts, errors) chronologically.

**What doesn't work:**
- Overwhelming for non-Kubernetes users — too many resource types in the sidebar.
- The dashboard tries to be everything: YAML editor, terminal, monitoring, RBAC management. Scope creep makes it slow.

**Key takeaway for BSCS:** The conditions-chip pattern is perfect for agent health. Instead of just "running/stopped," show: `✅ Connected` `⚠️ High Memory` `❌ Channel Disconnected`. Multi-condition health beats binary status.

---

### Grafana — Health Visualization & Alerting

**What works:**
- **Dashboard-of-dashboards** pattern: a top-level overview dashboard with panels that link to detailed dashboards. Drill-down without losing context.
- **Time range selector** is global — change it once, everything updates.
- **Sparklines in tables** — show mini time-series inline in overview tables. Instant trend visibility.
- **Alert states** shown as colored sidebar annotations on graphs. You see when things went wrong overlaid on the data.
- **Variable dropdowns** at the top of dashboards for filtering (by host, service, etc.).

**What doesn't work:**
- Not an operational tool — great for looking at data, bad for taking action. No start/stop/restart.
- Configuration is complex; panels need queries. Not relevant for BSCS.
- Can feel like an analytics tool, not an operations tool.

**Key takeaway for BSCS:** Sparklines in the agent overview table (showing uptime/restarts over last 24h). Variable dropdowns for filtering by machine. But don't build a Grafana clone — BSCS is for operations, not analytics.

---

### Coolify — Multi-Server Service Management

**What works:**
- **Hierarchical organization:** Server → Project → Environment → Resource. Clear mental model.
- **Left sidebar** with: Dashboard, Projects, Servers, Sources, Settings. Clean, flat navigation — no nesting.
- **Server detail page** with tabs: General, Proxy, Resources, Terminal, Metrics, Cleanup. This is the exact pattern for BSCS machine detail.
- **"+ Add Resource" button** prominently placed — clear call to action.
- **Real-time build/deploy logs** streamed in the UI during actions.
- **Notification channels** (Email, Discord, Telegram, Slack) configurable in Settings.

**What doesn't work:**
- Dashboard landing page is just a list of projects and servers — no aggregate health view.
- No fleet-wide health overview. You have to click into each server to see if it's healthy.

**Key takeaway for BSCS:** Copy the sidebar structure and the server detail tab pattern. But improve on Coolify by having a real fleet overview landing page with aggregate health, not just a list.

---

### Dozzle — Real-Time Log Viewing

**What works:**
- **Stateless philosophy** — no log storage, just streams from Docker. Instant startup, tiny footprint.
- **Container sidebar** lists all containers with colored status dots. Click one, logs stream immediately.
- **Multi-container merged view** — select multiple containers and see interleaved logs with color-coded source labels. This is killer for debugging cross-agent issues.
- **Search/filter** within streaming logs — regex support.
- **Collapsible groups** (Dozzle 9.0) — group containers by project/stack and collapse/expand.
- **SQL-based log querying** for structured logs.
- **Dark theme** by default, clean monospace log output.

**What doesn't work:**
- Single-purpose — only logs, nothing else. Not a management UI.
- Multi-host requires deploying agents on each host.

**Key takeaway for BSCS:** The merged multi-agent log view is the single best feature to steal. Being able to select 3 agents and see their interleaved logs — that's how you debug fleet issues. Also: don't store logs in the dashboard, stream them from the source.

---

### Uptime Kuma — Service Health Status

**What works:**
- **The heartbeat bar** — a horizontal bar of small colored blocks showing uptime history. Green = up, red = down, gray = maintenance. This is the most imitated status visualization pattern in the self-hosted world for good reason. At a glance, you see: "this has been stable for weeks" or "this has been flapping all day."
- **Status page** concept — a public or internal page showing just status, separate from the management UI.
- **Ping/response time chart** below each monitor — sparkline showing latency trends.
- **Grouping monitors** into categories.
- **Notification integrations** (70+ notification channels).

**What doesn't work:**
- It's a monitor, not a manager. No actions beyond pause/resume monitoring.
- The main UI is a flat list — gets long with many monitors.

**Key takeaway for BSCS:** The heartbeat bar is mandatory for the fleet overview. Each agent gets a small row of colored blocks showing its uptime over the last 24h/7d. You can tell "this agent is rock solid" vs "this agent crashes every 4 hours" without clicking into anything.

---

### Netdata — Real-Time System Metrics

**What works:**
- **Auto-discovery** — installs, finds all services, starts graphing. Zero configuration.
- **Single-second granularity** — charts update in real-time, not every 15s or 60s.
- **Composite charts** — overlay metrics from multiple nodes on the same graph.
- **Anomaly detection** built-in — highlights unusual patterns automatically.
- **Rooms** concept for organizing multiple nodes — click a room, see all nodes.

**What doesn't work:**
- Information overload — hundreds of charts per node out of the box. Needs heavy curation.
- The UI redesign (Netdata Cloud) is controversial — many prefer the old single-node dashboard.

**Key takeaway for BSCS:** Auto-refresh with low latency matters. Don't make users hit F5. But don't drown them in metrics either — BSCS agents have a small, fixed set of relevant metrics (uptime, restarts, memory, channel status, last message time).

---

### Fleet (Kolide/osquery) — Host Fleet Management

**What works:**
- **Host inventory table** as the primary view — hostname, OS, platform, status, last seen, issues count. Sortable, filterable, searchable.
- **Host detail** page with tabs: Details, Software, Policies, Queries.
- **Policies** concept — define expected states, see which hosts comply. "All hosts should have agent X running" → shows pass/fail count.
- **Labels/tags** for filtering and grouping hosts.
- **Targeted queries** — run a query across all hosts or a subset.

**What doesn't work:**
- Very security-focused UI, not operations-focused.
- Actions are limited to queries — no direct start/stop/manage capabilities.

**Key takeaway for BSCS:** The policies/compliance pattern is interesting for Doctor. "All agents should have valid auth tokens" → shows 18/20 passing, 2 failing. Host inventory table with "last seen" and "issues count" columns is a great overview pattern.

---

### Synthesis: Best Patterns Across All Tools

| Pattern | Source | Apply to BSCS |
|---------|--------|---------------|
| Environment/machine switcher | Portainer | Top-level machine filter |
| Conditions chips (multi-status) | Rancher | Agent health display |
| Sparklines in tables | Grafana | Agent uptime mini-charts |
| Sidebar + tabbed detail | Coolify | Navigation structure |
| Merged multi-source logs | Dozzle | Fleet log viewer |
| Heartbeat bar | Uptime Kuma | Agent uptime visualization |
| Host inventory table | Fleet | Fleet overview table |
| Policies/compliance | Fleet | Doctor/Health checks |
| Real-time auto-refresh | Netdata | Dashboard polling |

---

## 2. What's Wrong with the Current Dashboard

Based on the description provided:

1. **No information hierarchy.** It's a flat list of agents with buttons. No grouping by machine, no health aggregation, no drill-down.
2. **Actions fail silently.** Start/stop buttons fire requests and you get a toast that may or may not reflect reality. No confirmation, no loading state, no error detail.
3. **Auth UX is broken.** Token-based auth that "breaks the page" suggests the auth state is fragile — probably storing token in JS memory or a cookie that expires mid-session.
4. **Doctor timeouts.** Health checks run synchronously and block the UI. Should be async with progress reporting.
5. **Single HTML file.** 50KB of embedded HTML/CSS/JS means no component reuse, no module system, no testability, no incremental loading.
6. **No real-time.** Probably poll-on-demand or manual refresh, so the dashboard shows stale data.

---

## 3. Information Architecture

### Sitemap

```
BSCS Dashboard
├── Fleet Overview (landing page)
│   ├── Machine summary cards (6 cards)
│   ├── Agent table with inline status + actions
│   └── Recent events feed
├── Machine Detail (click a machine)
│   ├── System info (OS, uptime, CPU, memory, disk)
│   ├── Agents on this machine (table)
│   ├── Machine actions (reboot agent host, etc.)
│   └── Machine logs
├── Agent Detail (click an agent)
│   ├── Overview tab (status, channels, uptime, config summary)
│   ├── Channels tab (per-channel status, last message, reconnect)
│   ├── Logs tab (streaming agent logs)
│   ├── Config tab (view/edit agent config)
│   └── Actions (start, stop, restart, pull, update)
├── Health (fleet-wide)
│   ├── Check results grid (policy/compliance view)
│   ├── Per-machine health
│   └── Per-agent health
├── Logs (fleet-wide)
│   ├── Multi-agent merged log viewer
│   ├── Filter by machine, agent, level
│   └── Search
└── Settings
    ├── Auth / tokens
    ├── Fleet config
    └── Notification channels
```

### Navigation Structure: **Left Sidebar + Breadcrumb**

**Why sidebar:** 
- Coolify, Portainer, Grafana, and Fleet all use left sidebar. It's the dominant pattern for admin dashboards because it stays visible while you work.
- Top nav wastes vertical space on wide monitors and collapses badly on mobile.
- A collapsible sidebar (icon-only mode) works on both desktop and mobile.

**Sidebar items:**
```
🏠 Fleet        (fleet overview — landing page)
🖥️ Machines     (machine list/detail)
🤖 Agents       (agent list/detail)  
🩺 Health       (doctor/fleet health)
📋 Logs         (fleet-wide log viewer)
⚙️ Settings     (auth, config, notifications)
```

**Breadcrumb** at the top of content area for drill-down context:
`Fleet > mini4 > claude-main` shows you're looking at agent claude-main on machine mini4.

---

## 4. Screen Designs

### 4.1 Fleet Overview (Landing Page)

This is the most important screen. It must answer: **"Is everything OK?"** in under 2 seconds.

```
┌─────────────────────────────────────────────────────────────────┐
│ 🏠 Fleet Overview                                    [🔄 3s ago]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ mini4    │ │ vps-syd  │ │ vps-sgp  │ │ pi-home  │  ...     │
│  │ ●●●●●●●●│ │ ●●●●●●●●│ │ ●●●●●●○●│ │ ●●●●●●●●│          │
│  │ 5 agents │ │ 4 agents │ │ 3 agents │ │ 4 agents │          │
│  │ ✅ all ok │ │ ✅ all ok │ │ ⚠️ 1 warn│ │ ✅ all ok │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│  Agents                                    [Filter ▾] [Search ]│
│  ┌────────────────────────────────────────────────────────────┐│
│  │ Agent        │ Machine │ Status │ Uptime    │ Channels │ ⚡ ││
│  │──────────────│─────────│────────│───────────│──────────│────││
│  │ 🤖 claude-m  │ mini4   │ ● Run  │ ▁▂▃▅▇▇▇▇ │ TG DC    │▶⏹🔄││
│  │ 🤖 gpt-ops   │ mini4   │ ● Run  │ ▁▁▁▁▇▇▇▇ │ TG       │▶⏹🔄││
│  │ 🤖 support   │ vps-syd │ ● Run  │ ▇▇▇▇▇▇▇▇ │ DC WA    │▶⏹🔄││
│  │ 🤖 monitor   │ vps-sgp │ ⚠ Warn │ ▇▇▇▇▃▁▃▇ │ TG       │▶⏹🔄││
│  │ 🤖 cron-bot  │ pi-home │ ● Stop │ ▁▁▁▁▁▁▁▁ │ —        │▶⏹🔄││
│  └────────────────────────────────────────────────────────────┘│
│                                                                 │
│  Recent Events                                                  │
│  12:03  ⚠️  monitor (vps-sgp) — channel TG reconnecting        │
│  11:58  ✅  claude-main (mini4) — restarted successfully        │
│  11:45  ❌  support (vps-syd) — auth token expired              │
│  11:30  ✅  fleet doctor — all checks passed                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key decisions:**
- **Machine cards at top** — 6 cards max, fits one row. Each has a mini heartbeat bar (Uptime Kuma style) and summary.
- **Agent table below** — the main workspace. Sortable, filterable. Every row has:
  - Status dot (green/yellow/red)
  - Sparkline bar showing uptime over last 24h (Grafana-inspired)
  - Channel badges (TG, DC, WA, etc.)
  - **Inline action buttons** — no need to click into agent detail to restart
- **Recent events feed** — last N events across the fleet. This replaces the stale "last checked" pattern.
- **Auto-refresh indicator** — top right shows "3s ago" and auto-updates every 10s via polling.

### 4.2 Machine Detail

```
┌─────────────────────────────────────────────────────────────────┐
│ Fleet > mini4                                        [🔄 5s ago]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  mini4                                                          │
│  macOS 15.2 • arm64 • Up 14d 3h                                │
│  CPU: ▓▓▓░░░░░░░ 28%  RAM: ▓▓▓▓▓░░░ 62%  Disk: ▓▓░░░░ 33%   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ [Agents]  [System]  [Logs]                                  ││
│  │                                                             ││
│  │ Agent        │ Status │ CPU  │ Mem   │ Restarts │ ⚡        ││
│  │──────────────│────────│──────│───────│──────────│───────────││
│  │ claude-main  │ ● Run  │ 12%  │ 340MB │ 0 (24h) │ ▶⏹🔄     ││
│  │ gpt-ops      │ ● Run  │  8%  │ 220MB │ 1 (24h) │ ▶⏹🔄     ││
│  │ mini4-cron   │ ● Run  │  2%  │  80MB │ 0 (24h) │ ▶⏹🔄     ││
│  │ dev-agent    │ ⏹ Stop │  —   │   —   │ — (24h) │ ▶⏹🔄     ││
│  │ test-agent   │ ⏹ Stop │  —   │   —   │ — (24h) │ ▶⏹🔄     ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Tabs within machine detail:**
- **Agents** (default) — agent table scoped to this machine, with per-agent resource usage
- **System** — OS info, Docker version, disk usage breakdown, network
- **Logs** — machine-level logs (Docker daemon, system logs)

### 4.3 Agent Detail

```
┌─────────────────────────────────────────────────────────────────┐
│ Fleet > mini4 > claude-main                          [🔄 2s ago]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  🤖 claude-main                           [▶ Start] [⏹ Stop] [🔄]│
│  Status: ● Running • Up 3d 7h • PID 42381                      │
│  Model: claude-sonnet-4-20250514 • Channels: Telegram, Discord     │
│                                                                 │
│  ┌─ Health ──────────────────────────────────────────────────┐  │
│  │ ✅ Process running    ✅ Auth valid    ✅ Channels connected │  │
│  │ ✅ Memory OK (340MB)  ⚠️ Disk 82%     ✅ Last msg 2m ago   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ [Overview]  [Channels]  [Logs]  [Config]                    ││
│  │                                                             ││
│  │ Uptime (7 days)                                             ││
│  │ ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●○●●●●●● ││
│  │                                                             ││
│  │ Recent Events                                               ││
│  │ 2h ago   Restarted by user                                  ││
│  │ 1d ago   Channel TG reconnected after timeout               ││
│  │ 3d ago   Started                                            ││
│  │                                                             ││
│  │ Resource Usage                                              ││
│  │ CPU ▓▓░░░░░░░░ 12%    Memory ▓▓▓▓░░░░ 340/512MB           ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**Agent detail tabs:**

1. **Overview** (default) — health chips, uptime bar, recent events, resources
2. **Channels** — per-channel status (connected/disconnected), last message time, reconnect button
3. **Logs** — streaming log viewer (Dozzle-style), with search, level filter, auto-scroll toggle
4. **Config** — read-only view of agent config with an "Edit" button that opens a code editor modal

**Action buttons** are pinned at the top, always visible. When you click an action:
1. Button shows a spinner
2. Button text changes to "Stopping..." / "Starting..."
3. On success: status updates, brief green flash on the status area
4. On failure: **inline error banner** appears below the action buttons with the actual error message. No toast. No silent failure. The error stays visible until dismissed or the next action succeeds.

### 4.4 Health / Doctor

```
┌─────────────────────────────────────────────────────────────────┐
│ 🩺 Fleet Health                              [Run All Checks 🔄]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Summary: 18/20 agents healthy • 2 warnings • 0 critical       │
│  Last full check: 12 minutes ago • Next auto-check: 18 min     │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Check                    │ Pass │ Warn │ Fail │ Status    │  │
│  │──────────────────────────│──────│──────│──────│───────────│  │
│  │ Process running          │  18  │   0  │   2  │ ⚠️        │  │
│  │ Auth tokens valid        │  20  │   0  │   0  │ ✅        │  │
│  │ Channels connected       │  19  │   1  │   0  │ ⚠️        │  │
│  │ Memory under threshold   │  20  │   0  │   0  │ ✅        │  │
│  │ Disk under threshold     │  18  │   2  │   0  │ ⚠️        │  │
│  │ Recent activity (<1h)    │  17  │   3  │   0  │ ⚠️        │  │
│  │ Config valid             │  20  │   0  │   0  │ ✅        │  │
│  │ Version up to date       │  16  │   4  │   0  │ ⚠️        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ⚠️ Warnings (click to expand)                                  │
│  ├─ monitor (vps-sgp): Channel TG disconnected 15m ago          │
│  ├─ cron-bot (pi-home): Process not running                     │
│  └─ dev-agent (mini4): Process not running                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- **Fleet-style compliance view** — each check is a row, showing how many agents pass/warn/fail. You see patterns instantly: "oh, disk is a problem across multiple machines."
- **"Run All Checks" is a single button** that triggers async checks. Each check row updates independently as results come in (no blocking, no timeout).
- **Expandable warnings** list shows specific agents with issues, linking to their detail page.
- **Auto-check schedule** shown so you know when the next automatic run happens.

### 4.5 Logs (Fleet-wide)

```
┌─────────────────────────────────────────────────────────────────┐
│ 📋 Fleet Logs                                                   │
├─────────────────────────────────────────────────────────────────┤
│  Agents: [claude-main ✕] [gpt-ops ✕] [+ Add]                   │
│  Level:  [ALL ▾]  Search: [________________]  [⏸ Pause] [⬇ End]│
├─────────────────────────────────────────────────────────────────┤
│  12:03:14.332  claude-main  INFO   Processing message from TG   │
│  12:03:14.501  gpt-ops      DEBUG  Heartbeat check OK           │
│  12:03:15.112  claude-main  INFO   Response sent (1.2s)         │
│  12:03:15.887  claude-main  WARN   Rate limit approaching       │
│  12:03:16.003  gpt-ops      INFO   Channel reconnect successful │
│  12:03:16.445  claude-main  ERROR  API timeout after 30s        │
│  12:03:17.002  gpt-ops      INFO   Processing scheduled task    │
│  │                                                               │
│  ▼ Auto-scrolling...                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Dozzle-inspired features:**
- **Multi-agent selection** with color-coded source labels per agent
- **Level filter** dropdown (ALL, ERROR, WARN, INFO, DEBUG)
- **Pause/resume** streaming — pause to read, resume to catch up
- **Jump to end** button
- **Search** within visible logs (regex)
- Logs are **streamed, not stored** — the dashboard fetches from each agent's log output in real-time
- Each agent name is colored distinctly and clickable (links to agent detail)

### 4.6 Settings

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚙️ Settings                                                     │
├─────────────────────────────────────────────────────────────────┤
│  [Auth]  [Fleet]  [Notifications]  [About]                      │
│                                                                 │
│  Authentication                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Dashboard Token: ●●●●●●●●●●●●  [👁 Show] [🔄 Rotate]   │    │
│  │ Token expires: Never (persistent)                       │    │
│  │                                                         │    │
│  │ Active Sessions: 2                                      │    │
│  │ • Chrome (this device) — 10m ago                        │    │
│  │ • Safari (iPhone) — 2h ago                              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Session Management                                             │
│  Auth is cookie-based after initial token entry.                │
│  [Revoke All Sessions]                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Technical Architecture

### 5.1 Framework: **Preact + HTM (no build step)**

**Decision: Preact, not React, not Svelte, not vanilla.**

Why:
- **Preact** is 3KB gzipped. It's React-compatible but tiny. For an embedded admin dashboard, bundle size matters.
- **HTM** (Tagged Templates) lets you write JSX-like syntax without a build step: `html\`<div>${content}</div>\``. This means **the dashboard can still be served as a single file** if desired, or broken into modules with a simple bundler.
- **No build step required for development** — you can develop with just a browser and a text editor. But you CAN add a build step (esbuild, 50ms builds) when you want production bundling.
- **Svelte** is great but requires a compiler. It's a bigger commitment for a dashboard that one person maintains.
- **Vanilla web components** sound good in theory but the DX is painful — no reactivity, no efficient diffing, verbose boilerplate.
- **React** is 40KB+ gzipped. Overkill.

The stack:
```
Preact (3KB) + HTM (0.7KB) + Preact Signals (1KB) = ~5KB total
```

That gives you: components, reactivity, hooks, efficient DOM updates. All in 5KB.

### 5.2 CSS: **Single CSS file with CSS custom properties for theming**

- Dark mode by default (current behavior, keep it)
- Light mode via `prefers-color-scheme` media query and a manual toggle
- CSS custom properties (`--bg-primary`, `--text-primary`, etc.) for theming
- No CSS framework. Tailwind is unnecessary for a 6-screen admin dashboard.
- Grid + Flexbox for layout. CSS Container Queries for responsive components.

### 5.3 State Management: **Preact Signals**

- Global state for: fleet data, current user, current route, selected filters
- Components subscribe to signals and re-render automatically
- No Redux, no MobX, no state management library. Signals are built into Preact.

### 5.4 Routing: **Hash-based routing (simple custom router)**

```
#/                    → Fleet Overview
#/machines/:id        → Machine Detail
#/agents/:id          → Agent Detail
#/agents/:id/logs     → Agent Logs
#/health              → Health/Doctor
#/logs                → Fleet Logs
#/settings            → Settings
```

Hash-based routing works without server-side configuration and plays well with single-file deployment.

### 5.5 Real-Time Updates: **SSE (Server-Sent Events), not WebSockets**

**Decision: SSE over WebSockets.**

Why:
- SSE is **simpler** — it's just HTTP. No handshake protocol, no ping/pong, no connection upgrade.
- SSE **works through proxies and load balancers** without special configuration.
- SSE is **one-directional** (server → client), which is exactly what we need. The dashboard doesn't send data to the server in real-time — it uses normal POST/PUT for actions.
- SSE has **built-in reconnection**. If the connection drops, the browser automatically reconnects. WebSockets require manual reconnection logic.
- For **actions** (start/stop/restart), use normal HTTP POST with response. For **status updates and logs**, use SSE streams.

Two SSE endpoints:
1. `GET /api/events` — fleet-wide event stream (agent status changes, health check results)
2. `GET /api/agents/:id/logs/stream` — per-agent log stream

If SSE isn't feasible (e.g., current infra doesn't support long-lived connections), **fall back to polling every 10 seconds.** 10s polling is indistinguishable from real-time for a fleet dashboard. Don't let "real-time" block shipping.

### 5.6 Auth: **Token → Cookie exchange**

Current auth is broken. New flow:

1. **First visit:** Dashboard shows a login screen with a single input: "Enter dashboard token"
2. **Token submission:** POST `/api/auth` with the token. Server validates and returns a `Set-Cookie` with an HTTP-only session cookie (24h expiry, rolling).
3. **Subsequent visits:** Cookie is sent automatically. No token in URL, no token in localStorage, no token in JS memory.
4. **Token rotation:** In Settings, there's a "Rotate Token" button that generates a new token and invalidates the old one. Active cookie sessions remain valid.
5. **Session expiry:** If cookie expires, redirect to login. No "broken page" — just a clean redirect.

**Why cookies over bearer tokens:**
- HTTP-only cookies can't be stolen by XSS
- Automatically sent with every request — no auth header management in JS
- Browser handles expiry and cleanup

### 5.7 Deployment: **Single bundled HTML file (keep this!)**

The current single-file approach is actually a FEATURE, not a bug. It means:
- No static file serving configuration
- Easy to embed in the Node.js server
- Easy to version (one file = one version)
- Works behind any proxy without path configuration

**Keep it.** But build it properly:
- Develop with multiple files (components, styles, routes)
- Use esbuild to bundle into a single HTML file with inlined CSS and JS
- Build output is `dashboard.html` (~80-120KB) — still reasonable for a single-file app

Build command: `esbuild src/index.js --bundle --minify | inject into template.html`

---

## 6. API Design

### 6.1 REST Endpoints

```
Authentication
  POST   /api/auth                    { token } → Set-Cookie + { ok }
  DELETE  /api/auth                    → Clear session
  POST   /api/auth/rotate             → { newToken }

Fleet Overview
  GET    /api/fleet                    → { machines[], agents[], summary }
  GET    /api/fleet/events             → SSE stream of fleet events

Machines
  GET    /api/machines                 → [{ id, name, os, uptime, cpu, mem, disk, agentCount, status }]
  GET    /api/machines/:id             → { ...detail, agents[] }
  GET    /api/machines/:id/metrics     → { cpu, mem, disk, network }

Agents
  GET    /api/agents                   → [{ id, name, machine, status, uptime, channels[], health }]
  GET    /api/agents/:id               → { ...detail, config, channels[], health, recentEvents[] }
  POST   /api/agents/:id/start        → { ok, error? }
  POST   /api/agents/:id/stop         → { ok, error? }
  POST   /api/agents/:id/restart      → { ok, error? }
  POST   /api/agents/:id/pull         → { ok, error? }
  GET    /api/agents/:id/config       → { config }
  PUT    /api/agents/:id/config       → { ok, error? }
  GET    /api/agents/:id/logs         → [{ timestamp, level, message }] (paginated, last 500)
  GET    /api/agents/:id/logs/stream  → SSE stream of log lines

Health / Doctor
  GET    /api/health                   → { checks[], summary, lastRun, nextRun }
  POST   /api/health/run              → 202 Accepted (triggers async check)
  GET    /api/health/stream           → SSE stream of check results as they complete

Settings
  GET    /api/settings                 → { ...settings }
  PUT    /api/settings                 → { ok }
```

### 6.2 API Response Patterns

**Every action endpoint returns a consistent shape:**

```json
// Success
{ "ok": true, "data": { ... } }

// Error
{ "ok": false, "error": "Token expired", "code": "AUTH_TOKEN_EXPIRED" }
```

**Never return bare 200 OK for actions.** Always include confirmation data so the UI can verify the action took effect.

**Health check runs are async:**
1. `POST /api/health/run` returns `202 Accepted` immediately
2. Subscribe to `GET /api/health/stream` (SSE) to receive individual check results as they complete
3. No more timeouts — each check reports independently

### 6.3 Fleet Overview Payload

The landing page makes **one request**: `GET /api/fleet`. This returns everything needed to render:

```json
{
  "machines": [
    {
      "id": "mini4",
      "name": "mini4",
      "os": "macOS 15.2",
      "status": "online",
      "agentCount": 5,
      "agentHealthy": 5,
      "uptimeBar": [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1]
    }
  ],
  "agents": [
    {
      "id": "claude-main",
      "name": "claude-main",
      "machine": "mini4",
      "status": "running",
      "uptimeBar": [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      "channels": ["telegram", "discord"],
      "health": { "ok": true, "warnings": 0, "errors": 0 },
      "lastActivity": "2026-03-30T12:03:14Z"
    }
  ],
  "recentEvents": [
    {
      "time": "2026-03-30T12:03:14Z",
      "level": "warn",
      "agent": "monitor",
      "machine": "vps-sgp",
      "message": "Channel TG reconnecting"
    }
  ],
  "summary": {
    "totalAgents": 20,
    "running": 18,
    "stopped": 2,
    "warnings": 1,
    "errors": 0
  }
}
```

Single request. No waterfall. The dashboard renders instantly.

---

## 7. Implementation Plan

### Phase 0: API Foundation (1-2 days)
**Goal:** Get the REST API working before touching any UI.

- Define the API routes in the BSCS server
- Implement `GET /api/fleet` (aggregate data from existing internals)
- Implement `POST /api/auth` with cookie-based sessions
- Implement agent action endpoints (`start`, `stop`, `restart`)
- Test all endpoints with curl

**Why first:** The current dashboard's problems are 50% API and 50% UI. If the API is solid, even a rough UI works. If the API is flaky, even a beautiful UI fails.

### Phase 1: Fleet Overview + Agent Actions (2-3 days)
**Goal:** Replace the current dashboard landing page.

- Set up Preact + HTM + Signals project structure
- Build the sidebar layout shell
- Build the Fleet Overview screen (machine cards, agent table, events)
- Wire up agent actions (start/stop/restart) with proper loading/error states
- Build the login screen
- Bundle into single HTML file
- Ship it. The old dashboard is gone.

**Milestone:** Users can see all agents, their status, and take actions. This alone is a massive improvement.

### Phase 2: Agent Detail + Machine Detail (2-3 days)
**Goal:** Drill-down views.

- Build Agent Detail screen with tabs (Overview, Channels, Config)
- Build Machine Detail screen with tabs (Agents, System)
- Implement breadcrumb navigation
- Wire up config viewing

### Phase 3: Logs (1-2 days)
**Goal:** Streaming log viewer.

- Implement SSE endpoint for log streaming (or fall back to polling)
- Build the Logs tab on Agent Detail
- Build the fleet-wide Logs screen with multi-agent selection
- Add search, level filter, pause/resume

### Phase 4: Health/Doctor (1-2 days)
**Goal:** Async fleet health checks.

- Refactor doctor checks to run async and report independently
- Implement `POST /api/health/run` and SSE result stream
- Build the Health screen with compliance-style grid
- Add auto-check scheduling

### Phase 5: Polish (1-2 days)
**Goal:** Make it feel good.

- Dark/light mode toggle
- Mobile responsive layout (sidebar collapses to bottom nav on mobile)
- Keyboard shortcuts (/ for search, r for refresh, j/k for navigation)
- Settings screen
- Loading skeletons instead of spinners
- Error boundaries (component errors don't crash the whole page)

### Total: ~8-12 days of focused work

This is not a "rebuild everything from scratch over 3 months" plan. It's an incremental replacement where each phase ships a working improvement.

---

## 8. What to Keep vs Rebuild

### Keep
- **Single HTML file deployment model.** It works. Just build it properly.
- **Dark mode default.** Ops dashboards should be dark.
- **The BSCS server itself.** The dashboard is just a frontend. Don't rewrite the backend.
- **Existing agent management logic.** The server already knows how to start/stop/restart agents. Just expose it through clean API endpoints.

### Rebuild
- **The entire frontend.** The current 50KB HTML blob is not salvageable. Component architecture from scratch.
- **Auth flow.** Token → cookie exchange, proper session management, no more broken pages.
- **Doctor/health checks.** Async, non-blocking, individual reporting. No more timeout.
- **Action handling.** Loading states, error states, confirmation. No more silent failures.
- **Navigation.** Sidebar + breadcrumbs + hash routing. Proper information hierarchy.

### Add (new)
- **SSE event stream** for real-time status updates
- **Machine-level views** (the current dashboard probably doesn't have this)
- **Fleet-wide log viewer** with multi-agent merge
- **Compliance-style health view** (inspired by Fleet)
- **Heartbeat uptime bars** (inspired by Uptime Kuma)
- **Inline sparklines** for agent uptime trends

---

## Appendix: Why Not [Alternative]?

**"Why not use Grafana for monitoring?"**
Because BSCS needs an operations dashboard, not an analytics dashboard. You need to start/stop/restart agents, view configs, check health. Grafana can't do any of that.

**"Why not use Portainer since agents are in Docker?"**
Because Portainer manages containers, not agents. BSCS agents have higher-level concepts (channels, configs, health checks, auth tokens) that Docker doesn't know about.

**"Why not a full React/Next.js app?"**
Because it's a dashboard for 6 machines and 20 agents, maintained by one person. The complexity budget is tiny. Preact + HTM gives you 90% of React's DX in 5% of the bundle size with 0% of the tooling overhead.

**"Why not WebSockets?"**
Because SSE does the same thing for status updates with half the complexity. The dashboard doesn't need bidirectional real-time communication. It needs server → client pushes (status changes, log lines) and client → server requests (actions). SSE + REST covers both.

**"Why not just fix the current dashboard?"**
Because the current dashboard has no component architecture, no state management, no routing, no proper auth, no async patterns. "Fixing" it means rewriting most of it anyway. Better to start clean with a proper foundation and ship incrementally.

---

*End of design document.*
