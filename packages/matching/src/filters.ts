/**
 * Hard filters — docs/ARCHITECTURE.md §6.
 * TODO(ai-eng): candidate predicate/query builder for
 * size ∩ price ∩ hem-position-for-user ∩ condition ∩ brand ∩ FTS query,
 * capped at 500 newest-first. Pure/SQL-shape only — backend-eng executes it.
 */
import type { HardFilters, Listing } from '@hemline/contracts';

export function matchesHardFilters(_listing: Listing, _filters: HardFilters): boolean {
  throw new Error('not yet implemented (ai-eng): hard-filter predicate — §6');
}
