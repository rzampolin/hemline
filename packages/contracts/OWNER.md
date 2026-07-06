# OWNER: architect / EM

**Scope:** every cross-module TypeScript type + Zod schema (docs/ARCHITECTURE.md §4).

**Status: FROZEN.** This package landed in week 0 and is frozen. Changes after the
freeze must be additive-only and require a PR reviewed by all four engineers
(data-eng, ai-eng, backend-eng, frontend-eng).

Imports nothing except `zod`. Do not add runtime logic here — types, enums, and
Zod schemas only.
