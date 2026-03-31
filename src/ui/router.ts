import { signal } from '@preact/signals';

export type Route =
  | { type: 'fleet' }
  | { type: 'machine'; name: string }
  | { type: 'agent'; name: string }
  | { type: 'login' };

export const currentRoute = signal<Route>({ type: 'fleet' });

function routeFromHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (!h || h === 'fleet') return { type: 'fleet' };
  if (h === 'login') return { type: 'login' };
  const machineMatch = /^machine\/(.+)$/.exec(h);
  if (machineMatch) return { type: 'machine', name: decodeURIComponent(machineMatch[1] ?? '') };
  const agentMatch = /^agent\/(.+)$/.exec(h);
  if (agentMatch) return { type: 'agent', name: decodeURIComponent(agentMatch[1] ?? '') };
  return { type: 'fleet' };
}

function routeToHash(route: Route): string {
  switch (route.type) {
    case 'fleet':
      return '#fleet';
    case 'login':
      return '#login';
    case 'machine':
      return `#machine/${encodeURIComponent(route.name)}`;
    case 'agent':
      return `#agent/${encodeURIComponent(route.name)}`;
  }
}

export function navigate(route: Route): void {
  currentRoute.value = route;
  if (typeof window !== 'undefined') {
    window.location.hash = routeToHash(route);
  }
}

export function initRouter(): void {
  if (typeof window === 'undefined') return;

  // Set initial route from current hash
  currentRoute.value = routeFromHash(window.location.hash);

  window.addEventListener('hashchange', () => {
    currentRoute.value = routeFromHash(window.location.hash);
  });
}
