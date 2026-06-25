# Review Remediation — Progress Tracker

Tracks work against the findings in [`review-report.md`](./review-report.md).
Status legend: ⬜ todo · 🔄 in progress · ✅ done · ⏭️ deferred

---

## Phase 1 — Security quick wins

Isolated, small diffs, no architectural change. One commit per item.

| #   | Finding                                                                 | File(s)                                              | Status |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ------ |
| 1   | `anchorHttpUrl` XSS — add shared `safeExternalHref` scheme guard        | `ui/format.ts`, `ui/screens/Survey.tsx`              | ✅     |
| 2   | Gov anchor URL scheme validation before signing                         | `ui/screens/ProposeInfoAction.tsx`                   | ✅     |
| 3   | Network-mismatch gating on Create/Respond (+ hoist `mismatch()` helper) | `ui/screens/Create.tsx`, `Respond.tsx`, `Header.tsx` | ✅     |
| 4   | tlock robustness — `drand` floor→ceil; `client` retry-on-reject         | `tlock/drand.ts`, `tlock/client.ts`                  | ✅     |

**Phase 1 verified:** `type-check`, `format:check`, and all 26 unit tests pass (incl. new `tlock/drand.test.ts`).

## Phase 2 — Trust-boundary & tally correctness

Needs shared code + unit tests.

| #   | Finding                                                                  | File(s)                                                        | Status |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------ |
| 1   | Shared answer-validation → tally/audit; add `"invalid"` exclusion bucket | `domain/audit.ts`, `domain/tally.ts`, `ui/screens/Survey.tsx`  | ✅     |
| 2   | Koios pagination past 1000 + "incomplete" signal                         | `data/koios.ts`, `data/source.ts`, `Explore.tsx`, `Survey.tsx` | ✅     |
| 3   | Unverified-cancellation + unverified-gov-title affordances               | `domain/survey.ts`, `data/koios.ts`                            | ⏭️     |

**Phase 2 verified:** `type-check`, `format:check`, all 30 unit tests pass (audit suite 6→10).
Item 3 deferred per request — actionable `TODO(cancellation-verification)` and `TODO(govlink-title-trust)` markers added in code instead of changing behavior now.

## Phase 3 — Reactivity & UX bugs

Small diffs, each needs manual verification in the running app.

| #   | Finding                                                               | File(s)                                    | Status |
| --- | --------------------------------------------------------------------- | ------------------------------------------ | ------ |
| 1   | Respond draft re-seed effect missing `definition()`/`existing()` deps | `ui/screens/Respond.tsx`                   | ⬜     |
| 2   | Respond role-pick mutates global `activeRole`                         | `ui/screens/Respond.tsx`                   | ⬜     |
| 3   | SealedResults reveal resource frozen to `props.records`               | `ui/screens/Survey.tsx`                    | ⬜     |
| 4   | Header `installedWallets` read non-reactively                         | `ui/components/Header.tsx`                 | ⬜     |
| 5   | Settings `storedKoiosToken` read non-reactively                       | `ui/screens/Settings.tsx`                  | ⬜     |
| 6   | Numeric slider bypasses `clampStep`                                   | `ui/screens/Respond.tsx`                   | ⬜     |
| 7   | Header dropdowns: outside-click/Escape close + cleanup                | `ui/components/Header.tsx`                 | ⬜     |
| 8   | Gov submit never calls `trackTx`                                      | `ui/screens/ProposeInfoAction.tsx`         | ⬜     |
| 9   | Snapshot `error` rendered as "not found"/empty                        | `Respond.tsx`, `Explore.tsx`, `Survey.tsx` | ⬜     |
| 10  | SubmitProgress modal a11y (dialog role/focus/aria-live)               | `ui/components/SubmitProgress.tsx`         | ⬜     |
| 11  | Builder buttons `type="button"` + toggle ARIA roles                   | `ui/screens/Create.tsx`, `Header.tsx`      | ⬜     |

## Phase 4 — Code quality (incremental, lowest urgency)

| #   | Finding                                                       | File(s)                       | Status |
| --- | ------------------------------------------------------------- | ----------------------------- | ------ |
| 1   | `#E7E0D0` → `var(--line)` (zero-risk token swap)              | `Header.tsx`, `BottomNav.tsx` | ⬜     |
| 2   | Extract `<SegmentedToggle>` / `<Note>` / `<Spinner>`          | `ui/components/`              | ⬜     |
| 3   | Hoist CSV / `validateAnchorShape` / epoch-math into `domain/` | `domain/`, screens            | ⬜     |
| 4   | Token cleanup for remaining hardcoded hex/radii               | `ui/`                         | ⬜     |

---

## Changelog

_(newest first)_

- **Phase 2 (items 1–2) complete; item 3 deferred** —
  - **Tally/audit validation** — added `responseIsCountable(definition, response)`
    to `domain/audit.ts`, reusing the codec's `validateResponse` (single source of
    truth) instead of reimplementing checks in tally. `auditResponses` now takes the
    full definition and excludes constraint-invalid responses as a new `"invalid"`
    bucket **before** dedup (so a malformed later response can't suppress a valid
    earlier one). Sealed reveals re-validate decrypted answers, splitting
    `undecryptable` (didn't decode) from `invalid` (decoded but out-of-constraint).
    `tally.ts` documents that it trusts the audited input. audit tests 6→10.
  - **Koios pagination** — `fetchAll` now offset-paginates the label-17 index
    (`PAGE_SIZE` 100, `MAX_PAGES` 50 → 5,000-row ceiling) instead of a single
    `limit=1000`, deduping by
    tx_hash. On hitting the cap it flags `Cip179Records.incomplete`, surfaced as a
    warning banner in Explore and on the Survey results page so an undercounted
    tally isn't shown as authoritative.
  - **Item 3 deferred** (per request) — added `TODO(cancellation-verification)` in
    `domain/survey.ts` and `TODO(govlink-title-trust)` in `data/koios.ts` documenting
    the unverified-trust gaps and the fix paths, with no behavior change for now.
- **Phase 1 complete** — all four security quick wins landed and verified:
  - **XSS guard** — added `safeExternalHref` + `isSafeAnchorUri` to `ui/format.ts`
    (single source of truth, mirrors `content.ts`'s scheme allow-list). `Survey.tsx`
    now renders the rationale link only via `<Show when={safeExternalHref(uri)}>`;
    deleted the unsafe `anchorHttpUrl` (which returned any non-ipfs scheme verbatim).
  - **Gov URL validation** — `ProposeInfoAction` gates submit on `isSafeAnchorUri`
    and shows an inline error for non-ipfs/https URLs before signing.
  - **Network-mismatch gating** — hoisted `networkMismatch()`/`expectedNetworkId()`
    into `ui/format.ts`; `Header`, `ProposeInfoAction`, `Create`, and `Respond` all
    use it. Create's `blockedReason` and Respond's `ready()` now block on mismatch
    (Respond also shows a "switch your wallet to {network}" note).
  - **tlock** — `roundForUnixTime` now uses `ceil` (was `floor`, could pick a round
    publishing up to ~3s before the deadline); `client.ts` clears the memoized
    import on failure so a transient chunk-load error can retry. Added
    `tlock/drand.test.ts` (5 tests) covering the "never before the deadline" invariant.
- **Phase 1 started** — implementing the four security quick-win commits.
