import { html } from 'htm/preact';
import { navigate, currentRoute } from '../router';
import { fleet, machines, selectedMachine } from '../signals';

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const route = currentRoute.value;
  const allMachines = machines.value;
  const f = fleet.value;

  // Compute health summary
  let runningCount = 0;
  let totalCount = 0;
  if (f) {
    totalCount = f.agents.length;
    runningCount = f.agents.filter((a) => a.status === 'running').length;
  }
  const healthLabel = f ? `${runningCount}/${totalCount} running` : 'loading…';
  const isHealthy = f ? runningCount === totalCount : true;

  function handleFleetClick(e: Event) {
    e.preventDefault();
    selectedMachine.value = null;
    navigate({ type: 'fleet' });
    onClose?.();
  }

  function handleMachineClick(machine: string) {
    selectedMachine.value = machine;
    navigate({ type: 'fleet' });
    onClose?.();
  }

  function handleDoctorClick(e: Event) {
    e.preventDefault();
    // Doctor view placeholder
    onClose?.();
  }

  const isFleetActive = route.type === 'fleet' && selectedMachine.value === null;

  return html`
    <nav class=${'sidebar' + (open ? ' open' : '')}>
      <div class="sidebar-logo">⚡ BSCS</div>

      <ul class="sidebar-nav">
        <li class=${isFleetActive ? 'active' : ''}>
          <a href="#fleet" onClick=${handleFleetClick}>
            ◉ Fleet Overview
          </a>
        </li>
        <li>
          <a href="#doctor" onClick=${handleDoctorClick}>
            ♥ Doctor
          </a>
        </li>
      </ul>

      ${allMachines.length > 0
        ? html`
            <div class="sidebar-section-title">Machines</div>
            <ul class="sidebar-nav sidebar-machine-list">
              ${allMachines.map((m) => {
                const info = f?.machines[m];
                const label = info?.name ?? m;
                const isActive = route.type === 'fleet' && selectedMachine.value === m;
                return html`
                  <li key=${m} class=${isActive ? 'active' : ''}>
                    <button onClick=${() => handleMachineClick(m)}>
                      ▸ ${label}
                    </button>
                  </li>
                `;
              })}
            </ul>
          `
        : null}

      <div class="sidebar-footer">
        <div class="sidebar-health-summary">
          <span class=${'health-dot' + (isHealthy ? '' : ' degraded')}></span>
          <span>${healthLabel}</span>
        </div>
      </div>
    </nav>
  `;
}
