/**
 * THE MOAT — effective-length UI (PRODUCT_SPEC B2/C2).
 * HemBadge: compact line on every card. Solid = measured, outline = estimated.
 * HemIndicator: detail-page vertical body diagram with the hem line marked.
 */
import type { HemResult, HemPosition, LengthClass } from '@hemline/contracts';
import { cn } from './cn';

const positionPhrase: Record<HemPosition, string> = {
  upper_thigh: 'upper-thigh',
  above_knee: 'above the knee',
  knee: 'at the knee',
  below_knee: 'below the knee',
  mid_calf: 'mid-calf',
  ankle: 'at the ankle',
  floor: 'floor-length',
};

const positionShort: Record<HemPosition, string> = {
  upper_thigh: 'upper thigh',
  above_knee: 'above knee',
  knee: 'knee',
  below_knee: 'below knee',
  mid_calf: 'mid-calf',
  ankle: 'ankle',
  floor: 'floor',
};

export const lengthClassLabel: Record<LengthClass, string> = {
  micro: 'micro',
  mini: 'mini',
  above_knee: 'above-knee',
  knee: 'knee-length',
  midi: 'midi',
  mid_calf: 'mid-calf',
  maxi: 'maxi',
  floor: 'floor-length',
};

export function hemPhrase(position: HemPosition): string {
  return positionPhrase[position];
}
export function hemShort(position: HemPosition): string {
  return positionShort[position];
}

/** Compact card copy: "Hits mid-calf on you" / "Floor-length on you". */
export function hemCardLine(hem: HemResult): string {
  if (!hem.position) return 'Length unverified';
  if (hem.position === 'floor') return 'Floor-length on you';
  return `Hits ${positionPhrase[hem.position]} on you`;
}

/** Detail copy: "This midi hits mid-calf on you" / "This maxi is floor-length on you". */
export function hemDetailLine(hem: HemResult, lengthClass: LengthClass | null): string {
  if (!hem.position) return 'We couldn’t verify this dress’s length yet';
  const noun = lengthClass ? `This ${lengthClassLabel[lengthClass]}` : 'This dress';
  if (hem.position === 'floor') return `${noun} is floor-length on you`;
  return `${noun} hits ${positionPhrase[hem.position]} on you`;
}

/**
 * The non-negotiable per-card hem line. Never blank:
 * measured → solid ink pill · estimated → outlined pill · unknown → muted "Length unverified".
 */
export function HemBadge({ hem, className }: { hem: HemResult; className?: string }) {
  const measured = hem.basis === 'measured_length';
  if (!hem.position) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[11px] text-ink-faint italic',
          className,
        )}
      >
        Length unverified
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        measured
          ? 'bg-ink text-cream'
          : 'border border-ink/35 bg-transparent text-ink border-dashed',
        className,
      )}
      title={measured ? 'From listed garment measurements' : 'Estimated from the length class'}
    >
      <svg viewBox="0 0 10 12" className="size-2.5 shrink-0" aria-hidden="true">
        <path
          d="M5 1v8M2.5 9.5c.8 1 1.7 1.5 2.5 1.5s1.7-.5 2.5-1.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="truncate">
        {!measured && '≈ '}
        {hemCardLine(hem)}
      </span>
    </span>
  );
}

export function ConfidenceTag({ hem, className }: { hem: HemResult; className?: string }) {
  if (hem.basis === 'none') return null;
  const measured = hem.basis === 'measured_length';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase',
        measured ? 'bg-moss-soft text-moss' : 'border border-dashed border-ink/30 text-ink-soft',
        className,
      )}
    >
      {measured ? 'Measured' : 'Estimated'}
    </span>
  );
}

/* ── HemIndicator: vertical figure + ruler, hem line at her actual hem ───── */

// Figure geometry in SVG units. Crown at y=CROWN, floor at y=FLOOR.
const CROWN = 10;
const FLOOR = 248;

function yForInchesAboveFloor(inches: number, heightInches: number): number {
  const pxPerInch = (FLOOR - CROWN) / heightInches;
  return FLOOR - inches * pxPerInch;
}

/**
 * Simple elegant body diagram: abstract figure, dress overlay ending at the
 * computed hem, faint landmark ticks (knee / mid-calf / ankle), position label.
 */
