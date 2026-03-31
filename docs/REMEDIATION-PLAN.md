# BSCS Remediation Plan

**Date:** 2026-03-31  
**Scope:** Security hardening, architectural cleanup, UX reliability  
**Principle:** Fix the foundations before adding features. Each phase ships testable, passing code.

---

## Guiding Priorities

1. **Security first** — Eliminate injection vectors. No user/config-derived strings in shell commands.
2. **One source of truth** — Kill duplicated code paths. One API layer, one set of shared utilities.
3. **UX reliability** — Every command should work in TTY and non-TTY contexts (CI, API calls, scripts).
4. **Incremental delivery** — Each phase is independently shippable and improves the codebase even if later phases are delayed.

---

## Phase 1: Command Injection Elimination (CRITICAL — Do First)

**Why:** Every `execSync` / `exec` call that interpolates config-derived strings is a potential RCE. This is the highest-severity class of bug in the codebase and blocks any deployment.

### 1A: `execFileSync` Migration — Core Modules

Replace all shell-interpolated command execution with argument-array variants that bypass shell interpretation entirely.

| File | Line(s) | Current Pattern | Fix |
| ------ | --------- | ---------------- | ----- |
| `src/core/secrets.ts` | 42 | `execSync(\`op read "${ref}"\`)` | `execFileSync('op', ['read', ref])` |
| `src/core/agent.ts` | 106 | `execSync(\`${pipCmd} install tribunal\`)` | `execFileSync(pipCmd, ['install', 'tribunal'])` |
| `src/core/agent.ts` | 95-97 | `execSync('command -v pipx')` | `execFileSync('command', ['-v', 'pipx'])` — or use `which` via `execFileSync` |
| `src/core/tribunal.ts` | 40,49,59-69 | Multiple `execSync` with interpolation | Same pattern: `execFileSync` with arg arrays |
| `src/core/machine.ts` | 200 | `execSync(\`ssh -p ${port} ${user}@${host} '${cmd}'\`)` | `execFileSync('ssh', ['-p', String(port), \`${user}@${host}\`, cmd])` |
| `src/dashboard/server.ts` | 2167-2171 | `execSync(\`open ${url}\`)` | `execFileSync('open', [url])` |

**Tests to add/update:**

- Unit test that `resolveSecret` with a malicious `op://` ref containing shell metacharacters does NOT execute them.
- Unit test that `bootstrapMachine` passes commands as SSH args, not shell strings.

### 1B: SSH Command Builder

The codebase constructs SSH commands in 4+ places with raw string interpolation. Create a single safe builder:

```text
src/util/ssh.ts
```

```typescript
import { execFileSync, type ExecFileSyncOptions } from 'child_process';

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  sshAlias?: string;
}

/**
 * Execute a command on a remote host via SSH using execFileSync (no shell).
 * The remote command is passed as a single string arg to ssh, which is safe
 * because ssh itself handles it — no local shell interpretation occurs.
 */
export function sshExec(
  target: SshTarget,
  remoteCommand: string,
  options?: ExecFileSyncOptions & { timeoutMs?: number },
): string {
  const dest = target.sshAlias || `${target.user}@${target.host}`;
  const args = [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-p', String(target.port || 22),
    dest,
    remoteCommand,
  ];
  return execFileSync('ssh', args, {
    encoding: 'utf-8',
    timeout: options?.timeoutMs || 30000,
    ...options,
  });
}
```

Then replace all raw SSH `execSync` calls in `fleet.ts`, `machine.ts`, `doctor.ts`, and `dashboard/server.ts` with `sshExec()`.

### 1C: Input Validation at System Boundaries

Add validation for config-derived values that flow into commands:

```typescript
// src/util/validation.ts
const SAFE_HOSTNAME = /^[a-zA-Z0-9._-]+$/;
const SAFE_USERNAME = /^[a-zA-Z0-9._-]+$/;

export function validateHostname(host: string): string {
  if (!SAFE_HOSTNAME.test(host)) throw new Error(`Invalid hostname: ${host}`);
  return host;
}

export function validateUsername(user: string): string {
  if (!SAFE_USERNAME.test(user)) throw new Error(`Invalid username: ${user}`);
  return user;
}
```

Apply at Zod schema level in `types.ts` using `.regex()` refinements so invalid values are rejected at config load time, not at command execution time.

**Phase 1 Definition of Done:**

- Zero `execSync` calls with template literal interpolation of user/config values
- All SSH execution goes through `sshExec()`
- Tests prove shell metacharacters are not interpreted
- `bscs doctor`, `bscs agent create`, `bscs fleet status` all still pass

---

## Phase 2: Request Safety & API Hardening

**Why:** The API server is the attack surface when the dashboard is running. Harden it before wider use.

### 2A: Request Body Size Limit

`src/api/auth.ts` reads the entire request body with no cap. Add a limit to prevent memory exhaustion:

```typescript
// src/api/middleware/body.ts
const MAX_BODY_SIZE = 1024 * 64; // 64 KB — generous for any JSON payload

export function readBody(req: IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
```

