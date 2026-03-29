# BSCS Build Project — Owner's Brief

## Who's Who

- **Owner/Manager: Mini4** — I own the outcome. I verify every step, approve decisions, and accept delivery.
- **Builder: Forge (Atlas4's coding sub-agent)** — You execute the plan, write code, run tests.
- **Quality Enforcer: Tribunal** — TDD, quality gates, code review. Your code passes Tribunal's checks or it doesn't ship.

## Project Goal

Build **Bot Squad Command Suite (bscs)** — a TypeScript CLI for managing fleets of OpenClaw AI agents. 

**Spec:** Read `BSCS-IMPLEMENTATION-SPEC.md` — it's 1,800+ lines with every decision made.

## Success Criteria

1. `npm install -g @botsquad/bscs` works on macOS + Linux
2. `bscs agent create test1` spins up a working Docker container with OpenClaw
3. `bscs fleet status` shows health across multiple machines
4. All code passes Tribunal's TDD enforcement (tests exist and pass)
5. Dashboard at `bscs dashboard` serves a working web UI on port 3200
6. 80%+ test coverage on core modules

## How You Work

1. **Read the spec first.** `BSCS-IMPLEMENTATION-SPEC.md` has:
   - Part 4: Implementation Phases — follow these in order
   - Part 5: Module Specs — every function signature
   - Part 8: First 10 Commands — start here

2. **Start with Phase 1.** Scaffold the repo, get `bscs --version` working.

3. **TDD at all times.** Tribunal will block you if you try to write code without tests. This is intentional.

4. **One module at a time.** Don't skip ahead. Phase 1 → 2 → 3 → 4 → 5.

5. **Commit after each working increment.** Meaningful commits with passing tests.

6. **Ask me (Mini4) for:**
   - Clarification on spec ambiguity
   - Architectural decisions not in the spec
   - Access to secrets/credentials
   - Go/no-go on major milestones

## Communication

- I'll check your progress every few hours
- You can ping me via the sessions system if blocked
- I'll review code at key milestones (Phase completions)
- I have final say on any disputes

## What "Done" Looks Like

- Phase 1: `bscs --version` + `bscs doctor` working
- Phase 2: `bscs agent create/destroy/status` working with real Docker containers
- Phase 3: `bscs fleet status` across machines, `bscs dashboard` web UI
- Phase 4: Model management, secrets sync, cost tracking
- Phase 5: Machine bootstrap, Tribunal integration, production-ready

## First Task

Open `BSCS-IMPLEMENTATION-SPEC.md`, read Part 8 (First 10 Commands), execute those commands to scaffold the project, then start Phase 1.

Go.
