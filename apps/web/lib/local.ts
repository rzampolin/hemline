/** Safe localStorage JSON helpers — no-ops during SSR. */

export function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / private mode — profile still lives in memory this session
  }
}

export function removeLocal(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const KEYS = {
  profile: 'hemline:profile:v1',
  saved: 'hemline:saved:v1',
  avoid: 'hemline:avoid:v1',
  vibes: 'hemline:vibes:v1',
  paletteBoost: 'hemline:palette-boost:v1',
  paletteDismissedCards: 'hemline:palette-dismissed:v1',
  colorInviteDismissed: 'hemline:color-invite-dismissed:v1',
  swipedIds: 'hemline:swiped:v1',
} as const;
