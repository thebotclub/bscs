/**
 * Template: Generate workspace directory structure for agents.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

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
  return join(basePath, 'agents', agentName, 'workspace');
}
