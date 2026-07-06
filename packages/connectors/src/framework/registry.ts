/**
 * Connector registry — docs/ARCHITECTURE.md §4.2, §8.
 * Adding a future connector = one file implementing SourceConnector + one row
 * in `sources`.
 */
import type { SourceConnector } from '@hemline/contracts';

const registry = new Map<string, SourceConnector>();

export function registerConnector(connector: SourceConnector): void {
  if (registry.has(connector.id)) {
    throw new Error(`Connector already registered: ${connector.id}`);
  }
  registry.set(connector.id, connector);
}

export function getConnector(id: string): SourceConnector | undefined {
  return registry.get(id);
}

export function allConnectors(): SourceConnector[] {
  return [...registry.values()];
}
