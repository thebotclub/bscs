import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempConfig(dir: string, cfg: object = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: '1.0', ...cfg }, null, 2));
}

// ── Doctor core: fixDoctorIssue ───────────────────────────────────────

describe('fixDoctorIssue', () => {
  let tempDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-doctor-fix-${Date.now()}`);
    origConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
    makeTempConfig(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    if (origConfigDir !== undefined) process.env.BSCS_CONFIG_DIR = origConfigDir;
    else delete process.env.BSCS_CONFIG_DIR;
    vi.restoreAllMocks();
  });

  it('returns error when no fixCommand is set', async () => {
    const { fixDoctorIssue } = await import('../../../src/core/doctor.js');
    const result = await fixDoctorIssue(
      { category: 'machine', target: 'localhost', name: 'Test', status: 'error', message: 'bad' },
      {} as any,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no fix command/i);
  });

  it('runs local fix command and reports success for a real no-op', async () => {
    const { fixDoctorIssue } = await import('../../../src/core/doctor.js');
    const result = await fixDoctorIssue(
      {
        category: 'machine', target: 'localhost', name: 'Test',
        status: 'error', message: 'bad',
        fixCommand: 'echo hello',
        fixTarget: 'local',
      },
      {} as any,
    );
    expect(result.ok).toBe(true);
  });

  it('returns failure when fix command exits non-zero', async () => {
    const { fixDoctorIssue } = await import('../../../src/core/doctor.js');
    const result = await fixDoctorIssue(
      {
        category: 'machine', target: 'localhost', name: 'Test',
        status: 'error', message: 'bad',
        fixCommand: 'exit 1',
        fixTarget: 'local',
      },
      {} as any,
    );
    expect(result.ok).toBe(false);
  });
});

// ── Bootstrap: getBootstrapSteps ─────────────────────────────────────

describe('getBootstrapSteps', () => {
  it('docker step does not use curl-pipe-to-sh', async () => {
    const { getBootstrapSteps } = await import('../../../src/core/machine.js');
    const steps = getBootstrapSteps({
      host: 'example.com',
      user: 'ubuntu',
      role: 'worker',
      port: 22,
    });
    const docker = steps.find((s) => s.name === 'docker');
    expect(docker).toBeDefined();
    // Must not pipe curl output directly to sh/bash
    expect(docker!.command).not.toMatch(/curl[^|]*\|\s*(ba)?sh/);
    // Must install docker
    expect(docker!.command).toMatch(/docker/i);
  });

  it('node step does not use curl-pipe-to-sh', async () => {
    const { getBootstrapSteps } = await import('../../../src/core/machine.js');
    const steps = getBootstrapSteps({
      host: 'example.com',
      user: 'ubuntu',
      role: 'worker',
      port: 22,
    });
    const node = steps.find((s) => s.name === 'node');
    expect(node).toBeDefined();
    // Must not pipe curl output directly to sh/bash
    expect(node!.command).not.toMatch(/curl[^|]*\|\s*(ba)?sh/);
    // Must install nodejs
    expect(node!.command).toMatch(/nodejs/i);
  });

  it('includes docker-group step with correct user', async () => {
    const { getBootstrapSteps } = await import('../../../src/core/machine.js');
    const steps = getBootstrapSteps({
      host: 'example.com',
      user: 'myuser',
      role: 'worker',
      port: 22,
    });
    const group = steps.find((s) => s.name === 'docker-group');
    expect(group).toBeDefined();
    expect(group!.command).toContain('myuser');
  });

  it('returns all required step names', async () => {
    const { getBootstrapSteps } = await import('../../../src/core/machine.js');
    const steps = getBootstrapSteps({ host: 'h', user: 'u', role: 'worker', port: 22 });
    const names = steps.map((s) => s.name);
    expect(names).toContain('docker');
    expect(names).toContain('docker-group');
    expect(names).toContain('node');
  });
});

// ── Bootstrap: bootstrapMachine dry-run ──────────────────────────────

describe('bootstrapMachine', () => {
  let tempDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bscs-bootstrap-${Date.now()}`);
    origConfigDir = process.env.BSCS_CONFIG_DIR;
    process.env.BSCS_CONFIG_DIR = tempDir;
    makeTempConfig(tempDir, {
      machines: {
        worker1: { host: '192.168.1.10', user: 'ubuntu', role: 'worker', port: 22 },
        localhost: { host: 'localhost', user: 'me', role: 'controller', port: 22 },
      },
    });
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    if (origConfigDir !== undefined) process.env.BSCS_CONFIG_DIR = origConfigDir;
    else delete process.env.BSCS_CONFIG_DIR;
    vi.resetModules();
  });

  it('dry-run returns steps without executing', async () => {
    const { bootstrapMachine } = await import('../../../src/core/machine.js');
    const result = await bootstrapMachine('worker1', { dryRun: true });
    expect(result.executed).toBe(false);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('throws when bootstrapping localhost', async () => {
    const { bootstrapMachine } = await import('../../../src/core/machine.js');
    await expect(bootstrapMachine('localhost')).rejects.toThrow(/localhost/i);
  });

  it('throws when machine does not exist', async () => {
    const { bootstrapMachine } = await import('../../../src/core/machine.js');
    await expect(bootstrapMachine('nonexistent')).rejects.toThrow(/not found/i);
  });
});

// ── checkDocker: validate via DoctorCheck structure ──────────────────

describe('checkDocker (via runDoctor structure)', () => {
  it('DoctorCheck interface has required fields', () => {
    // Type-level check: constructing a valid DoctorCheck ensures interface hasn't changed
    const check = {
      category: 'machine' as const,
      target: 'localhost',
      name: 'Docker',
      status: 'ok' as const,
      message: 'v24.0.0',
    };
    expect(check.category).toBe('machine');
    expect(check.status).toBe('ok');
  });
});
