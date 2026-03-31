import { describe, it, expect, beforeEach, vi } from 'vitest';
import { currentRoute, navigate, initRouter } from '../../../src/ui/router.js';
import type { Route } from '../../../src/ui/router.js';

beforeEach(() => {
  // Reset to fleet route before each test
  currentRoute.value = { type: 'fleet' };
});

describe('navigate()', () => {
  it('updates currentRoute to fleet', () => {
    navigate({ type: 'fleet' });
    expect(currentRoute.value).toEqual({ type: 'fleet' });
  });

  it('updates currentRoute to login', () => {
    navigate({ type: 'login' });
    expect(currentRoute.value).toEqual({ type: 'login' });
  });

  it('updates currentRoute to machine', () => {
    navigate({ type: 'machine', name: 'server-1' });
    expect(currentRoute.value).toEqual({ type: 'machine', name: 'server-1' });
  });

  it('updates currentRoute to agent', () => {
    navigate({ type: 'agent', name: 'my-agent' });
    expect(currentRoute.value).toEqual({ type: 'agent', name: 'my-agent' });
  });

  it('sets window.location.hash when window is defined', () => {
    const mockWindow = {
      location: { hash: '' },
      addEventListener: vi.fn(),
    };
    const original = globalThis.window;
    // Assign the mock
    Object.defineProperty(globalThis, 'window', {
      value: mockWindow,
      writable: true,
      configurable: true,
    });
    navigate({ type: 'fleet' });
    expect(mockWindow.location.hash).toBe('#fleet');
    Object.defineProperty(globalThis, 'window', {
      value: original,
      writable: true,
      configurable: true,
    });
  });
});

describe('Route types', () => {
  it('fleet route has correct type', () => {
    const route: Route = { type: 'fleet' };
    expect(route.type).toBe('fleet');
  });

  it('login route has correct type', () => {
    const route: Route = { type: 'login' };
    expect(route.type).toBe('login');
  });

  it('machine route has name', () => {
    const route: Route = { type: 'machine', name: 'server-1' };
    expect(route.type).toBe('machine');
    if (route.type === 'machine') {
      expect(route.name).toBe('server-1');
    }
  });

  it('agent route has name', () => {
    const route: Route = { type: 'agent', name: 'agent-42' };
    expect(route.type).toBe('agent');
    if (route.type === 'agent') {
      expect(route.name).toBe('agent-42');
    }
  });
});

describe('currentRoute signal', () => {
  it('starts as fleet route', () => {
    currentRoute.value = { type: 'fleet' };
    expect(currentRoute.value.type).toBe('fleet');
  });

  it('can be changed directly', () => {
    currentRoute.value = { type: 'login' };
    expect(currentRoute.value.type).toBe('login');
  });

  it('navigate changes route signal', () => {
    currentRoute.value = { type: 'fleet' };
    navigate({ type: 'machine', name: 'test' });
    expect(currentRoute.value.type).toBe('machine');
  });
});

describe('initRouter()', () => {
  it('does not throw when window is undefined', () => {
    const original = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(() => initRouter()).not.toThrow();
    Object.defineProperty(globalThis, 'window', {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it('sets up hashchange listener when window exists', () => {
    const listeners: Record<string, EventListener> = {};
    const mockWindow = {
      location: { hash: '#fleet' },
      addEventListener: vi.fn((event: string, handler: EventListener) => {
        listeners[event] = handler;
      }),
    };
    Object.defineProperty(globalThis, 'window', {
      value: mockWindow,
      writable: true,
      configurable: true,
    });
    initRouter();
    expect(mockWindow.addEventListener).toHaveBeenCalledWith('hashchange', expect.any(Function));
    Object.defineProperty(globalThis, 'window', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });
});