Replace the `readBody` in `src/api/auth.ts` with an import from this shared module. Apply to any future POST/PUT route handlers.

### 2B: Rate Limiting (Lightweight)

Add a simple in-memory rate limiter for auth endpoints to prevent brute-force token guessing:

```typescript
// src/api/middleware/rate-limit.ts
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60_000;

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}
```

Apply to `POST /api/auth` only. Don't over-engineer — this is a local-network tool.

### 2C: Security Headers

Add baseline security headers to all responses in `src/api/server.ts`:

```typescript
res.setHeader('X-Content-Type-Options', 'nosniff');
res.setHeader('X-Frame-Options', 'DENY');
res.setHeader('Content-Security-Policy', "default-src 'self'");
```

**Phase 2 Definition of Done:**

- POST endpoints reject bodies > 64KB with 413
- Auth endpoint rate-limited to 10 attempts/minute per IP
- Security headers on all responses
- Tests for each middleware

---

## Phase 3: Shared Utilities Extraction (De-duplication)

**Why:** 3 modules define identical `getLocalIps()` / `isLocalMachine()`. Code duplication means bugs get fixed in one place and forgotten elsewhere.

### 3A: Extract `src/util/network.ts`

Move these functions out of `fleet.ts`, `doctor.ts`, and `dashboard/server.ts`:

```text
getLocalIps(): string[]
isLocalMachine(host: string): boolean
getSshTarget(host: string, config: BscsConfig): string
```

Single source, single test file (`test/unit/util/network.test.ts`).

### 3B: Extract `src/util/format.ts`

Move shared formatting:

- `formatUptime(seconds)` — duplicated in `doctor.ts` and `dashboard/server.ts`
- `esc()` HTML escaper — used in dashboard server's inline JS

### 3C: Kill `readBody` duplication

`readBody` exists in both `src/api/auth.ts` and `src/dashboard/server.ts`. After Phase 2A creates `src/api/middleware/body.ts`, update all callers to use it.

**Phase 3 Definition of Done:**

- `grep -r "function getLocalIps" src/` returns exactly 1 result
- `grep -r "function isLocalMachine" src/` returns exactly 1 result
- `grep -r "function readBody" src/` returns exactly 1 result
- All existing tests still pass

---

## Phase 4: Dashboard Consolidation

**Why:** `src/dashboard/server.ts` (2,192 lines) duplicates 80% of `src/api/` functionality with its own auth, routing, CORS, caching, fleet status, agent actions, and inline HTML/JS. Two divergent implementations means bugs, security fixes, and features must be applied twice.

### Strategy: Dashboard CLI → API Server + Static Files

The new `src/api/server.ts` already handles all the API routes the dashboard needs. The Preact UI in `src/ui/` already exists as the replacement frontend. The consolidation path:

### 4A: Verify API Parity

Audit every route in `dashboard/server.ts` and confirm `src/api/` has an equivalent:

| Dashboard Route | API Equivalent | Gap? |
| ---------------- | ---------------- | ------ |
| `GET /api/fleet` | `GET /api/fleet` (fleet.ts) | None |
| `GET /api/agents` | `GET /api/agents` (agents.ts) | None |
| `POST /api/agent` (create) | Missing | **Add** `POST /api/agents` |
| `POST /api/agents/:name/:action` | `POST /api/agents/:name/:action` | None |
| `GET /api/agents/:name/logs` | `GET /api/agents/:name/logs` | None |
| `GET /api/machines` | `GET /api/machines` (machines.ts) | None |
| `GET /api/doctor` | `GET /api/doctor` (doctor.ts) | None |
| `POST /api/doctor/fix` | `POST /api/doctor/fix` (doctor.ts) | None |
| `GET /api/agent/:name/config` | Missing | **Add** to agents.ts |
| `PUT /api/agent/:name/config` | Missing | **Add** to agents.ts |
| Static file serving | Missing | **Add** to server.ts |
| WebSocket | SSE in `src/api/sse.ts` | SSE is simpler, sufficient |

### 4B: Add Missing Routes to `src/api/`

- `POST /api/agents` — create agent (calls `core/agent.ts createAgent`)
- `GET /api/agents/:name/config` — get agent config from bscs config
- `PUT /api/agents/:name/config` — update agent config

### 4C: Add Static File Serving to API Server

Add a handler in `src/api/server.ts` for non-`/api/` paths that serves the built dashboard files from `dist/dashboard/`:

```typescript
// Serve static dashboard files for non-API routes
if (!url.startsWith('/api/')) {
  serveDashboardFile(req, res, url);
  return;
}
```

With proper MIME types, `index.html` fallback for SPA routing, and `Cache-Control` headers.

### 4D: Rewire `bscs dashboard` Command

Change `createDashboardCommand()` to import and call `startApiServer()` from `src/api/server.ts` instead of the old `startDashboardServer()`. Keep the `--open` flag to launch the browser.

### 4E: Deprecate and Remove Old Dashboard Server

Once parity is confirmed and the CLI command is rewired:

