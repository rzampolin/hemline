# OWNER: frontend-eng

**Scope:** Playwright e2e specs (docs/ARCHITECTURE.md §9.4), run via
`npm run test:e2e` against a seeded dev server (`npm run seed && npm run dev`).

Add `@playwright/test` as a root devDependency and wire the root `test:e2e`
script when you start (it currently prints "not yet implemented").

The 4 flows:
1. onboarding quiz → feed renders
2. search + filter → detail shows correct hem text for the demo user height (5'4")
3. swipe calibration updates feed order
4. color quiz fallback → palette on profile

Seed is deterministic (fixture corpus + demo user) — keep specs deterministic;
selfie flow stays unit-tested, e2e uses the quiz path.
