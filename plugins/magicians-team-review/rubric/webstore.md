## Area: Webstore and Page Builder (repo znode-webstore10x-page-builder, Next.js 15 / React 19, Nx monorepo)

Structure: `apps/webstore` (storefront), `apps/page-builder` (editor host), shared libraries in `packages/*` (`base-components`, `bstore`, `page-builder`, `clients`, `types`, `constants`, `utils`, `cache`, `logger`).

**Conventions (errors in this repo's lint)**: double quotes, semicolons, no `console`, no `any`, max 1000 lines per file and 500 per function. Cross-package imports use the aliases in `tsconfig.base.json` (`@znode/...`), never relative `../../packages/...`. API calls go through `customFetch` (timeout, GET de-duplication, sanitized logging), never raw `fetch`. Prefer the V2 clients over V1 (V1 is being removed; avoid adding V1 calls). Commit/PR title style is `type: subject`.

**Page builder**: widgets are an `XConfig.tsx` (Puck field schema) plus an `XRender.tsx` that delegates to a component in `@znode/base-components/znode-widget/*`. Theme-specific widgets live in `bstore-config` and wrap `@znode/bstore/*`. Check that a new or changed widget is registered in the right config, that its field schema and render stay in sync, and that stored page JSON stays compatible (see `lib/migrations`). Server and client rendering must not diverge (cookies/locale read on the client but not the server cause hydration mismatches).

**Webstore**: routes under `src/app/[locale]/...`; `src/middleware.ts` handles domain config, NextAuth gating, admin-only paths, maintenance mode and headers, so changes there affect every request. Check auth and IDOR handling (requests carry the encrypted `Z-Request-Context`), cache keys that omit locale or user, unsafe HTML (`dangerouslySetInnerHTML`), secrets or debug tokens, missing loading/error states, accessibility (labels, keyboard, alt text), translations (`next-intl` keys present for every added string), and unbounded lists or N+1 fetching.

**Impact**: which pages and widgets render the changed component; effect on the Puck editor versus the live storefront; whether API contract changes in the API PR are matched in `packages/clients` and `packages/types`.

**Edge cases and performance to check on webstore changes**: empty, loading and error states; very long text and many items; non-default locale and RTL; logged-out versus logged-in versus admin users; slow or failed API responses; double clicks and race conditions; extra fetches on render, missing memoization on large lists, large client bundles, images without size or lazy loading, server components that become dynamic and lose caching.

**Additional webstore checks (standard review points)**
- TypeScript: no `as` casts or `!` non-null assertions that hide a real null; no `@ts-ignore`; API data validated or typed at the boundary (`packages/types`).
- React: hook dependency arrays correct, effects clean up timers/listeners/subscriptions, stable `key` props (not array index for reorderable lists), state not duplicated from props, no work on every render that should be memoized.
- Next.js: `"use client"` only where needed (keep server components server); cache behaviour is intended (`revalidate`, tags, `cache: "no-store"` only when required); no `NEXT_PUBLIC_*` variable holding a secret; route handlers and server actions validate input and check the caller's session.
- Widgets: every field in the Puck schema has a safe default so existing saved pages still render; removed or renamed fields have a migration.
- UI changes: loading, empty and error states exist; images use `next/image` with sizes; alt text, labels and keyboard focus are present; before/after screenshots are a nice-to-have (a `low` suggestion at most, never a blocker); translations exist for all locales that are shipped.
- Tests are NOT required for webstore PRs: never raise a finding about missing tests or test results. If tests exist and are visibly broken by the change, mention it as a `medium` correctness finding.


## Architecture alignment (Webstore) - the `architecture` checklist item: Next.js 15 / React 19 standards
Judge the change against the Next.js 15 App Router model and this monorepo's layering:
- Server first: pages, layouts and data fetching are Server Components by default; `"use client"` only on the smallest leaf that needs state, effects or browser APIs, never on a page or layout without a reason. No data fetching in `useEffect` for data that can be fetched on the server. No client component importing server-only code.
- Next.js 15 behaviour: `params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` are asynchronous and must be awaited; `fetch` is NOT cached by default in 15, so caching must be explicit (`revalidate`, `next: { tags }`, `unstable_cache`) and match what the page needs; use the metadata API (`generateMetadata`), `next/image`, `next/link`, `next/font`; route handlers and server actions validate input with a schema and check the session; use `loading.tsx`, `error.tsx`, `not-found.tsx` where the segment fetches data; no `pages/` router code and no deprecated APIs.
- React 19: no legacy patterns (no `defaultProps` on function components, no string refs, `forwardRef` only where still needed); use `useActionState`, `useFormStatus` and `useOptimistic` for forms where they fit; hook rules and dependency arrays correct; no state derived from props; stable keys.
- Layering: app code -> `@znode/*` packages. Shared UI belongs in `@znode/base-components`, API access in `@znode/clients` through `customFetch`, types in `@znode/types`, constants in `@znode/constants`. No duplicated component or client inside an app, no relative cross-package imports, no business logic in a widget's `Render` file beyond delegating to the shared component.
- Contract: every API field the webstore reads exists in the API PR (names, nullability, status codes) and in `packages/clients` and `packages/types`; a mismatch with the API PR, or a missing counterpart PR, is a `high` finding.
- Typing and quality: strict TypeScript, no `any`, no `!`, no `@ts-ignore`; i18n through `next-intl` for every string in every shipped locale; accessibility (labels, roles, keyboard, alt text); Core Web Vitals (no layout shift, lazy images with sizes, no large client-only bundles, dynamic import for heavy widgets).
Tests are NOT required for webstore PRs.
