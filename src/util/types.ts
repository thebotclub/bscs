import { z } from 'zod';
import { userInfo } from 'os';

// =============================================================================
// Machine Configuration
// =============================================================================

export const MachineRoleSchema = z.enum(['controller', 'worker', 'gpu']);

export const MachineSchema = z.object({
  host: z.string(),
  // Default to the current OS user; consumers can override per-machine
  user: z.string().default(() => userInfo().username || process.env.USER || process.env.LOGNAME || 'root'),
  role: MachineRoleSchema,
  port: z.number().int().min(1).max(65535).default(22),
  sshAlias: z.string().optional(),
});

export type MachineRole = z.infer<typeof MachineRoleSchema>;
export type Machine = z.infer<typeof MachineSchema>;

// =============================================================================
// Docker Configuration
// =============================================================================

export const DockerSecuritySchema = z.object({
  noNewPrivileges: z.boolean().default(true),
  capDropAll: z.boolean().default(true),
  tmpfs: z.boolean().default(true),
  pidsLimit: z.number().default(256),
  readOnlyRootfs: z.boolean().default(false),
});

export const RoleResourcesSchema = z.object({
  memory: z.string().default('2g'),
  pidsLimit: z.number().default(256),
});

export const DockerResourcesSchema = z.object({
  coding: RoleResourcesSchema.default({}),
  review: RoleResourcesSchema.default({}),
  brain: RoleResourcesSchema.default({}),
  ops: RoleResourcesSchema.default({}),
  default: RoleResourcesSchema.default({}),
});

export const DockerConfigSchema = z.object({
  image: z.string().default('ghcr.io/thebotclub/bscs:latest'),
  registry: z.string().default('ghcr.io'),
  security: DockerSecuritySchema.default({}),
  resources: DockerResourcesSchema.default({}),
});

export type DockerSecurity = z.infer<typeof DockerSecuritySchema>;
export type DockerResources = z.infer<typeof DockerResourcesSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;

// =============================================================================
// Model Provider Configuration
// =============================================================================

export const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'llamacpp',
  'litellm',
]);

export const ProviderSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(), // Can be op:// reference
  baseUrl: z.string().optional(),
  local: z.boolean().default(false),
  gpu: z.boolean().default(false),
  enabled: z.boolean().default(true),
  models: z.array(z.string()).optional(), // Available models
});

export type ProviderType = z.infer<typeof ProviderTypeSchema>;
export type Provider = z.infer<typeof ProviderSchema>;

// =============================================================================
// Model Pricing Configuration
// =============================================================================

