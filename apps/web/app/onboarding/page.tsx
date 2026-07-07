'use client';

/**
 * Onboarding quiz (PRODUCT_SPEC A1, §4.2): 8 screens, tap-first, hard
 * constraints first, progress "n of 8", back navigation, skip on every
 * non-constraint screen, autosave to the anonymous profile after each screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { HemPosition } from '@hemline/contracts';
import { Button, Chip, DualRange, ProgressBar, Stepper, Spinner } from '@hemline/ui';
import { api } from '../../lib/api';
import { useProfile } from '../../lib/profile-store';
import { KEYS, readLocal, writeLocal } from '../../lib/local';

const TOTAL = 8;

/* ── answer vocabularies ─────────────────────────────────────────────────── */

const SIZE_LETTERS = [
  { label: 'XS', sizes: [0, 2] },
  { label: 'S', sizes: [4, 6] },
  { label: 'M', sizes: [8, 10] },
  { label: 'L', sizes: [12, 14] },
  { label: 'XL', sizes: [16, 18] },
];
const SIZE_NUMBERS = [0, 2, 4, 6, 8, 10, 12, 14, 16];
const BRAND_SIZE_LABELS = ['00', '0', '2', '4', '6', '8', '10', '12', '14', '16', 'XS', 'S', 'M', 'L', 'XL'];

const PREFERRED_BRANDS = [
  'Reformation', 'STAUD', 'Free People', 'GANNI', 'Sézane', 'Rouje',
  'RIXO', 'Dôen', 'With Jéan', 'Réalisation Par', 'House of CB', 'Christy Dawn',
];

const ALL_HEM_POSITIONS: HemPosition[] = [
  'upper_thigh', 'above_knee', 'knee', 'below_knee', 'mid_calf', 'ankle', 'floor',
];

interface AvoidOption {
  id: string;
  label: string;
  hemAvoid?: HemPosition[];
  coverage?: 'sleeves' | 'highNeckline' | 'backCoverage';
}
const AVOID_OPTIONS: AvoidOption[] = [
  { id: 'mini', label: 'Mini / micro lengths', hemAvoid: ['upper_thigh'] },
  { id: 'above_knee', label: 'Above-the-knee', hemAvoid: ['above_knee'] },
  { id: 'maxi', label: 'Ankle & floor lengths', hemAvoid: ['ankle', 'floor'] },
  { id: 'strapless', label: 'Strapless', coverage: 'sleeves' },
  { id: 'plunging', label: 'Plunging necklines', coverage: 'highNeckline' },
  { id: 'backless', label: 'Backless', coverage: 'backCoverage' },
  { id: 'bodycon', label: 'Bodycon' },
];

const VIBES = [
  { tag: 'vibe:romantic', label: 'Romantic', hint: 'florals, ruffles, soft lines' },
  { tag: 'vibe:minimalist', label: 'Minimal', hint: 'clean lines, quiet color' },
  { tag: 'vibe:classic', label: 'Classic', hint: 'timeless, polished' },
  { tag: 'vibe:boho', label: 'Boho', hint: 'flowy, earthy, relaxed' },
  { tag: 'vibe:retro', label: 'Retro', hint: 'vintage-coded silhouettes' },
  { tag: 'vibe:glam', label: 'Glam', hint: 'satin, shine, drama' },
  { tag: 'vibe:cottagecore', label: 'Cottage', hint: 'prairie, puff sleeves' },
  { tag: 'vibe:edgy', label: 'Edgy', hint: 'sharp, unexpected' },
];

const OCCASIONS = [
  { tag: 'occasion:casual', label: 'Everyday' },
  { tag: 'occasion:work', label: 'Work' },
  { tag: 'occasion:date_night', label: 'Date night' },
  { tag: 'occasion:cocktail', label: 'Cocktail' },
  { tag: 'occasion:wedding_guest', label: 'Wedding guest' },
  { tag: 'occasion:vacation', label: 'Vacation' },
  { tag: 'occasion:brunch', label: 'Brunch' },
  { tag: 'occasion:formal', label: 'Formal' },
];

/* ── page ────────────────────────────────────────────────────────────────── */

