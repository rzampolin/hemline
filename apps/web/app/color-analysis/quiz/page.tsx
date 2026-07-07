'use client';

/**
 * Manual color quiz fallback (ARCHITECTURE §7.4, contract QuizAnswers):
 * vein color, jewelry metal, white-vs-cream, sun reaction, natural hair, eyes.
 * Deterministic — no camera or LLM needed.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColorAnalysisResult, QuizAnswers } from '@hemline/contracts';
import { Button, ProgressBar, Spinner } from '@hemline/ui';
import { api } from '../../../lib/api';
import { ResultView } from '../result-view';

interface Question<K extends keyof QuizAnswers> {
  key: K;
  title: string;
  hint: string;
  options: { value: QuizAnswers[K]; label: string; swatch?: string }[];
}

const QUESTIONS: Question<keyof QuizAnswers>[] = [
  {
    key: 'veinColor',
    title: 'The veins on your wrist look…',
    hint: 'Check in daylight, palm up.',
    options: [
      { value: 'blue_purple', label: 'Blue or purple', swatch: '#6E7CA0' },
      { value: 'green', label: 'Green or olive', swatch: '#8A9A5B' },
      { value: 'mixed_unsure', label: 'A mix / can’t tell' },
    ],
  },
  {
    key: 'jewelryMetal',
    title: 'Which metal flatters you more?',
    hint: 'Which one makes your skin glow, not gray?',
    options: [
      { value: 'silver', label: 'Silver', swatch: '#C0C0C8' },
      { value: 'gold', label: 'Gold', swatch: '#D4A843' },
      { value: 'both', label: 'Honestly, both' },
    ],
  },
  {
    key: 'whiteVsCream',
    title: 'Pure white or cream?',
    hint: 'Next to your bare face, which looks better?',
    options: [
      { value: 'white', label: 'Crisp pure white', swatch: '#FFFFFF' },
      { value: 'cream', label: 'Soft cream / ivory', swatch: '#F5EBD8' },
      { value: 'unsure', label: 'Can’t tell' },
    ],
  },
  {
    key: 'sunReaction',
    title: 'In the sun, your skin…',
    hint: 'Think of the first warm week of summer.',
    options: [
      { value: 'burns_easily', label: 'Burns easily, rarely tans' },
      { value: 'burns_then_tans', label: 'Burns first, then tans' },
      { value: 'tans_easily', label: 'Tans easily' },
      { value: 'rarely_burns', label: 'Almost never burns' },
    ],
  },
  {
    key: 'naturalHair',
    title: 'Your natural hair color?',
    hint: 'Before any dye — childhood color counts.',
    options: [
      { value: 'black', label: 'Black', swatch: '#1C1A1A' },
      { value: 'dark_brown', label: 'Dark brown', swatch: '#3B2A20' },
      { value: 'medium_brown', label: 'Medium brown', swatch: '#5C4330' },
      { value: 'light_brown', label: 'Light brown', swatch: '#8A6A4F' },
      { value: 'blonde', label: 'Blonde', swatch: '#C9A86A' },
      { value: 'strawberry_blonde', label: 'Strawberry blonde', swatch: '#C98A5E' },
      { value: 'red', label: 'Red', swatch: '#9E4B26' },
      { value: 'auburn', label: 'Auburn', swatch: '#6E3B24' },
      { value: 'gray_white', label: 'Gray / white', swatch: '#C9C5BE' },
    ],
  },
  {
    key: 'eyeColor',
    title: 'And your eyes?',
    hint: 'The dominant color in daylight.',
    options: [
      { value: 'dark_brown', label: 'Dark brown', swatch: '#3B2417' },
      { value: 'brown', label: 'Brown', swatch: '#6B4226' },
      { value: 'hazel', label: 'Hazel', swatch: '#8A6E3B' },
      { value: 'green', label: 'Green', swatch: '#5C7A4F' },
      { value: 'blue', label: 'Blue', swatch: '#5B7F95' },
      { value: 'gray', label: 'Gray', swatch: '#8C9BAB' },
    ],
  },
];

export default function ColorQuizPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial<QuizAnswers>>({});
  const [phase, setPhase] = useState<'quiz' | 'scoring' | 'result'>('quiz');
  const [result, setResult] = useState<ColorAnalysisResult | null>(null);

  const q = QUESTIONS[step];

  const pick = async (value: QuizAnswers[keyof QuizAnswers]) => {
    const next = { ...answers, [q.key]: value };
    setAnswers(next);
    if (step + 1 < QUESTIONS.length) {
      setStep(step + 1);
      return;
    }
    setPhase('scoring');
    try {
      const res = await api.colorAnalysisQuiz({ answers: next as QuizAnswers });
      setResult(res);
      setPhase('result');
    } catch {
      setPhase('quiz');
    }
  };

  if (phase === 'scoring') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 text-center">
        <Spinner label="Scoring your answers" />
        <p className="font-display text-xl text-ink">Placing you on the season wheel…</p>
      </main>
    );
  }

  if (phase === 'result' && result) {
    return (
      <main className="mx-auto min-h-dvh max-w-md pt-4">
        <ResultView
          result={result}
          onRetake={() => {
            setAnswers({});
            setStep(0);
            setPhase('quiz');
          }}
          retakeLabel="Redo the quiz"
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-4 pb-8">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => (step > 0 ? setStep(step - 1) : router.back())}
          aria-label="Back"
          className="-ml-2 flex size-10 items-center justify-center rounded-full text-ink-soft hover:bg-ink/5"
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <path d="M10 2 4 8l6 6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <ProgressBar step={step + 1} total={QUESTIONS.length} className="flex-1" />
      </div>

      <div key={q.key} className="mt-10 animate-rise">
        <h1 className="font-display text-3xl leading-tight text-ink">{q.title}</h1>
        <p className="mt-2 text-sm text-ink-soft">{q.hint}</p>
        <div className="mt-6 flex flex-col gap-2">
          {q.options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              onClick={() => void pick(o.value)}
              className="flex min-h-13 items-center gap-3 rounded-2xl border border-line bg-card px-4 text-left text-[15px] font-medium text-ink transition-colors hover:border-ink/40"
            >
              {o.swatch && (
                <span className="size-6 shrink-0 rounded-full ring-1 ring-ink/15" style={{ backgroundColor: o.swatch }} aria-hidden="true" />
              )}
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-auto pt-6">
        <Button variant="ghost" full onClick={() => router.push('/feed')}>
          Never mind — back to my rack
        </Button>
      </div>
    </main>
  );
}
