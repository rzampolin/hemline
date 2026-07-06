# OWNER: frontend-eng (everything EXCEPT app/api/** — that's backend-eng)

**Scope:** all pages/components in this app + `packages/ui` + `e2e/`
(docs/ARCHITECTURE.md §2). Merge-conflict rule: pages (frontend) and
`app/api/**` route handlers (backend) are disjoint file sets — keep it that way.

## Route map to build (doc §2, PRODUCT_SPEC §4)
- `app/(marketing)/page.tsx` — landing *(placeholder in place)*
- `app/onboarding/**` — quiz, ≤8 screens, tap-first, progress bar
- `app/calibrate/**` — swipe deck (10–15 in-stock dresses)
- `app/feed/**`, `app/search/**` — card grid, filter sheet, URL-reflected state
- `app/dress/[id]/**` — detail + effective-length module (body diagram)
- `app/profile/**`, `app/color-analysis/**`

Every card shows the effective-length line — "Length unverified" when unknown,
never blank (PRODUCT_SPEC B2, non-negotiable for demo).

You can build against MSW mocks of the contract shapes before backend routes
land — request/response types are all in `@hemline/contracts`. Design the feed
for optimistic/deterministic order first; LLM re-rank order swaps in when ready
(doc §10 risk 3).
