// API client for BSCS Fleet Dashboard
// Supports cookie auth (set by POST /api/auth)
// Retry logic: 2 retries with 500ms backoff on network errors (not 4xx)

export interface FleetStatus {
  agents: AgentStatus[];
  machines: Record<string, MachineInfo>;
}

export interface AgentStatus {
  name: string;
  status: 'running' | 'stopped' | 'unknown';
  machine: string;
  machineName?: string;
  model?: string;
  role?: string;
  health: string;
  runtime?: string;
  channels?: Array<{ type: string; accountId: string }>;
  cronCount?: number;
  skillsCount?: number;
  modelFallbacks?: string[];
}

export interface MachineInfo {
  name?: string;
  role?: string;
  status?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  output?: string;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

const BASE_URL = '';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('fetch') ||
    err.message.includes('network') ||
    err.message.includes('Failed to fetch') ||
    err.name === 'TypeError'
  );
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
    try {
      const res = await fetch(url, init);
      // Do not retry 4xx errors
      if (res.status >= 400 && res.status < 500) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try {
          const json = JSON.parse(text) as { error?: string; message?: string };
          msg = json.error ?? json.message ?? msg;
        } catch {
          // ignore parse error
        }
        throw new ApiError(msg, res.status);
      }
      const text = await res.text();
      return JSON.parse(text) as T;
    } catch (err) {
      lastError = err;
      // Don't retry ApiErrors (4xx)
      if (err instanceof ApiError) throw err;
      // Only retry on network errors
      if (!isNetworkError(err)) throw err;
      if (attempt === MAX_RETRIES) throw err;
    }
  }
  throw lastError;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api: ApiClient = {
  get<T>(path: string): Promise<T> {
    return request<T>('GET', path);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body);
  },
};

export async function fetchFleet(): Promise<FleetStatus> {
  return api.get<FleetStatus>('/api/fleet');
}

export async function startAgent(name: string): Promise<ActionResult> {
  return api.post<ActionResult>(`/api/agents/${encodeURIComponent(name)}/start`);
}

export async function stopAgent(name: string): Promise<ActionResult> {
  return api.post<ActionResult>(`/api/agents/${encodeURIComponent(name)}/stop`);
}

export async function restartAgent(name: string): Promise<ActionResult> {
  return api.post<ActionResult>(`/api/agents/${encodeURIComponent(name)}/restart`);
}
