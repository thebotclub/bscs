const attempts = new Map<string, { count: number; resetAt: number }>();

export const MAX_ATTEMPTS = 10;
export const WINDOW_MS = 60_000; // 1 minute

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

export function resetRateLimits(): void {
  attempts.clear();
}
