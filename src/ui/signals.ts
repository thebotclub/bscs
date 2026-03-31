import { signal, computed } from '@preact/signals';
import type { FleetStatus, AgentStatus } from './api';

export const fleet = signal<FleetStatus | null>(null);
export const loading = signal<boolean>(false);
export const error = signal<string | null>(null);
export const filter = signal<string>('');
export const sortBy = signal<'name' | 'machine' | 'status'>('name');
export const selectedMachine = signal<string | null>(null);

// Computed: filtered + sorted agents
export const filteredAgents = computed<AgentStatus[]>(() => {
  const f = fleet.value;
  if (!f) return [];

  const filterText = filter.value.toLowerCase().trim();
  const machine = selectedMachine.value;
  const sort = sortBy.value;

  let agents = f.agents.slice();

  if (machine !== null) {
    agents = agents.filter((a) => a.machine === machine);
  }

  if (filterText) {
    agents = agents.filter(
      (a) =>
        a.name.toLowerCase().includes(filterText) ||
        (a.machineName ?? a.machine).toLowerCase().includes(filterText) ||
        (a.role ?? '').toLowerCase().includes(filterText),
    );
  }

  agents.sort((a, b) => {
    let av: string;
    let bv: string;
    if (sort === 'name') {
      av = a.name;
      bv = b.name;
    } else if (sort === 'machine') {
      av = a.machineName ?? a.machine;
      bv = b.machineName ?? b.machine;
    } else {
      av = a.status;
      bv = b.status;
    }
    return av.localeCompare(bv);
  });

  return agents;
});

// Computed: unique machines from fleet data
export const machines = computed<string[]>(() => {
  const f = fleet.value;
  if (!f) return [];
  const seen = new Set<string>();
  for (const agent of f.agents) {
    seen.add(agent.machine);
  }
  // Also include machines from the machines map
  for (const key of Object.keys(f.machines)) {
    seen.add(key);
  }
  return Array.from(seen).sort();
});
