'use client';

/**
 * Local-first anonymous profile (PRODUCT_SPEC A2): context + localStorage,
 * synced through the typed API client. No account wall anywhere.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ColorSeason, ProfilePatch, SwipeEvent, UserProfile } from '@hemline/contracts';
import { api, getSavedIds, setSavedIds } from './api';
import { KEYS, readLocal, removeLocal, writeLocal } from './local';

interface ProfileStore {
  profile: UserProfile | null;
  loading: boolean;
  savedIds: string[];
  paletteBoost: boolean;
  update: (patch: ProfilePatch) => Promise<void>;
  setBrandSizes: (sizes: { brand: string; sizeLabel: string }[]) => Promise<void>;
  toggleSave: (listingId: string, context?: SwipeEvent['context']) => void;
  isSaved: (listingId: string) => boolean;
  recordSwipes: (events: SwipeEvent[]) => Promise<void>;
  setPaletteBoost: (enabled: boolean) => void;
  dismissPaletteChip: (listingId: string) => void;
  setSeason: (season: ColorSeason) => Promise<void>;
  clearPalette: () => Promise<void>;
  reset: () => Promise<void>;
}

const Ctx = createContext<ProfileStore | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedIds, setSaved] = useState<string[]>([]);
  const [paletteBoost, setBoost] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getSession()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setSaved(getSavedIds()); // instant local echo…
        // server-persisted global toggle (spec D2, QA P1 #1); localStorage is
        // the fallback for mock mode / profiles minted before the field
        setBoost(p.paletteBoostEnabled ?? readLocal<boolean>(KEYS.paletteBoost, true));
        // …then the server rack is authoritative (live mode; mock reads local)
        api
          .getSavedIdsRemote()
          .then((ids) => {
            if (cancelled) return;
            setSaved(ids);
            setSavedIds(ids);
          })
          .catch(() => {});
      })
      .catch(() => {
        /* stay in loading-failed state; pages show their own errors */
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: ProfilePatch) => {
    setProfile((prev) => (prev ? { ...prev, ...patch } : prev)); // optimistic
    const next = await api.patchProfile(patch);
    setProfile(next);
  }, []);

  const setBrandSizes = useCallback(async (sizes: { brand: string; sizeLabel: string }[]) => {
    setProfile((prev) => (prev ? { ...prev, brandSizes: sizes } : prev));
    const next = await api.putBrandSizes(sizes);
    setProfile(next);
  }, []);

  const toggleSave = useCallback((listingId: string, context: SwipeEvent['context'] = 'feed') => {
    setSaved((prev) => {
      const has = prev.includes(listingId);
      const next = has ? prev.filter((id) => id !== listingId) : [...prev, listingId];
      setSavedIds(next);
      // real rack endpoints (POST /api/saves, DELETE /api/saves/:id) in live
      // mode; mock mode records a 'save' swipe so taste learning stays at parity
      if (has) void api.unsave(listingId).catch(() => {});
      else void api.save(listingId, context).catch(() => {});
      return next;
    });
  }, []);

  const isSaved = useCallback((listingId: string) => savedIds.includes(listingId), [savedIds]);

  const recordSwipes = useCallback(async (events: SwipeEvent[]) => {
    if (events.length === 0) return;
    const { styleTags } = await api.postSwipes(events);
    setProfile((prev) => (prev ? { ...prev, styleTags } : prev));
    const saves = events.filter((e) => e.verdict === 'save').map((e) => e.listingId);
    if (saves.length) {
      setSaved((prev) => {
        const next = [...new Set([...prev, ...saves])];
        setSavedIds(next);
        return next;
      });
    }
  }, []);

  const setPaletteBoost = useCallback((enabled: boolean) => {
    setBoost(enabled); // optimistic
    writeLocal(KEYS.paletteBoost, enabled); // mock-mode + pre-sync parity
    // persist on the profile so /api/rank honors it server-side (QA P1 #1)
    setProfile((prev) => (prev ? { ...prev, paletteBoostEnabled: enabled } : prev));
    void api
      .patchProfile({ paletteBoostEnabled: enabled })
      .then(setProfile)
      .catch(() => {}); // optimistic state stands; next session re-syncs
  }, []);

  const dismissPaletteChip = useCallback((listingId: string) => {
    const dismissed = readLocal<string[]>(KEYS.paletteDismissedCards, []);
    writeLocal(KEYS.paletteDismissedCards, [...new Set([...dismissed, listingId])]);
  }, []);

  const setSeason = useCallback(async (season: ColorSeason) => {
    const next = await api.putColorSeason({ season });
    setProfile(next);
  }, []);

  const clearPalette = useCallback(async () => {
    await update({ colorSeason: null, palette: [] });
    removeLocal(KEYS.paletteDismissedCards);
  }, [update]);

  const reset = useCallback(async () => {
    for (const key of Object.values(KEYS)) removeLocal(key);
    setSaved([]);
    setBoost(true);
    setLoading(true);
    try {
      const p = await api.getSession(); // mints a fresh anonymous profile in mock mode
      setProfile(p);
    } finally {
      setLoading(false);
    }
  }, []);

  const value = useMemo<ProfileStore>(
    () => ({
      profile,
      loading,
      savedIds,
      paletteBoost,
      update,
      setBrandSizes,
      toggleSave,
      isSaved,
      recordSwipes,
      setPaletteBoost,
      dismissPaletteChip,
      setSeason,
      clearPalette,
      reset,
    }),
    [profile, loading, savedIds, paletteBoost, update, setBrandSizes, toggleSave, isSaved, recordSwipes, setPaletteBoost, dismissPaletteChip, setSeason, clearPalette, reset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProfile(): ProfileStore {
  const store = useContext(Ctx);
  if (!store) throw new Error('useProfile must be used inside <ProfileProvider>');
  return store;
}
