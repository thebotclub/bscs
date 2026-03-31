import { html } from 'htm/preact';
import { filter, sortBy, filteredAgents } from '../signals';
import { StatusBadge } from './StatusBadge';
import { ChannelBadge } from './ChannelBadge';
import { ActionButtons } from './ActionButtons';
import type { StatusValue } from './StatusBadge';

export function AgentTable() {
  const agents = filteredAgents.value;
  const currentSort = sortBy.value;
  const currentFilter = filter.value;

  function setSort(col: 'name' | 'machine' | 'status') {
    sortBy.value = col;
  }

  function sortIcon(col: 'name' | 'machine' | 'status') {
    if (currentSort !== col) return '';
    return ' ▴';
  }

  return html`
    <div>
      <div class="table-toolbar">
        <input
          class="search-input"
          type="text"
          placeholder="Search agents…"
          value=${currentFilter}
          onInput=${(e: Event) => {
            filter.value = (e.target as HTMLInputElement).value;
          }}
        />
        <span class="table-count">${agents.length} agent${agents.length !== 1 ? 's' : ''}</span>
      </div>
      <table class="agent-table">
        <thead>
          <tr>
            <th
              class=${currentSort === 'name' ? 'sorted' : ''}
              onClick=${() => setSort('name')}
            >
              Name${sortIcon('name')}
            </th>
            <th
              class=${currentSort === 'machine' ? 'sorted' : ''}
              onClick=${() => setSort('machine')}
            >
              Machine${sortIcon('machine')}
            </th>
            <th
              class=${currentSort === 'status' ? 'sorted' : ''}
              onClick=${() => setSort('status')}
            >
              Status${sortIcon('status')}
            </th>
            <th>Channels</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${agents.length === 0
            ? html`
                <tr>
                  <td colspan="5">
                    <div class="empty-state">No agents found</div>
                  </td>
                </tr>
              `
            : agents.map(
                (agent) => html`
                  <tr key=${agent.name}>
                    <td>
                      <span class="agent-name">${agent.name}</span>
                    </td>
                    <td>
                      <span class="agent-machine">${agent.machineName ?? agent.machine}</span>
                    </td>
                    <td>
                      <${StatusBadge} status=${agent.status as StatusValue} />
                    </td>
                    <td>
                      <${ChannelBadge}
                        channels=${agent.role ? [agent.role] : []}
                      />
                    </td>
                    <td>
                      <${ActionButtons}
                        agentName=${agent.name}
                        status=${agent.status}
                      />
                    </td>
                  </tr>
                `,
              )}
        </tbody>
      </table>
    </div>
  `;
}