export default function OnboardingPage() {
  const router = useRouter();
  const { profile, update, setBrandSizes } = useProfile();
  const [step, setStep] = useState(1);

  // answers (hydrated from any earlier pass so back/refresh keeps state)
  const [feet, setFeet] = useState<number | null>(null);
  const [inches, setInches] = useState<number | null>(null);
  const [sizeMode, setSizeMode] = useState<'number' | 'letter'>('number');
  const [sizes, setSizes] = useState<number[]>([]);
  const [brands, setBrands] = useState<{ brand: string; sizeLabel: string }[]>([]);
  const [avoid, setAvoid] = useState<string[]>(() => readLocal<string[]>(KEYS.avoid, []));
  const [budget, setBudget] = useState<[number, number]>([30, 300]);
  const [budgetTouched, setBudgetTouched] = useState(false);
  const [vibes, setVibes] = useState<string[]>(() => readLocal<string[]>(KEYS.vibes, []));
  const [occasions, setOccasions] = useState<string[]>([]);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!profile || hydrated.current) return;
    hydrated.current = true;
    if (profile.heightInches != null) {
      setFeet(Math.floor(profile.heightInches / 12));
      setInches(Math.round(profile.heightInches % 12));
    }
    if (profile.sizesNormalized.length) setSizes(profile.sizesNormalized);
    if (profile.brandSizes.length) setBrands(profile.brandSizes);
    if (profile.budget.minCents != null && profile.budget.maxCents != null) {
      setBudget([profile.budget.minCents / 100, profile.budget.maxCents / 100]);
      setBudgetTouched(true);
    }
  }, [profile]);

  const heightInches = feet != null && inches != null ? feet * 12 + inches : null;

  // live in-stock count for the budget screen (B-A1: slider shows matching dresses)
  useEffect(() => {
    if (step !== 5) return;
    const t = setTimeout(() => {
      api
        .rank({
          userId: profile?.id ?? 'anon',
          filters: {
            sizesNormalized: sizes.length ? sizes : undefined,
            priceMinCents: budget[0] * 100,
            priceMaxCents: budget[1] * 100,
          },
          limit: 1,
          personalize: false,
        })
        .then((r) => setMatchCount(r.totalMatched))
        .catch(() => setMatchCount(null));
    }, 250);
    return () => clearTimeout(t);
  }, [step, budget, sizes, profile?.id]);

  /* autosave the finished screen, then advance */
  const saveStep = useCallback(
    async (s: number) => {
      try {
        if (s === 1 && heightInches != null) await update({ heightInches });
        if (s === 2) await update({ sizesNormalized: sizes });
        if (s === 3) await setBrandSizes(brands);
        if (s === 4) {
          writeLocal(KEYS.avoid, avoid);
          const opts = AVOID_OPTIONS.filter((o) => avoid.includes(o.id));
          const avoided = new Set(opts.flatMap((o) => o.hemAvoid ?? []));
          await update({
            lengthPrefs: ALL_HEM_POSITIONS.filter((p) => !avoided.has(p)),
            coveragePrefs: {
              sleeves: opts.some((o) => o.coverage === 'sleeves') || undefined,
              highNeckline: opts.some((o) => o.coverage === 'highNeckline') || undefined,
              backCoverage: opts.some((o) => o.coverage === 'backCoverage') || undefined,
            },
          });
        }
        if (s === 5 && budgetTouched)
          await update({ budget: { minCents: budget[0] * 100, maxCents: budget[1] * 100 } });
        if (s === 6 || s === 7) {
          writeLocal(KEYS.vibes, vibes);
          const seed: Record<string, number> = { ...(profile?.styleTags ?? {}) };
          for (const t of vibes) seed[t] = Math.max(seed[t] ?? 0, 1);
          for (const t of occasions) seed[t] = Math.max(seed[t] ?? 0, 0.7);
          await update({ styleTags: seed });
        }
      } catch {
        // autosave is best-effort; answers stay in memory + localStorage
      }
    },
    [heightInches, sizes, brands, avoid, budget, budgetTouched, vibes, occasions, profile?.styleTags, update, setBrandSizes],
  );

  const next = useCallback(async () => {
    void saveStep(step);
    if (step < TOTAL) setStep(step + 1);
  }, [step, saveStep]);

  const finish = useCallback(async () => {
    await saveStep(step);
    await update({ onboarded: true });
    router.push('/calibrate');
  }, [saveStep, step, update, router]);

  const canProceed =
    step === 1 ? heightInches != null : step === 2 ? sizes.length > 0 : true;
  const skippable = step >= 3 && step <= 7;

  if (!profile) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Spinner label="Loading your profile" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-4 pb-8">
      <div className="flex items-center gap-2">
        {step > 1 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            aria-label="Back"
            className="-ml-2 flex size-10 items-center justify-center rounded-full text-ink-soft hover:bg-ink/5"
          >
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
              <path d="M10 2 4 8l6 6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <Link
            href="/"
            aria-label="Back to home"
            className="-ml-2 flex size-10 items-center justify-center rounded-full text-ink-soft hover:bg-ink/5"
          >
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
              <path d="M10 2 4 8l6 6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        )}
        <ProgressBar step={step} total={TOTAL} className="flex-1" />
      </div>

      <div key={step} className="mt-8 flex flex-1 flex-col animate-rise">
        {step === 1 && (
          <StepShell
            title="How tall are you?"
            lede="This is the whole trick: we compute where every hem actually lands on you."
          >
            <div className="grid grid-cols-2 gap-4">
              <fieldset>
                <legend className="mb-2 text-xs font-medium tracking-wide text-ink-soft uppercase">Feet</legend>
                <div className="flex flex-col gap-2">
                  {[4, 5, 6].map((f) => (
                    <Chip key={f} selected={feet === f} onClick={() => setFeet(f)} className="w-full">
                      {f}′
                    </Chip>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-xs font-medium tracking-wide text-ink-soft uppercase">Inches</legend>
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: 12 }, (_, i) => (
                    <Chip key={i} selected={inches === i} onClick={() => setInches(i)}>
                      {i}″
                    </Chip>
                  ))}
                </div>
              </fieldset>
            </div>
            {heightInches != null && (
              <p className="mt-4 text-center font-display text-lg text-accent" aria-live="polite">
                {feet}′{inches}″ — got it
              </p>
            )}
          </StepShell>
        )}

        {step === 2 && (
          <StepShell title="Your usual dress size?" lede="Pick every size you regularly wear — brands disagree, we know.">
            <div role="radiogroup" aria-label="Size format" className="mb-4 flex w-fit rounded-full border border-line bg-card p-0.5">
              {(['number', 'letter'] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={sizeMode === m}
                  onClick={() => setSizeMode(m)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium ${sizeMode === m ? 'bg-ink text-cream' : 'text-ink-soft'}`}
                >
                  {m === 'number' ? 'US 0–16' : 'XS–XL'}
                </button>
              ))}
            </div>
            {sizeMode === 'number' ? (
              <div className="grid grid-cols-3 gap-2">
                {SIZE_NUMBERS.map((n) => (
                  <Chip
                    key={n}
                    selected={sizes.includes(n)}
                    onClick={() => setSizes((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n].sort((a, b) => a - b)))}
                  >
                    {n}
                  </Chip>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {SIZE_LETTERS.map((l) => {
                  const active = l.sizes.every((s) => sizes.includes(s));
                  return (
                    <Chip
                      key={l.label}
                      selected={active}
                      onClick={() =>
                        setSizes((p) =>
                          active
                            ? p.filter((x) => !l.sizes.includes(x))
                            : [...new Set([...p, ...l.sizes])].sort((a, b) => a - b),
                        )
                      }
                    >
                      {l.label}
                      <span className="ml-1 text-xs opacity-60">({l.sizes.join('–')})</span>
                    </Chip>
                  );
                })}
              </div>
            )}
          </StepShell>
        )}

        {step === 3 && (
          <StepShell
            title="Brands you know your size in"
            lede="Pick 2–3. “I’m a 6 in Reformation” beats any size chart."
          >
            <div className="grid grid-cols-2 gap-2">
              {PREFERRED_BRANDS.map((b) => {
                const entry = brands.find((x) => x.brand === b);
                return (
                  <div key={b} className={`rounded-2xl border p-3 transition-colors ${entry ? 'border-ink bg-card' : 'border-line bg-card/60'}`}>
                    <button
                      type="button"
                      aria-pressed={!!entry}
                      onClick={() =>
                        setBrands((p) =>
                          entry
                            ? p.filter((x) => x.brand !== b)
                            : p.length >= 3
                              ? p
                              : [...p, { brand: b, sizeLabel: '6' }],
                        )
                      }
                      className="block w-full text-left"
                    >
                      <span className="font-display text-[15px] text-ink">{b}</span>
                    </button>
                    {entry && (
                      <div className="mt-2">
                        <Stepper
                          label={`${b} size`}
                          value={entry.sizeLabel}
                          onPrev={() => bumpBrandSize(b, -1)}
                          onNext={() => bumpBrandSize(b, +1)}
                          prevDisabled={BRAND_SIZE_LABELS.indexOf(entry.sizeLabel) <= 0}
                          nextDisabled={BRAND_SIZE_LABELS.indexOf(entry.sizeLabel) >= BRAND_SIZE_LABELS.length - 1}
                          className="w-full justify-between"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {brands.length >= 3 && (
              <p className="mt-3 text-center text-xs text-ink-faint">Three is plenty — that’s a solid map.</p>
            )}
          </StepShell>
        )}

        {step === 4 && (
          <StepShell title="Never show me…" lede="We’ll quietly keep these out of your feed. Pick any.">
            <div className="flex flex-wrap gap-2">
              {AVOID_OPTIONS.map((o) => (
                <Chip
                  key={o.id}
                  selected={avoid.includes(o.id)}
                  onClick={() => setAvoid((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]))}
                >
                  {o.label}
                </Chip>
              ))}
            </div>
          </StepShell>
        )}

        {step === 5 && (
          <StepShell title="What’s your budget?" lede="Per dress. Resale finds start surprisingly low.">
            <DualRange
              min={10}
              max={480}
              step={10}
              value={budget}
              onChange={(v) => {
                setBudget(v);
                setBudgetTouched(true);
              }}
              format={(v) => `$${v}`}
              label="Budget"
            />
            <p className="mt-6 text-center text-sm text-ink-soft" aria-live="polite">
              {matchCount == null ? '…' : (
                <>
                  <span className="font-display text-2xl text-ink">{matchCount}</span> in-stock dresses
                  {sizes.length > 0 && ' in your size'}
                </>
              )}
            </p>
          </StepShell>
        )}

        {step === 6 && (
          <StepShell title="Which of these feel like you?" lede="Optional — your swipes will sharpen this anyway.">
            <div className="grid grid-cols-2 gap-2">
              {VIBES.map((v) => (
                <button
                  key={v.tag}
                  type="button"
                  aria-pressed={vibes.includes(v.tag)}
                  onClick={() => setVibes((p) => (p.includes(v.tag) ? p.filter((x) => x !== v.tag) : [...p, v.tag]))}
                  className={`rounded-2xl border p-4 text-left transition-colors ${
                    vibes.includes(v.tag) ? 'border-ink bg-ink text-cream' : 'border-line bg-card hover:border-ink/40'
                  }`}
                >
                  <span className="font-display text-lg">{v.label}</span>
                  <span className={`mt-0.5 block text-xs ${vibes.includes(v.tag) ? 'text-cream/70' : 'text-ink-faint'}`}>
                    {v.hint}
                  </span>
                </button>
              ))}
            </div>
          </StepShell>
        )}

        {step === 7 && (
          <StepShell title="Dressing for anything lately?" lede="Optional — we’ll tilt the feed toward it.">
            <div className="flex flex-wrap gap-2">
              {OCCASIONS.map((o) => (
                <Chip
                  key={o.tag}
                  selected={occasions.includes(o.tag)}
                  onClick={() => setOccasions((p) => (p.includes(o.tag) ? p.filter((x) => x !== o.tag) : [...p, o.tag]))}
                >
                  {o.label}
                </Chip>
              ))}
            </div>
          </StepShell>
        )}

        {step === 8 && (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <p className="font-display text-sm tracking-widest text-accent uppercase">Last step</p>
            <h1 className="mt-3 font-display text-4xl leading-tight text-ink">
              Let’s calibrate your taste.
            </h1>
            <p className="mt-4 max-w-xs text-ink-soft">
              Swipe a dozen real dresses — in your size, in your budget. Every card already shows
              where the hem lands on your {feet != null && inches != null ? `${feet}′${inches}″` : ''} frame.
            </p>
          </div>
        )}
      </div>

      <div className="mt-8 space-y-2">
        {step < TOTAL ? (
          <Button size="lg" full onClick={next} disabled={!canProceed} data-testid="quiz-next">
            {step === 1 || step === 2 ? 'Continue' : 'Next'}
          </Button>
        ) : (
          <Button size="lg" full variant="accent" onClick={finish} data-testid="quiz-finish">
            Start swiping →
          </Button>
        )}
        {skippable && step < TOTAL && (
          <Button variant="ghost" full onClick={() => setStep(step + 1)}>
            Skip
          </Button>
        )}
      </div>
    </main>
  );

  function bumpBrandSize(brand: string, dir: 1 | -1) {
    setBrands((p) =>
      p.map((x) => {
        if (x.brand !== brand) return x;
        const i = BRAND_SIZE_LABELS.indexOf(x.sizeLabel) + dir;
        return { ...x, sizeLabel: BRAND_SIZE_LABELS[Math.max(0, Math.min(BRAND_SIZE_LABELS.length - 1, i))] };
      }),
    );
  }
}

function StepShell({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <section>
      <h1 className="font-display text-3xl leading-tight text-ink">{title}</h1>
      <p className="mt-2 mb-6 text-sm text-ink-soft">{lede}</p>
      {children}
    </section>
  );
}
