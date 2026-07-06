# OWNER: frontend-eng

**Scope:** shared Tailwind component kit (docs/ARCHITECTURE.md §2). Also owns
`apps/web` UI (all pages — NOT `apps/web/app/api`, that's backend-eng) and
`e2e/` Playwright specs.

## Planned components (build as needed, mobile-first)
`Card` (product card per PRODUCT_SPEC B2 — effective-length line is mandatory
on EVERY card; "Length unverified" when unknown), `SwipeDeck`, `HemIndicator`
(vertical body diagram + Measured/Estimated tag), `FilterSheet`, `PaletteChip`
("in your palette", removable), `FreshnessBadge` ("Seen 2h ago"), `ProgressDots`.

Notes:
- Tailwind v4 is configured in apps/web; this package ships raw TSX consumed
  via `transpilePackages` — no build step, className utilities resolve in the app.
- Client components need the `'use client'` directive (App Router RSC).
- Never import `@hemline/db` here (better-sqlite3 is server-only).
