/**
 * Query layer (backend-eng, additive) — repositories the API routes consume.
 * No schema changes here; aux tables (pending_alerts, extraction_corrections)
 * are lazily created and flagged as schema-change requests.
 */
export * from './mappers';
export * from './profiles';
export * from './listings';
export * from './swipes';
export * from './saves';
export * from './alerts';
export * from './admin';
export * from './clickouts';
export * from './ai-cache';
export * from './embeddings';