1. Mark `src/dashboard/server.ts` as deprecated (one release cycle)
2. Delete it in the next release

**Phase 4 Definition of Done:**

- `bscs dashboard` starts the API server and serves the Preact UI
- All dashboard functionality works through `src/api/` routes
- `src/dashboard/server.ts` is deleted or clearly marked deprecated
- Dashboard test coverage moves to API route tests

---

## Phase 5: Build, Packaging & DX Polish

**Why:** Several rough edges that affect developer experience and CI reliability.

### 5A: Delete Stray `echo` File

```bash
rm echo
```

Add it to `.gitignore` if it might recur (likely from a `echo "..." > echo` typo).

### 5B: Fix Dockerfile

Replace placeholder with a proper multi-stage build:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S bscs && adduser -S bscs -G bscs
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
USER bscs
ENTRYPOINT ["node", "dist/bin/bscs.js"]
```

Key improvements:

- Multi-stage (smaller image, no dev deps or source in production)
- Non-root user
- `--omit=dev` instead of deprecated `--only=production`

### 5C: Add `tsconfig.ui.json`

Currently `src/ui/` is excluded from type-checking. Create a separate config:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  },
  "include": ["src/ui/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Add `"typecheck:ui": "tsc --noEmit -p tsconfig.ui.json"` to `package.json` scripts and run it in CI.

### 5D: `setupTribunal` Non-TTY Safety

`execSync(... { stdio: 'inherit' })` breaks in non-TTY contexts. Change to capture output and log it:

```typescript
const result = execFileSync(pipCmd, ['install', 'tribunal'], {
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 120000,
});
logger.info({ output: result }, 'Tribunal installed');
```

### 5E: Wire Up Integration/E2E Test Configs

The config files exist but `test/integration/` and `test/e2e/` directories don't. Create skeleton directories with a README explaining what goes where:

```text
test/integration/   — Tests that hit real Docker (skipped in CI without Docker)
test/e2e/           — Full CLI invocation tests (bscs doctor, bscs agent create --dry-run)
```

**Phase 5 Definition of Done:**

- `echo` file gone
- `docker build .` produces a working, minimal image
- `npm run typecheck` covers UI code too
- Tribunal setup works in CI (no TTY)
- Integration/E2E test directories exist with at least one test each

---

## Phase 6: Observability & Error UX

**Why:** When things go wrong, users need clear, actionable error messages — not stack traces or silent failures.

### 6A: Structured CLI Error Handling

Wrap top-level CLI commands with a consistent error handler:

```typescript
async function withErrorHandler(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof UserError) {
      // Expected errors: show message only
      console.error(chalk.red(`Error: ${err.message}`));
      if (err.suggestion) console.error(chalk.dim(err.suggestion));
      process.exitCode = 1;
    } else {
      // Unexpected errors: show message + suggest --verbose
      console.error(chalk.red(`Unexpected error: ${(err as Error).message}`));
      console.error(chalk.dim('Run with LOG_LEVEL=debug for details'));
      logger.error({ err }, 'Unhandled error');
      process.exitCode = 2;
    }
  }
}
```

### 6B: Docker Connectivity UX

When Docker is not running, several commands fail with cryptic `ECONNREFUSED` or dockerode errors. Detect early and show:

```text
Docker is not running.

  macOS: open -a Docker
  Linux: sudo systemctl start docker

Then retry: bscs agent create my-coder --role coding
```

### 6C: Port Conflict UX

When `allocatePorts` exhausts the range, the current error is generic. Improve to:

```text
No available ports in range 19000-19999.

You have 500 agents configured. Consider:
  • Removing stopped agents: bscs agent destroy <name>
  • Expanding the port range in ~/.config/bscs/config.json
```

**Phase 6 Definition of Done:**

- No raw stack traces shown to users in normal operation
- Docker-not-running detected and explained before any Docker command
- All resource-exhaustion errors include actionable next steps

---

## Execution Order & Dependencies

```text
Phase 1 (Security)     ← CRITICAL, no dependencies, do first
  │
Phase 2 (API Hardening) ← Builds on Phase 1's patterns
  │
Phase 3 (De-duplication) ← Independent, can parallel with Phase 2
  │
Phase 4 (Dashboard)     ← Depends on Phase 2 + 3 (needs shared utils + hardened API)
  │
Phase 5 (Build/DX)      ← Independent, can start anytime
  │
Phase 6 (Error UX)      ← Can start after Phase 1, improves throughout
```

**Recommended parallel tracks:**

- **Track A (security):** Phase 1 → Phase 2 → Phase 4
- **Track B (quality):** Phase 3 → Phase 5 → Phase 6

---

## What This Plan Does NOT Cover

These are out of scope — they're feature work, not remediation:

- New features (fleet reconcile, agent channels, model switching)
- Performance optimization (SSH connection pooling, Docker API batching)
- Multi-platform CI matrix
- npm publishing pipeline
- Documentation site

Those belong in the existing `IMPLEMENTATION-PLAN.md` feature roadmap, not here.
