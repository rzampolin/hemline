/**
 * Color analysis — docs/ARCHITECTURE.md §7.4.
 *
 * TODO(ai-eng):
 * - sharp in-memory Lab sampling (buffer NEVER persisted)
 * - Sonnet classification from measured Lab numbers only (image not sent)
 * - deterministic quiz fallback (no LLM) + degraded lookup-table mode
 * - caveat for deep/olive skin tones or sampleQuality='poor'
 */
import type { ColorAnalysisResult, MeasuredColors, QuizAnswers } from '@hemline/contracts';

export async function analyzeSelfie(_imageBuffer: Buffer): Promise<ColorAnalysisResult> {
  throw new Error(
    'not yet implemented (ai-eng): selfie Lab sampling + Sonnet classification — §7.4',
  );
}

export function classifyFromMeasured(_measured: MeasuredColors): ColorAnalysisResult {
  throw new Error('not yet implemented (ai-eng): deterministic season lookup — §7.5');
}

export function classifyFromQuiz(_answers: QuizAnswers): ColorAnalysisResult {
  throw new Error('not yet implemented (ai-eng): quiz scoring table — §7.4');
}
