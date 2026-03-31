import { signal } from '@preact/signals';
import { html } from 'htm/preact';
import { stopAgent, startAgent, restartAgent } from '../api';
import { fetchFleet as fetchFleetApi } from '../api';
import { fleet, loading } from '../signals';
import { showToast } from './Toast';

// Per-agent in-flight state: agentName -> 'stop' | 'start' | 'restart' | null
const inFlight = signal<Record<string, string | null>>({});
// Per-agent feedback: agentName -> { ok: boolean; message: string } | null
const feedback = signal<Record<string, { ok: boolean; message: string } | null>>({});

async function refreshFleet() {
  loading.value = true;
  try {
    fleet.value = await fetchFleetApi();
  } finally {
    loading.value = false;
  }
}

interface ActionButtonsProps {
  agentName: string;
  status: string;
}

export function ActionButtons({ agentName, status }: ActionButtonsProps) {
  const currentFlight = inFlight.value[agentName] ?? null;
  const currentFeedback = feedback.value[agentName] ?? null;
  const busy = currentFlight !== null;
  const isStopped = status === 'stopped';

  async function doAction(action: 'stop' | 'restart' | 'start') {
    inFlight.value = { ...inFlight.value, [agentName]: action };
    feedback.value = { ...feedback.value, [agentName]: null };
    try {
      let result;
      if (action === 'stop') result = await stopAgent(agentName);
      else if (action === 'start') result = await startAgent(agentName);
      else result = await restartAgent(agentName);

      const fb = { ok: result.ok, message: result.message };
      feedback.value = { ...feedback.value, [agentName]: fb };
      showToast(
        `${agentName}: ${result.message}`,
        result.ok ? 'success' : 'error',
      );
      if (result.ok) {
        await refreshFleet();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      feedback.value = { ...feedback.value, [agentName]: { ok: false, message: msg } };
      showToast(`${agentName}: ${msg}`, 'error');
    } finally {
      inFlight.value = { ...inFlight.value, [agentName]: null };
      // Clear feedback after 3 seconds
      setTimeout(() => {
        feedback.value = { ...feedback.value, [agentName]: null };
      }, 3000);
    }
  }

  return html`
    <span class="action-buttons">
      ${isStopped
        ? html`
            <button
              class="btn btn-restart"
              disabled=${busy}
              onClick=${() => doAction('start')}
              title="Start"
            >
              ${currentFlight === 'start' ? html`<span class="spinner"></span>` : '▶'}
            </button>
          `
        : html`
            <button
              class="btn btn-stop"
              disabled=${busy}
              onClick=${() => doAction('stop')}
              title="Stop"
            >
              ${currentFlight === 'stop' ? html`<span class="spinner"></span>` : '⏹'}
            </button>
          `}
      <button
        class="btn btn-restart"
        disabled=${busy}
        onClick=${() => doAction('restart')}
        title="Restart"
      >
        ${currentFlight === 'restart' ? html`<span class="spinner"></span>` : '↺'}
      </button>
      ${currentFeedback !== null
        ? html`
            <span class=${'action-feedback ' + (currentFeedback.ok ? 'ok' : 'err')}>
              ${currentFeedback.message}
            </span>
          `
        : null}
    </span>
  `;
}
