'use client';

/**
 * Profile / settings (PRODUCT_SPEC A3, §4.7): edit everything Soline knows —
 * fit, budget, colors (season + palette + boost toggle), taste, account stub,
 * alerts stub, reset.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { HemPosition } from '@hemline/contracts';
import { Button, Chip, Sheet, Spinner, Stepper, Swatch, Toggle, DualRange } from '@hemline/ui';
import { useProfile } from '../../../lib/profile-store';
import { SEASONS, SEASON_LIST } from '../../../lib/seasons';
import { readLocal, writeLocal } from '../../../lib/local';

const SIZE_NUMBERS = [0, 2, 4, 6, 8, 10, 12, 14, 16];
const BRAND_SIZE_LABELS = ['00', '0', '2', '4', '6', '8', '10', '12', '14', '16', 'XS', 'S', 'M', 'L', 'XL'];
const HEM_LABELS: Record<HemPosition, string> = {
  upper_thigh: 'Upper thigh',
  above_knee: 'Above knee',
  knee: 'Knee',
  below_knee: 'Below knee',
  mid_calf: 'Mid-calf',
  ankle: 'Ankle',
  floor: 'Floor',
};
const ALL_POSITIONS = Object.keys(HEM_LABELS) as HemPosition[];

export default function ProfilePage() {
  const router = useRouter();
  const { profile, update, setBrandSizes, paletteBoost, setPaletteBoost, clearPalette, setSeason, reset } =
    useProfile();
  const [seasonPickerOpen, setSeasonPickerOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [alertsOn, setAlertsOn] = useState(() => readLocal<boolean>('hemline:alerts-stub', false));
  const [emailNudge, setEmailNudge] = useState(false);

  if (!profile) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Spinner label="Loading profile" />
      </main>
    );
  }

  const feet = profile.heightInches != null ? Math.floor(profile.heightInches / 12) : null;
  const inches = profile.heightInches != null ? Math.round(profile.heightInches % 12) : null;

  return (
    <main className="mx-auto max-w-md px-4 pt-4 pb-8">
      <h1 className="font-display text-2xl text-ink">Your profile</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Everything Soline knows about you. Edits re-rank your feed on next load.
      </p>

      {/* ── My Fit ── */}
      <Section title="My fit">
        <Row label="Height">
          <div className="flex gap-2">
            <select
              aria-label="Feet"
              value={feet ?? ''}
              onChange={(e) => update({ heightInches: Number(e.target.value) * 12 + (inches ?? 0) })}
              className="h-11 rounded-xl border border-line bg-card px-3 text-sm"
            >
              <option value="" disabled>ft</option>
              {[4, 5, 6].map((f) => (
                <option key={f} value={f}>{f}′</option>
              ))}
            </select>
            <select
              aria-label="Inches"
              value={inches ?? ''}
              onChange={(e) => update({ heightInches: (feet ?? 5) * 12 + Number(e.target.value) })}
              className="h-11 rounded-xl border border-line bg-card px-3 text-sm"
            >
              <option value="" disabled>in</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i}>{i}″</option>
              ))}
            </select>
          </div>
        </Row>

        <Row label="Usual heel height">
          <Stepper
            label="heel preference"
            value={`${profile.heelPrefInches}″`}
            onPrev={() => update({ heelPrefInches: Math.max(0, profile.heelPrefInches - 1) })}
            onNext={() => update({ heelPrefInches: Math.min(4, profile.heelPrefInches + 1) })}
            prevDisabled={profile.heelPrefInches <= 0}
            nextDisabled={profile.heelPrefInches >= 4}
          />
        </Row>

        <Row label="Sizes" stacked>
          <div className="flex flex-wrap gap-1.5">
            {SIZE_NUMBERS.map((n) => (
              <Chip
                key={n}
                selected={profile.sizesNormalized.includes(n)}
                onClick={() =>
                  update({
                    sizesNormalized: profile.sizesNormalized.includes(n)
                      ? profile.sizesNormalized.filter((x) => x !== n)
                      : [...profile.sizesNormalized, n].sort((a, b) => a - b),
                  })
                }
                className="min-h-10 min-w-11"
              >
                {n}
              </Chip>
            ))}
          </div>
        </Row>

        <Row label="Brand sizes" stacked>
          {profile.brandSizes.length === 0 && (
            <p className="text-sm text-ink-faint">None yet — added from the quiz.</p>
          )}
          <ul className="space-y-2">
            {profile.brandSizes.map((b) => (
              <li key={b.brand} className="flex items-center justify-between gap-2">
                <span className="text-sm">{b.brand}</span>
                <div className="flex items-center gap-2">
                  <Stepper
                    label={`${b.brand} size`}
                    value={b.sizeLabel}
                    onPrev={() => bumpBrand(b.brand, -1)}
                    onNext={() => bumpBrand(b.brand, +1)}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${b.brand}`}
                    onClick={() => setBrandSizes(profile.brandSizes.filter((x) => x.brand !== b.brand))}
                    className="text-xs text-ink-faint underline"
                  >
                    remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Row>

        <Row label="Lengths I wear (on me)" stacked>
          <div className="flex flex-wrap gap-1.5">
            {ALL_POSITIONS.map((p) => {
              const active = profile.lengthPrefs.length === 0 || profile.lengthPrefs.includes(p);
              return (
                <Chip
                  key={p}
                  selected={active}
                  onClick={() => {
                    const current = profile.lengthPrefs.length ? profile.lengthPrefs : ALL_POSITIONS;
                    const next = active ? current.filter((x) => x !== p) : [...current, p];
                    update({ lengthPrefs: next });
                  }}
                  className="min-h-10"
                >
                  {HEM_LABELS[p]}
                </Chip>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">Deselected lengths never show in your feed.</p>
        </Row>
      </Section>

      {/* ── Budget ── */}
      <Section title="Budget">
        <DualRange
          min={10}
          max={480}
          step={10}
          value={[(profile.budget.minCents ?? 1000) / 100, (profile.budget.maxCents ?? 48000) / 100]}
          onChange={([lo, hi]) => update({ budget: { minCents: lo * 100, maxCents: hi * 100 } })}
          format={(v) => `$${v}`}
          label="Budget"
        />
      </Section>

      {/* ── My Colors ── */}
      <Section title="My colors">
        {profile.colorSeason ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-display text-lg text-ink">{SEASONS[profile.colorSeason].label}</p>
                <p className="text-xs text-ink-soft">{SEASONS[profile.colorSeason].tagline}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setSeasonPickerOpen(true)}>
                Adjust
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {profile.palette.map((c) => (
                <Swatch key={c.hex} hex={c.hex} name={c.name} />
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">Boost my palette in the feed</p>
                <p className="text-xs text-ink-faint">Soft boost only — never hides dresses.</p>
              </div>
              <Toggle checked={paletteBoost} onChange={setPaletteBoost} label="Palette boost" />
            </div>
            <div className="mt-3 flex gap-3 text-xs">
              <Link href="/color-analysis" className="text-accent underline">
                Redo analysis
              </Link>
              <button type="button" onClick={() => void clearPalette()} className="text-ink-faint underline">
                Delete palette
              </button>
            </div>
          </>
        ) : (
          <div>
            <p className="text-sm text-ink-soft">
              No color season yet. One selfie (or a 60-second quiz) finds the colors that flatter you.
            </p>
            <Link
              href="/color-analysis"
              className="mt-3 inline-flex min-h-10 items-center rounded-full border border-ink/25 px-5 text-sm font-medium"
            >
              Find my colors
            </Link>
          </div>
        )}
      </Section>

      {/* ── Taste ── */}
      <Section title="Taste">
        <p className="text-sm text-ink-soft">
          {Object.keys(profile.styleTags).length > 0
            ? 'Learned from your swipes and picks. Retune it any time.'
            : 'Swipe a deck to teach Soline your taste.'}
        </p>
        <Button variant="outline" className="mt-3" onClick={() => router.push('/calibrate')}>
          Re-run the swipe deck
        </Button>
      </Section>

      {/* ── Alerts (F4 stub) + Account ── */}
      <Section title="Alerts & account">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-ink">New-matches alerts</p>
            <p className="text-xs text-ink-faint" role={alertsOn ? 'status' : undefined}>
              {alertsOn ? 'Alerts coming soon — you’re on the list.' : 'Price drops & new arrivals in your size.'}
            </p>
          </div>
          <Toggle
            checked={alertsOn}
            onChange={(v) => {
              setAlertsOn(v);
              writeLocal('hemline:alerts-stub', v);
            }}
            label="Alerts"
          />
        </div>
        <div className="mt-4 border-t border-line/60 pt-4">
          <p className="text-sm font-medium text-ink">Account</p>
          <p className="mt-0.5 text-xs text-ink-soft">
            Anonymous profile on this device — no account needed. Add an email later to sync.
          </p>
          {emailNudge ? (
            <p className="mt-2 text-xs font-medium text-moss" role="status">
              Magic-link sign-in is coming soon.
            </p>
          ) : (
            <Button variant="ghost" size="sm" className="mt-2 -ml-3" onClick={() => setEmailNudge(true)}>
              Connect an email
            </Button>
          )}
        </div>
      </Section>

      {/* ── Reset ── */}
      <Section title="Danger zone">
        <Button variant="danger" onClick={() => setConfirmReset(true)}>
          Reset my profile
        </Button>
      </Section>

      {/* season picker sheet */}
      <Sheet open={seasonPickerOpen} onClose={() => setSeasonPickerOpen(false)} title="Pick your season">
        <ul className="grid grid-cols-1 gap-2 pb-2">
          {SEASON_LIST.map((s) => (
            <li key={s.season}>
              <button
                type="button"
                onClick={async () => {
                  await setSeason(s.season);
                  setSeasonPickerOpen(false);
                }}
                aria-pressed={profile.colorSeason === s.season}
                className={`flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left ${
                  profile.colorSeason === s.season ? 'border-ink bg-card' : 'border-line bg-card/60'
                }`}
              >
                <div>
                  <span className="font-display text-[15px] text-ink">{s.label}</span>
                  <span className="block text-xs text-ink-faint">{s.tagline}</span>
                </div>
                <span className="flex -space-x-1" aria-hidden="true">
                  {s.palette.slice(0, 5).map((c) => (
                    <span key={c.hex} className="size-5 rounded-full ring-2 ring-card" style={{ backgroundColor: c.hex }} />
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>

      {/* reset confirm */}
      <Sheet
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset everything?"
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" full onClick={() => setConfirmReset(false)}>
              Keep my profile
            </Button>
            <Button
              variant="accent"
              full
              onClick={async () => {
                await reset();
                setConfirmReset(false);
                router.push('/');
              }}
            >
              Yes, reset
            </Button>
          </div>
        }
      >
        <p className="pb-2 text-sm text-ink-soft">
          This clears your quiz answers, swipes, palette and saved dresses from this device. There’s
          no undo.
        </p>
      </Sheet>
    </main>
  );

  function bumpBrand(brand: string, dir: 1 | -1) {
    if (!profile) return;
    void setBrandSizes(
      profile.brandSizes.map((x) => {
        if (x.brand !== brand) return x;
        const i = BRAND_SIZE_LABELS.indexOf(x.sizeLabel) + dir;
        return { ...x, sizeLabel: BRAND_SIZE_LABELS[Math.max(0, Math.min(BRAND_SIZE_LABELS.length - 1, i))] };
      }),
    );
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-3xl border border-line bg-card/70 p-5">
      <h2 className="font-display text-xs tracking-widest text-ink-soft uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, children, stacked = false }: { label: string; children: React.ReactNode; stacked?: boolean }) {
  return (
    <div className={`py-2.5 ${stacked ? '' : 'flex items-center justify-between gap-3'}`}>
      <p className={`text-sm font-medium text-ink ${stacked ? 'mb-2' : ''}`}>{label}</p>
      {children}
    </div>
  );
}
