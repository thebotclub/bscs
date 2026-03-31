import { signal } from '@preact/signals';
import { html } from 'htm/preact';
import { api } from '../api';
import { navigate } from '../router';
import { fleet, loading, error } from '../signals';
import { fetchFleet as fetchFleetApi } from '../api';

const tokenInput = signal<string>('');
const loginError = signal<string | null>(null);
const connecting = signal<boolean>(false);

export function LoginScreen() {
  async function handleConnect(e: Event) {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) {
      loginError.value = 'Please enter a token';
      return;
    }
    loginError.value = null;
    connecting.value = true;
    try {
      const result = await api.post<{ ok: boolean; message?: string }>('/api/auth', { token });
      if (result.ok) {
        navigate({ type: 'fleet' });
        loading.value = true;
        try {
          fleet.value = await fetchFleetApi();
          error.value = null;
        } catch (err) {
          error.value = err instanceof Error ? err.message : String(err);
        } finally {
          loading.value = false;
        }
      } else {
        loginError.value = result.message ?? 'Authentication failed';
      }
    } catch (err) {
      loginError.value = err instanceof Error ? err.message : 'Connection failed';
    } finally {
      connecting.value = false;
    }
  }

  return html`
    <div class="login-screen">
      <div class="login-card">
        <div class="login-title">BSCS Fleet Dashboard</div>
        <div class="login-subtitle">Enter your dashboard token to connect</div>
        <form onSubmit=${handleConnect}>
          <div class="form-group">
            <label class="form-label" for="token-input">Access Token</label>
            <input
              id="token-input"
              type="password"
              class="form-input"
              placeholder="bscs_..."
              value=${tokenInput.value}
              onInput=${(e: Event) => {
                tokenInput.value = (e.target as HTMLInputElement).value;
              }}
              autocomplete="current-password"
            />
          </div>
          ${loginError.value
            ? html`<div class="login-error">${loginError.value}</div>`
            : null}
          <button
            type="submit"
            class="btn-primary"
            style="margin-top:0.5rem"
            disabled=${connecting.value}
          >
            ${connecting.value
              ? html`<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Connecting…`
              : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  `;
}