export function HemIndicator({
  heightInches,
  hem,
  className,
}: {
  heightInches: number;
  hem: HemResult;
  className?: string;
}) {
  const H = heightInches;
  const hemIn = hem.hemAboveFloorInches;
  const hemY = hemIn != null ? yForInchesAboveFloor(Math.max(0, hemIn), H) : null;
  const shoulderY = yForInchesAboveFloor(0.82 * H, H);
  const estimated = hem.basis !== 'measured_length';
  // ±3% of height uncertainty band when not measured (ARCHITECTURE §5).
  const bandIn = 0.03 * H;

  const landmarks: Array<[string, number]> = [
    ['knee', 0.285 * H],
    ['mid-calf', 0.16 * H],
    ['ankle', 0.039 * H],
  ];

  const feet = Math.floor(H / 12);
  const inches = Math.round(H % 12);

  return (
    <div className={cn('flex items-center gap-4', className)}>
      <svg
        viewBox="0 0 150 262"
        className="h-56 w-auto shrink-0"
        role="img"
        aria-label={
      hem.position
            ? `Diagram: hem falls at ${positionShort[hem.position]} on your ${feet}'${inches}" frame`
            : 'Diagram: hem position unknown'
        }
      >
        {/* height ruler */}
        <line x1="18" y1={CROWN} x2="18" y2={FLOOR} stroke="var(--color-line)" strokeWidth="1" />
        <line x1="14" y1={CROWN} x2="22" y2={CROWN} stroke="var(--color-ink-faint)" strokeWidth="1" />
        <line x1="14" y1={FLOOR} x2="22" y2={FLOOR} stroke="var(--color-ink-faint)" strokeWidth="1" />
        <text
          x="12"
          y={(CROWN + FLOOR) / 2}
          fontSize="9"
          fill="var(--color-ink-faint)"
          textAnchor="middle"
          transform={`rotate(-90 12 ${(CROWN + FLOOR) / 2})`}
        >
          {feet}′{inches}″ — you
        </text>

        {/* abstract figure */}
        <circle cx="75" cy={CROWN + 12} r="11" fill="none" stroke="var(--color-ink-soft)" strokeWidth="1.5" />
        <path
          d={`M75 ${CROWN + 23}
              C 62 ${shoulderY + 4}, 58 ${shoulderY + 10}, 58 ${shoulderY + 26}
              C 58 ${shoulderY + 52}, 64 ${shoulderY + 64}, 63 ${shoulderY + 86}
              L 60 ${FLOOR - 6}
              M75 ${CROWN + 23}
              C 88 ${shoulderY + 4}, 92 ${shoulderY + 10}, 92 ${shoulderY + 26}
              C 92 ${shoulderY + 52}, 86 ${shoulderY + 64}, 87 ${shoulderY + 86}
              L 90 ${FLOOR - 6}`}
          fill="none"
          stroke="var(--color-ink-soft)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* floor */}
        <line x1="40" y1={FLOOR} x2="130" y2={FLOOR} stroke="var(--color-ink-faint)" strokeWidth="1" strokeDasharray="2 3" />

        {hemY != null && (
          <>
            {/* dress overlay from shoulders to her hem */}
            <path
              d={`M62 ${shoulderY + 6} L88 ${shoulderY + 6} L${75 + Math.min(34, 14 + (hemY - shoulderY) * 0.16)} ${hemY} L${75 - Math.min(34, 14 + (hemY - shoulderY) * 0.16)} ${hemY} Z`}
              fill="var(--color-accent)"
              opacity={estimated ? 0.18 : 0.28}
              stroke="var(--color-accent)"
              strokeWidth="1"
              strokeDasharray={estimated ? '3 3' : undefined}
            />
            {/* uncertainty band */}
            {estimated && (
              <rect
                x="34"
                y={hemY - (bandIn * (FLOOR - CROWN)) / H}
                width="102"
                height={(2 * bandIn * (FLOOR - CROWN)) / H}
                fill="var(--color-accent)"
                opacity="0.08"
              />
            )}
            {/* the hem line */}
            <line x1="34" y1={hemY} x2="136" y2={hemY} stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray={estimated ? '5 4' : undefined} />
          </>
        )}

        {/* landmark ticks */}
        {landmarks.map(([name, inch]) => {
          const y = yForInchesAboveFloor(inch, H);
          return (
            <g key={name}>
              <line x1="128" y1={y} x2="136" y2={y} stroke="var(--color-ink-faint)" strokeWidth="1" />
              <text x="139" y={y + 3} fontSize="8" fill="var(--color-ink-faint)">
                {name}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="min-w-0 space-y-2">
        {hem.position ? (
          <>
            <p className="font-display text-2xl leading-tight text-ink">
              {positionShort[hem.position]}
              <span className="block text-sm font-sans text-ink-soft">on you</span>
            </p>
            {hem.hemAboveFloorInches != null && (
              <p className="text-xs text-ink-soft">
                Hem ends ≈ {Math.round(hem.hemAboveFloorInches)}″ above the floor
                {estimated && ' (±1 zone)'}
              </p>
            )}
            <ConfidenceTag hem={hem} />
          </>
        ) : (
          <p className="text-sm text-ink-soft">
            No length info from this seller yet — check listing photos before you buy.
          </p>
        )}
      </div>
    </div>
  );
}
