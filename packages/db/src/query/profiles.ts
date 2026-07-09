/**
 * User/profile repository — GET/PATCH profile, brand sizes.
 * All writes validate upstream with @hemline/contracts Zod schemas (routes);
 * this layer maps contract shapes ⇄ rows.
 */
import { eq } from 'drizzle-orm';
import type { ProfilePatch, UserProfile } from '@hemline/contracts';
import type { Db } from '../client';
import { userBrandSizes, users } from '../schema';
import { rowToUserProfile } from './mappers';

export function getUserProfile(db: Db, userId: string): UserProfile | null {
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) return null;
  const brands = db
    .select({ brand: userBrandSizes.brand, sizeLabel: userBrandSizes.sizeLabel })
    .from(userBrandSizes)
    .where(eq(userBrandSizes.userId, userId))
    .all();
  return rowToUserProfile(row, brands);
}

/** Insert an empty anonymous user row (id = client/server-minted UUID). */
export function createUser(db: Db, userId: string): UserProfile {
  db.insert(users)
    .values({ id: userId, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  const profile = getUserProfile(db, userId);
  if (!profile) throw new Error(`failed to create user ${userId}`);
  return profile;
}

export function userExists(db: Db, userId: string): boolean {
  return db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get() != null;
}

/**
 * Apply a Zod-pruned partial profile (ProfilePatchSchema). Only provided keys
 * are written. `onboarded: true` stamps onboardedAt once; `false` clears it.
 */
export function patchUserProfile(db: Db, userId: string, patch: ProfilePatch): UserProfile {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.heightInches !== undefined) set.heightInches = patch.heightInches;
  if (patch.heelPrefInches !== undefined) set.heelPrefInches = patch.heelPrefInches;
  if (patch.sizesNormalized !== undefined) set.sizesJson = JSON.stringify(patch.sizesNormalized);
  if (patch.bodyMeasurements !== undefined)
    set.measurementsJson = JSON.stringify(patch.bodyMeasurements);
  if (patch.lengthPrefs !== undefined) set.lengthPrefsJson = JSON.stringify(patch.lengthPrefs);
  if (patch.coveragePrefs !== undefined)
    set.coveragePrefsJson = JSON.stringify(patch.coveragePrefs);
  if (patch.budget !== undefined) {
    set.budgetMinCents = patch.budget.minCents;
    set.budgetMaxCents = patch.budget.maxCents;
  }
  if (patch.colorSeason !== undefined) set.colorSeason = patch.colorSeason;
  if (patch.palette !== undefined) set.paletteJson = JSON.stringify(patch.palette);
  if (patch.paletteBoostEnabled !== undefined) set.paletteBoostEnabled = patch.paletteBoostEnabled;
  if (patch.styleTags !== undefined) set.styleTagsJson = JSON.stringify(patch.styleTags);
  if (patch.onboarded !== undefined) set.onboardedAt = patch.onboarded ? Date.now() : null;

  if (Object.keys(set).length > 0) {
    db.update(users).set(set).where(eq(users.id, userId)).run();
  }
  if (patch.brandSizes !== undefined) {
    putBrandSizes(db, userId, patch.brandSizes);
  }
  const profile = getUserProfile(db, userId);
  if (!profile) throw new Error(`user ${userId} not found`);
  return profile;
}

/** PUT semantics: replaces the whole reference-brand size set. */
export function putBrandSizes(
  db: Db,
  userId: string,
  entries: { brand: string; sizeLabel: string }[],
): UserProfile {
  db.delete(userBrandSizes).where(eq(userBrandSizes.userId, userId)).run();
  if (entries.length > 0) {
    // last-write-wins on duplicate brands within one payload
    const byBrand = new Map(entries.map((e) => [e.brand, e]));
    db.insert(userBrandSizes)
      .values([...byBrand.values()].map((e) => ({ userId, brand: e.brand, sizeLabel: e.sizeLabel })))
      .run();
  }
  const profile = getUserProfile(db, userId);
  if (!profile) throw new Error(`user ${userId} not found`);
  return profile;
}

/** Persist learned style tags (swipe learning writes through here). */
export function setStyleTags(db: Db, userId: string, styleTags: Record<string, number>): void {
  db.update(users)
    .set({ styleTagsJson: JSON.stringify(styleTags) })
    .where(eq(users.id, userId))
    .run();
}

/** Persist a color-analysis outcome (season + optional palette). */
export function setColorSeason(
  db: Db,
  userId: string,
  season: string,
  palette?: { hex: string; name: string }[],
): UserProfile {
  const set: Partial<typeof users.$inferInsert> = { colorSeason: season };
  if (palette !== undefined) set.paletteJson = JSON.stringify(palette);
  db.update(users).set(set).where(eq(users.id, userId)).run();
  const profile = getUserProfile(db, userId);
  if (!profile) throw new Error(`user ${userId} not found`);
  return profile;
}