export const ModelPricingSchema = z.object({
  inputPer1k: z.number(), // Cost per 1k input tokens
  outputPer1k: z.number(), // Cost per 1k output tokens
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;

// =============================================================================
// Agent Configuration
// =============================================================================

export const AgentRoleSchema = z.enum([
  'coding',
  'review',
  'brain',
  'security',
  'ops',
  'marketing',
  'custom',
]);

export const AgentTemplateSchema = z.enum([
  'atlas',
  'vault',
  'cody',
  'coding',
  'review',
  'custom',
]);

export const AgentConfigSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,30}$/, 'Agent name: lowercase alphanumeric + hyphens, 2-31 chars'),
  template: AgentTemplateSchema.default('custom'),
  role: AgentRoleSchema.default('custom'),
  machine: z.string().default('localhost'),
  image: z.string().optional(),
  model: z.string().optional(),
  runtime: z.enum(['docker', 'native']).default('docker'),
  container: z.string().optional(),
  configPath: z.string().optional(),
  ports: z
    .object({
      gateway: z.number().int().min(1).max(65535).optional(),
      remote: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
  created: z.string().optional(),
  status: z.enum(['running', 'stopped', 'created']).optional(),
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// =============================================================================
// Secret Configuration
// =============================================================================

export const SecretRefSchema = z.object({
  ref: z.string(), // op://vault/item/field
  provider: z.string().optional(), // Which provider this secret is for
  lastSynced: z.string().optional(),
  status: z.enum(['valid', 'invalid', 'unknown']).optional(),
});

export type SecretRef = z.infer<typeof SecretRefSchema>;

// =============================================================================
// Cost Configuration
// =============================================================================

export const BudgetConfigSchema = z.object({
  daily: z.number().optional(), // Daily budget in USD
  weekly: z.number().optional(), // Weekly budget in USD
  monthly: z.number().optional(), // Monthly budget in USD
  alertThreshold: z.number().default(0.8), // Alert at 80% of budget
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// =============================================================================
// Main BSCS Configuration
// =============================================================================

export const BscsConfigSchema = z.object({
  version: z.string().default('1.0'),
  fleet: z
    .object({
      name: z.string().optional(),
      controller: z.string().optional(),
      domain: z.string().optional(),
    })
    .optional(),
  machines: z.record(z.string(), MachineSchema).optional(),
  docker: DockerConfigSchema.default({}),
  agents: z.record(z.string(), AgentConfigSchema).optional(),
  defaults: z
    .object({
      image: z.string().default('ghcr.io/thebotclub/bscs:latest'),
      portRange: z
        .object({
          start: z.number().default(19000),
          end: z.number().default(19999),
        })
        .optional(),
    })
    .optional(),
  models: z
    .object({
      providers: z.record(z.string(), ProviderSchema).default({}),
      defaults: z
        .record(z.string(), z.string())
        .default({ coding: 'claude-sonnet-4', brain: 'claude-opus-4', review: 'claude-sonnet-4' }),
      fallbacks: z.record(z.string(), z.array(z.string())).default({}),
      routing: z
        .object({
          rules: z
            .array(
              z.object({
                condition: z.string(),
                target: z.string(),
              })
            )
            .optional(),
          costThreshold: z.number().optional(),
        })
        .optional(),
      pricing: z.record(z.string(), ModelPricingSchema).optional(),
      agents: z.record(z.string(), z.object({ model: z.string() })).optional(),
    })
    .default({}),
  secrets: z
    .object({
      refs: z.record(z.string(), SecretRefSchema).optional(),
      lastSync: z.string().optional(),
    })
    .optional(),
  budget: BudgetConfigSchema.optional(),
});

export type BscsConfig = z.infer<typeof BscsConfigSchema>;

// =============================================================================
// Agent Status Types
// =============================================================================

export const ContainerStatusSchema = z.enum(['running', 'stopped', 'paused', 'unknown']);

export const HealthStatusSchema = z.enum(['healthy', 'unhealthy', 'unknown']);

export const AgentStatusSchema = z.object({
  name: z.string(),
  containerId: z.string().optional(),
  status: ContainerStatusSchema,
  health: HealthStatusSchema,
  uptime: z.number().optional(), // seconds
  model: z.string().optional(),
  machine: z.string(),
  port: z.number().optional(),
  role: AgentRoleSchema.optional(),
  template: AgentTemplateSchema.optional(),
});

export type ContainerStatus = z.infer<typeof ContainerStatusSchema>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// =============================================================================
// Provider Status Types
// =============================================================================

export const ProviderStatusSchema = z.object({
  name: z.string(),
  type: ProviderTypeSchema,
  enabled: z.boolean(),
  local: z.boolean(),
  status: z.enum(['healthy', 'unhealthy', 'unknown']),
  latencyMs: z.number().optional(),
  modelCount: z.number().optional(),
  error: z.string().optional(),
});

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

// =============================================================================
// Cost Report Types
// =============================================================================

export const CostEntrySchema = z.object({
  timestamp: z.string(),
  agent: z.string(),
  model: z.string(),
  provider: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
});

export const CostReportSchema = z.object({
  period: z.object({
    start: z.string(),
    end: z.string(),
  }),
  total: z.number(),
  entries: z.array(CostEntrySchema).optional(),
  byAgent: z.record(z.string(), z.number()).optional(),
  byModel: z.record(z.string(), z.number()).optional(),
  byProvider: z.record(z.string(), z.number()).optional(),
  budget: z
    .object({
      limit: z.number(),
      spent: z.number(),
      percent: z.number(),
    })
    .optional(),
});

export type CostEntry = z.infer<typeof CostEntrySchema>;
export type CostReport = z.infer<typeof CostReportSchema>;
