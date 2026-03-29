/**
 * Core security module — audit agent configs, baseline recommendations.
 */
import { loadConfig, type BscsConfig } from './config.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('security');

// ── Types ────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info';

export interface AuditFinding {
  severity: Severity;
  category: string;
  message: string;
  agent?: string;
  recommendation?: string;
}

export interface AuditResult {
  timestamp: string;
  findings: AuditFinding[];
  summary: { critical: number; warning: number; info: number; total: number };
  score: number; // 0–100
}

export interface BaselineRecommendation {
  category: string;
  description: string;
  current: string;
  recommended: string;
  applied: boolean;
}

// ── Audit ────────────────────────────────────────────────────────────

export function runSecurityAudit(config?: BscsConfig): AuditResult {
  const cfg = config || loadConfig();
  const findings: AuditFinding[] = [];

  // Check Docker security settings
  const security = cfg.docker?.security;
  if (!security?.noNewPrivileges) {
    findings.push({
      severity: 'critical',
      category: 'docker',
      message: 'noNewPrivileges is not enabled',
      recommendation: 'Set docker.security.noNewPrivileges to true',
    });
  }
  if (!security?.capDropAll) {
    findings.push({
      severity: 'critical',
      category: 'docker',
      message: 'Capabilities are not dropped',
      recommendation: 'Set docker.security.capDropAll to true',
    });
  }
  if (!security?.tmpfs) {
    findings.push({
      severity: 'warning',
      category: 'docker',
      message: 'tmpfs is not enabled for /tmp',
      recommendation: 'Set docker.security.tmpfs to true',
    });
  }
  if ((security?.pidsLimit ?? 0) > 512) {
    findings.push({
      severity: 'warning',
      category: 'docker',
      message: `PID limit is high (${security?.pidsLimit})`,
      recommendation: 'Reduce docker.security.pidsLimit to 256 or lower',
    });
  }

  // Check agent configs
  if (cfg.agents) {
    for (const [name, agent] of Object.entries(cfg.agents)) {
      // Check for inline API keys (not op:// refs)
      if (agent.model && cfg.models?.providers) {
        for (const [, provider] of Object.entries(cfg.models.providers)) {
          if (
            provider.apiKey &&
            !provider.apiKey.startsWith('op://') &&
            provider.apiKey.length > 10
          ) {
            findings.push({
              severity: 'critical',
              category: 'secrets',
              message: 'Inline API key detected (not using 1Password reference)',
              agent: name,
              recommendation: 'Use op:// references for API keys',
            });
            break; // Only report once per agent
          }
        }
      }

      // Check ports exposed on all interfaces
      if (agent.ports) {
        findings.push({
          severity: 'info',
          category: 'network',
          message: `Agent has ports exposed: ${agent.ports.gateway}/${agent.ports.remote}`,
          agent: name,
          recommendation: 'Ensure ports are bound to 127.0.0.1 only',
        });
      }
    }
  }

  // Check if budget is configured
  if (!cfg.budget?.daily) {
    findings.push({
      severity: 'warning',
      category: 'cost',
      message: 'No daily budget limit configured',
      recommendation: 'Set a daily budget with bscs cost budget --daily <amount>',
    });
  }

  const summary = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    total: findings.length,
  };

  // Score: start at 100, deduct per finding
  const score = Math.max(
    0,
    100 - summary.critical * 25 - summary.warning * 10 - summary.info * 2,
  );

  const result: AuditResult = {
    timestamp: new Date().toISOString(),
    findings,
    summary,
    score,
  };

  logger.info({ score, findings: summary.total }, 'Security audit complete');
  return result;
}

// ── Baseline ─────────────────────────────────────────────────────────

export function getSecurityBaseline(config?: BscsConfig): BaselineRecommendation[] {
  const cfg = config || loadConfig();
  const security = cfg.docker?.security;

  return [
    {
      category: 'docker',
      description: 'Drop all Linux capabilities',
      current: security?.capDropAll ? 'enabled' : 'disabled',
      recommended: 'enabled',
      applied: security?.capDropAll === true,
    },
    {
      category: 'docker',
      description: 'Prevent privilege escalation (no_new_privs)',
      current: security?.noNewPrivileges ? 'enabled' : 'disabled',
      recommended: 'enabled',
      applied: security?.noNewPrivileges === true,
    },
    {
      category: 'docker',
      description: 'Use tmpfs for /tmp',
      current: security?.tmpfs ? 'enabled' : 'disabled',
      recommended: 'enabled',
      applied: security?.tmpfs === true,
    },
    {
      category: 'docker',
      description: 'Read-only root filesystem',
      current: security?.readOnlyRootfs ? 'enabled' : 'disabled',
      recommended: 'enabled',
      applied: security?.readOnlyRootfs === true,
    },
    {
      category: 'docker',
      description: 'PID limit per container',
      current: String(security?.pidsLimit ?? 'not set'),
      recommended: '256',
      applied: (security?.pidsLimit ?? 0) <= 256 && (security?.pidsLimit ?? 0) > 0,
    },
    {
      category: 'secrets',
      description: 'Use 1Password references for API keys',
      current: hasInlineKeys(cfg) ? 'inline keys found' : 'op:// references',
      recommended: 'op:// references',
      applied: !hasInlineKeys(cfg),
    },
    {
      category: 'cost',
      description: 'Daily budget limit',
      current: cfg.budget?.daily ? `$${cfg.budget.daily}` : 'not set',
      recommended: 'set',
      applied: cfg.budget?.daily !== undefined,
    },
  ];
}

function hasInlineKeys(cfg: BscsConfig): boolean {
  if (!cfg.models?.providers) return false;
  return Object.values(cfg.models.providers).some(
    (p) => p.apiKey && !p.apiKey.startsWith('op://') && p.apiKey.length > 10,
  );
}
