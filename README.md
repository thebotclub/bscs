# @botsquad/bscs

Bot Squad Command Suite — CLI for managing fleets of OpenClaw AI agents.

```
 ██████╗ ███████╗ ██████╗███████╗
 ██╔══██╗██╔════╝██╔════╝██╔════╝
 ██████╔╝███████╗██║     ███████╗
 ██╔══██╗╚════██║██║     ╚════██║
 ██████╔╝███████║╚██████╗███████║
 ╚═════╝ ╚══════╝ ╚═════╝╚══════╝
  Command your AI fleet.
```

## Installation

```bash
npm install -g @botsquad/bscs
```

## Quick Start

```bash
# Check your environment
bscs doctor

# Create a coding agent with Tribunal protection
bscs agent create my-coder --role coding

# Check fleet status
bscs fleet status

# Bootstrap a remote machine
bscs machine bootstrap mini1 --dry-run
```

## Commands

### Core Commands

#### `bscs doctor`
Validate your environment and check dependencies.

```bash
bscs doctor
bscs doctor --json    # JSON output
```

#### `bscs --version`
Display version with ASCII art logo.

### Agent Commands

Manage individual AI agent containers.

#### `bscs agent create <name>`
Create a new agent container.

```bash
# Create a coding agent (installs Tribunal)
bscs agent create my-coder --role coding

# Create with specific model
bscs agent create reviewer --role review --model claude-opus-4

# Preview without creating
bscs agent create test --role brain --dry-run

# JSON output
bscs agent create api-agent --role ops --json
```

**Options:**
- `-r, --role <role>` — Agent role: `coding`, `brain`, `review`, `security`, `ops`, `custom`
- `-i, --image <image>` — Docker image to use
- `-m, --model <model>` — Model override (uses role default if not specified)
- `--no-start` — Create without starting
- `--dry-run` — Preview without changes
- `--json` — JSON output

**Roles and Defaults:**
| Role | Model | Memory | Tribunal |
|------|-------|--------|----------|
| coding | claude-sonnet-4 | 4GB | ✓ Yes |
| brain | claude-opus-4 | 2GB | No |
| review | claude-sonnet-4 | 2GB | No |
| ops | claude-haiku-3.5 | 2GB | No |
| security | (default) | 2GB | No |
| custom | (default) | 2GB | No |

#### `bscs agent destroy <name>`
Remove an agent container.

```bash
bscs agent destroy my-agent
bscs agent destroy my-agent --volumes   # Also remove volumes
bscs agent destroy my-agent --dry-run   # Preview
```

#### `bscs agent status [name]`
Show agent status.

```bash
bscs agent status            # All agents
bscs agent status my-coder   # Specific agent
bscs agent status --json     # JSON output
```

### Fleet Commands

Manage the entire fleet of agents.

#### `bscs fleet init`
Initialize fleet configuration.

```bash
bscs fleet init
bscs fleet init --name my-fleet --controller localhost
```

#### `bscs fleet status`
Show fleet overview.

```bash
bscs fleet status
bscs fleet status --json    # JSON output
```

#### `bscs fleet reconcile`
Ensure running containers match configuration.

```bash
bscs fleet reconcile
bscs fleet reconcile --dry-run   # Preview changes
```

### Machine Commands

Manage machines in the fleet.

#### `bscs machine status`
Show local machine health.

```bash
bscs machine status
bscs machine status --json
```

#### `bscs machine bootstrap <host>`
Bootstrap a remote machine with Docker, Node.js, and OpenClaw.

```bash
# Preview what would be done
bscs machine bootstrap mini1 --dry-run

# Actually bootstrap
bscs machine bootstrap mini1 --user hani --role worker

# With custom SSH port
bscs machine bootstrap 192.168.1.100 -p 2222
```

**Options:**
- `-u, --user <user>` — SSH user (default: root)
- `-p, --port <port>` — SSH port (default: 22)
- `-r, --role <role>` — Machine role: `controller`, `worker`, `gpu`
- `--dry-run` — Preview without changes
- `--json` — JSON output

#### `bscs machine add <host>`
Add an existing machine to fleet config.

```bash
bscs machine add mini2 --user hani --role worker
bscs machine add mini2 --dry-run   # Preview
```

#### `bscs machine remove <host>`
Remove a machine from fleet config.

```bash
bscs machine remove mini2
bscs machine remove mini2 --force   # Remove even with agents
bscs machine remove mini2 --dry-run # Preview
```

### Dashboard

#### `bscs dashboard`
Start the web dashboard.

```bash
bscs dashboard
bscs dashboard --port 3000
```

### Secrets

#### `bscs secrets`
Manage API keys and secrets.

```bash
bscs secrets list
bscs secrets sync
```

### Cost Tracking

#### `bscs cost`
Cost tracking and budget management.

```bash
bscs cost status
bscs cost report --period week
```

## Configuration

Configuration is stored in `~/.config/bscs/config.json`.

### Example Configuration

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
    },
    "mini4": {
      "host": "localhost",
      "user": "hani",
      "role": "controller"
    }
  },
  "defaults": {
    "image": "ghcr.io/thebotclub/bscs:latest",
    "portRange": {
      "start": 19000,
      "end": 19999
    }
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
    }
  }
}
```

## Tribunal Integration

When creating a coding agent with `--role coding`, BSCS automatically:

1. Installs Tribunal via pip/pipx
2. Creates `.tribunal/config.json` with security rules
3. Configures `.claude/settings.json` with hooks

**Tribunal Rules (for coding agents):**
- Prevents file deletion commands
- Blocks dangerous bash commands (`rm -rf`, `sudo`)
- Requires approval for `npm publish` and `git push`
- Logs all tool usage

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error |
| 2 | Partial success (some operations failed) |

## Troubleshooting

### Docker not running

```
Error: Docker is not running
```

**Solution:** Start Docker Desktop or the Docker daemon.

### Permission denied

```
Error: permission denied
```

**Solution:** Ensure your user is in the `docker` group:
```bash
sudo usermod -aG docker $USER
```

### Agent already exists

```
Error: Agent "my-agent" already exists
```

**Solution:** Remove the existing agent first:
```bash
bscs agent destroy my-agent
```

### SSH connection failed

```
Error: SSH connection failed
```

**Solutions:**
1. Ensure SSH key is configured: `ssh-copy-id user@host`
2. Check host is reachable: `ping host`
3. Verify SSH port is correct

### No available ports

```
Error: No available ports in configured range
```

**Solution:** Adjust port range in config:
```json
{
  "defaults": {
    "portRange": {
      "start": 18000,
      "end": 18999
    }
  }
}
```

## Development

```bash
# Clone the repo
git clone https://github.com/thebotclub/bscs.git
cd bscs

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Link for local development
npm link

# Run CLI
bscs --version
```

## License

Apache-2.0 — See [LICENSE](LICENSE)
