/**
 * Template: Generate openclaw.json configuration for new agents.
 */
import type { AgentRole } from '../util/types.js';

export interface AgentConfigTemplate {
  name: string;
  role: AgentRole;
  model: string;
  image: string;
  ports: { gateway: number; remote: number };
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  coding: 'Full-stack coding agent with Tribunal guardrails',
  review: 'Code review and PR analysis agent',
  brain: 'Strategic planning and architecture agent',
  ops: 'DevOps and infrastructure agent',
  security: 'Security analysis and audit agent',
  marketing: 'Content and marketing agent',
  custom: 'General-purpose agent',
};

export function generateOpenclawConfig(template: AgentConfigTemplate): object {
  return {
    version: '1.0',
    agent: {
      name: template.name,
      role: template.role,
      description: ROLE_DESCRIPTIONS[template.role] || ROLE_DESCRIPTIONS['custom'],
    },
    model: {
      default: template.model,
    },
    gateway: {
      bind: `127.0.0.1:${template.ports.gateway}`,
    },
    remote: {
      port: template.ports.remote,
    },
    security: {
      tribunal: template.role === 'coding',
    },
  };
}

export function generateOpenclawConfigJson(template: AgentConfigTemplate): string {
  return JSON.stringify(generateOpenclawConfig(template), null, 2);
}
