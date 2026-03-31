import { html } from 'htm/preact';
import { fleet, machines, selectedMachine } from '../signals';

export function MachineCards() {
  const f = fleet.value;
  const allMachines = machines.value;

  if (!f || allMachines.length === 0) return null;

  function handleCardClick(machine: string) {
    if (selectedMachine.value === machine) {
      selectedMachine.value = null;
    } else {
      selectedMachine.value = machine;
    }
  }

  return html`
    <div class="machine-cards">
      ${allMachines.map((m) => {
        const info = f.machines[m];
        const label = info?.name ?? m;
        const agentsOnMachine = f.agents.filter((a) => a.machine === m);
        const running = agentsOnMachine.filter((a) => a.status === 'running').length;
        const total = agentsOnMachine.length;
        const dotStatus = running === total && total > 0 ? 'running' : running > 0 ? 'unknown' : 'stopped';
        const isSelected = selectedMachine.value === m;

        return html`
          <div
            key=${m}
            class=${'machine-card' + (isSelected ? ' selected' : '')}
            onClick=${() => handleCardClick(m)}
          >
            <div class="machine-card-name">
              <span class=${'status-dot ' + dotStatus}></span>
              ${label}
            </div>
            <div class="machine-card-count">${running}/${total} running</div>
          </div>
        `;
      })}
    </div>
  `;
}
