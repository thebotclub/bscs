/**
 * Template: Generate workspace directory structure for agents.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

// Agent name must match the schema regex — prevents path traversal
const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

function assertSafeName(name: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name "${name}": must match ^[a-z][a-z0-9-]{1,30}$`);
  }
}

function assertPathWithin(base: string, target: string): void {
  const resolved = resolve(target);
  const baseResolved = resolve(base);
  if (!resolved.startsWith(baseResolved + '/') && resolved !== baseResolved) {
    throw new Error(`Path traversal detected: "${target}" is not within "${base}"`);
  }
}

export interface WorkspaceOptions {
  basePath: string;
  agentName: string;
  role: string;
  model?: string;
}

const AGENTS_MD = (name: string) => `# AGENTS.md - ${name}

This is the workspace for agent **${name}**.

## Guidelines
- Read SOUL.md for persona and tone
- Check memory/ for recent context
- Follow standard operating procedures
`;

const SOUL_MD = (name: string, role: string) => `# SOUL.md - ${name}

## Role
${role}

## Core Traits
- Be helpful, direct, and competent
- Act within your role boundaries
- Ask before taking destructive actions

## Boundaries
- Private data stays private
- Ask before external actions
- Be careful with credentials
`;

const MEMORY_MD = `# MEMORY.md

Long-term memory for this agent. Updated periodically.

## Key Information
_(Nothing recorded yet)_
`;

export function generateWorkspace(options: WorkspaceOptions): string[] {
  const { basePath, agentName, role } = options;
  assertSafeName(agentName);
  const created: string[] = [];

  // Create directories
  const dirs = [basePath, join(basePath, 'memory')];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  // Create files
  const files: Array<{ path: string; content: string }> = [
    { path: join(basePath, 'AGENTS.md'), content: AGENTS_MD(agentName) },
    { path: join(basePath, 'SOUL.md'), content: SOUL_MD(agentName, role) },
    { path: join(basePath, 'MEMORY.md'), content: MEMORY_MD },
  ];

  for (const file of files) {
    if (!existsSync(file.path)) {
      writeFileSync(file.path, file.content);
      created.push(file.path);
    }
  }

  return created;
}

export function getWorkspacePath(basePath: string, agentName: string): string {
  assertSafeName(agentName);
  const p = join(basePath, 'agents', agentName, 'workspace');
  assertPathWithin(basePath, p);
  return p;
}
