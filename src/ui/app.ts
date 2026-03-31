import { render } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { currentRoute, initRouter, navigate } from './router';
import { fleet, loading, error } from './signals';
import { fetchFleet as fetchFleetApi } from './api';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar } from './components/Sidebar';
import { MachineCards } from './components/MachineCards';
import { AgentTable } from './components/AgentTable';
import { ToastContainer } from './components/Toast';

const sidebarOpen = signal<boolean>(false);

async function loadFleet() {
  loading.value = true;
  error.value = null;
  try {
    fleet.value = await fetchFleetApi();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('403')) {
      navigate({ type: 'login' });
    } else {
      error.value = msg;
    }
  } finally {
    loading.value = false;
  }
}

function FleetView() {
  const isLoading = loading.value;
  const err = error.value;

  return html`
    <div class="main-content">
      <div class="page-header">
        <button
          class="mobile-menu-btn"
          onClick=${() => { sidebarOpen.value = true; }}
        >☰</button>
        <span class="page-title">Fleet Overview</span>
        <button
          class="refresh-btn"
          disabled=${isLoading}
          onClick=${loadFleet}
        >
          ${isLoading ? html`<span class="spinner"></span>` : '↻'} Refresh
        </button>
      </div>
      ${err ? html`<div class="error-banner">⚠ ${err}</div>` : null}
      ${isLoading && !fleet.value
        ? html`
            <div class="loading-overlay">
              <span class="spinner spinner-lg"></span>
              Loading fleet data…
            </div>
          `
        : html`
            <${MachineCards} />
            <${AgentTable} />
          `}
    </div>
  `;
}

function App() {
  const route = currentRoute.value;

  if (route.type === 'login') {
    return html`<${LoginScreen} />`;
  }

  const isOpen = sidebarOpen.value;

  return html`
    <div class="app-shell">
      ${isOpen
        ? html`
            <div
              class="sidebar-backdrop open"
              onClick=${() => { sidebarOpen.value = false; }}
            ></div>
          `
        : null}
      <${Sidebar}
        open=${isOpen}
        onClose=${() => { sidebarOpen.value = false; }}
      />
      <${FleetView} />
      <${ToastContainer} />
    </div>
  `;
}

// Mount the app
const root = document.getElementById('app');
if (root) {
  initRouter();

  // Try to load fleet on startup; redirect to login on 401
  void loadFleet().catch(() => {
    navigate({ type: 'login' });
  });

  render(html`<${App} />`, root);
}
