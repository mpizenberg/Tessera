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

| #   | Finding                                                                  | File(s)                                                                                 | Status |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------ |
| 1   | Shared answer-validation → tally/audit; add `"invalid"` exclusion bucket | `domain/audit.ts`, `domain/tally.ts`, `ui/screens/Survey.tsx`                           | ✅     |
| 2   | Koios pagination past 1000 + "incomplete" signal                         | `data/koios.ts`, `data/source.ts`, `Explore.tsx`, `Survey.tsx`                          | ✅     |
| 3a  | Cancellation owner-proof — full CIP-179 mechanism-A verification         | `domain/cancellation.ts`, `data/txProof.ts`, `data/koios.ts`, `domain/survey.ts`, `ui/` | ✅     |
| 3b  | Unverified gov-link title affordance                                     | `data/koios.ts`                                                                         | ⏭️     |

**Phase 2 verified:** `type-check`, `format:check`, all 47 unit tests pass (6 files).
Item 3a (cancellation) fully solved — see changelog. Item 3b (gov-link title authenticity) still carries its `TODO(govlink-title-trust)` marker.

## Phase 3 — Reactivity & UX bugs

Small diffs, each needs manual verification in the running app.

| #   | Finding                                                               | File(s)                                            | Status |
| --- | --------------------------------------------------------------------- | -------------------------------------------------- | ------ |
| 1   | Respond draft re-seed effect missing `definition()`/`existing()` deps | `ui/screens/Respond.tsx`                           | ✅     |
| 2   | Respond role-pick mutates global `activeRole`                         | `ui/screens/Respond.tsx`                           | ✅     |
| 3   | SealedResults reveal resource frozen to `props.records`               | `ui/screens/Survey.tsx`                            | ✅     |
| 4   | Header `installedWallets` read non-reactively                         | `ui/components/Header.tsx`, `state.tsx`            | ✅     |
| 5   | Settings `storedKoiosToken` read non-reactively                       | `ui/screens/Settings.tsx`                          | ✅     |
| 6   | Numeric slider bypasses `clampStep`                                   | `ui/screens/Respond.tsx`                           | ✅     |
| 7   | Header dropdowns: outside-click/Escape close + cleanup                | `ui/components/Header.tsx`                         | ✅     |
| 8   | Gov submit never calls `trackTx`                                      | `ProposeInfoAction.tsx`, `state.tsx`, `Header.tsx` | ✅     |
| 9   | Snapshot `error` rendered as "not found"/empty                        | `Respond.tsx`, `Explore.tsx`, `Survey.tsx`         | ✅     |
| 10  | SubmitProgress modal a11y (dialog role/focus/aria-live)               | `ui/components/SubmitProgress.tsx`                 | ✅     |
| 11  | Builder buttons `type="button"` + toggle ARIA roles                   | `ui/screens/Create.tsx`, `Header.tsx`              | ✅     |

**Phase 3 verified:** `type-check`, `format:check`, all 47 unit tests pass. Item 9
on Explore was already handled in Phase 2; this phase added the same error+retry
affordance to Respond and Survey. Each item still warrants a manual smoke test in
the running app (these are reactivity/UX fixes with no unit coverage).

## Phase 4 — Code quality (incremental, lowest urgency)

| #   | Finding                                                       | File(s)                                                             | Status |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| 1   | `#E7E0D0` → `var(--line)` (zero-risk token swap)              | `Header`, `BottomNav`, `Survey`, `Explore`, `Respond`               | ✅     |
| 2   | Extract `<SegmentedToggle>` / `<Note>` / `<Spinner>`          | `ui/components/` (+ Header/Settings/OnchainPreview/Respond/Submit…) | ✅     |
| 3   | Hoist CSV / `validateAnchorShape` / epoch-math into `domain/` | `domain/answer`, `domain/govLink`, `domain/survey`, screens         | ✅     |
| 4   | Token cleanup for remaining hardcoded hex/radii               | `theme.css`, `ui/`                                                  | ✅     |

**Phase 4 verified:** `type-check`, `format:check`, all **66** unit tests pass
(8 files — added `domain/answer.test.ts` (+9), `domain/govLink.test.ts` (+8),
`voteDeadlineUnix` cases in `survey.test.ts`, and a 64-hex `parseGovLink` case).
Scope note on item 4: I deliberately swapped only literals whose semantic intent
matches a token (the `#E7E0D0` hairline; new dedicated tokens for the recurring
card cluster / danger ink / menu shadow) and left the bespoke one-off colors and
the standalone **role-color palette** (`roleColors`) untouched — some of its
values coincidentally equal `--ok`/`--warn`, so tokenizing by value-equality
would create misleading semantic coupling.

---

## Changelog

_(newest first)_

- **Phase 4 — code quality (all 4 items)** —
  - **Domain hoisting (#3)** — moved view-embedded pure logic into the
    unit-tested domain layer:
    - `domain/answer.ts` — `serializeAnswer` / `humanizeAnswer` / `optionLabelOf`
      lifted out of `Survey.tsx` (which now imports them); the local `hex()`
      duplicate was dropped for the existing `bytesToHex`. New `answer.test.ts`
      (9 tests) pins the CSV + human render of every answer variant.
    - `domain/govLink.ts` — `parseCip179Link` is now the single source of truth
      for the CIP-179 survey-link shape, shared by `data/koios.ts#parseGovLink`
      (discovery) and `ProposeInfoAction#validateAnchorShape` (builder, which
      adds only the JSON-parse wrapper + `@context` nicety). Unified on the
      stricter **64-hex** `surveyTxId` rule (the old discovery path accepted any
      string → bogus refs); `koios.test.ts` fixtures updated, `govLink.test.ts`
      (8 tests) added.
    - `voteDeadlineUnix` moved from `Explore.tsx` into `domain/survey.ts`
      alongside `epochOfSlot`; `survey.test.ts` gained deadline cases.
  - **Shared components (#2)** — extracted `<SegmentedToggle>` (replaces the four
    copy-pasted toggles in Header/Settings/OnchainPreview/Respond; uniformly adds
    `role="group"` + `aria-pressed` + `type="button"`), `<Spinner>` (Header ×2 +
    SubmitProgress), and `<Note>` (the gov-action callout, ~11 call sites in
    ProposeInfoAction). The toggle's bg/line/off-text became `--toggle-*` tokens.
  - **`#E7E0D0` → `var(--line)` (#1)** — all six hairline borders (Header,
    BottomNav, Survey, Explore, Respond) now use the token.
  - **Token cleanup (#4)** — added `--card-bg`/`--card-line`/`--label` (the
    recurring inner-panel surface/border/label, ~31 literals), `--danger-ink`
    (deeper danger body copy, 5), `--shadow-menu` (Header dropdowns, 2); swapped
    `99px` → `var(--r-pill)` in `ResultBarCard`. Every swap is value-identical to
    its token, so there is no visual change. Bespoke one-offs and the role-color
    palette were left as-is on purpose (see Phase 4 scope note).
- **Phase 3 — reactivity & UX bugs (all 11 items)** —
  - **Respond draft re-seed (#1)** — the `on(...)` re-seed effect now also tracks
    `definition()` and `existing()`, so a prior on-chain response that loads after
    the first seed (e.g. once the wallet auto-reconnects) and external-content
    enrichment both pre-fill correctly. Added a `touched` guard (set by
    `setValue`/`setSkipped`): a change of survey/role makes the form pristine
    again, but late-arriving data and reloads never clobber in-progress answers.
  - **Per-survey role (#2)** — picking a response role no longer calls
    `app.setActiveRole`; it drives only the local `roleOverride`, so it can't
    rewrite the app-wide active role used by the "mine" Explore filter.
  - **Sealed reveal resource (#3)** — keyed on a fingerprint (`round` + sorted
    response tx hashes) instead of the bare round number, so it re-tallies when
    new sealed responses land, while still staying stable across the 30s clock
    tick and object identity.
  - **Reactive wallet list (#4)** — `installedWallets` is now a signal in
    `state.tsx`, refreshed ~15×200ms after mount and on window focus (wallets
    inject asynchronously); `Header`'s `WalletPicker` reads it reactively, so a
    slow-injecting wallet appears without a remount.
  - **Settings stored-token signal (#5)** — mirrored the persisted Koios override
    into a signal so `dirty()` and the "Use app default" disabled state refresh
    after save/reset (previously read non-reactive localStorage).
  - **Slider step (#6)** — the numeric-range slider now routes through
    `clampStep`, matching the number input, so it can't emit off-step values that
    `validateResponse` would block.
  - **Header dropdowns (#7)** — both menus close on outside `pointerdown` / Escape
    via document listeners registered only while open and removed in `onCleanup`.
  - **Gov-action tracking (#8)** — `ProposeInfoAction` now calls `trackTx` after a
    successful submit; added a `"govAction"` `PendingKind` (+ Header pending /
    confirmed labels) so the proposal shows in the pending indicator like Create.
  - **Snapshot error (#9)** — Respond's and Survey's `Empty` now branch on
    `snapshot.error` with a Retry (→ `app.reload()`) instead of masquerading a
    transient Koios failure as "Survey not found." (Explore already did this.)
  - **SubmitProgress a11y (#10)** — added `role="dialog"`/`aria-modal`/
    `aria-labelledby`, focus-in on mount, and a visually-hidden `aria-live`
    region announcing the current step.
  - **Button semantics (#11)** — `type="button"` on all Create + Header buttons
    (defensive: no `<form>` today); `aria-pressed` on the mode/role/scale toggles
    and Plain/Pro switch; `aria-label`/`aria-expanded` on icon-only buttons.
- **Scope cancellation verification to still-open surveys** — a cancellation can
  only suppress a survey while it's still answerable; once a survey has ended
  (tip past its `end_epoch`) it's closed regardless, so verifying its cancellation
  is wasted work.
  - `koios.ts#fetchAll` now partitions cancellations by whether their target
    survey is still open and fetches `/tx_cbor` proofs only for the open ones;
    closed (or unknown-target) cancellations keep `proof: null` without a fetch.
  - `domain/survey.ts#cancellationStates` mirrors this: it skips any cancellation
    whose survey has already ended (`tip.epoch > end_epoch`). This replaces the
    per-slot "cancelled after end_epoch" timing check, which it subsumes (for an
    open survey any on-chain cancellation is necessarily in-window), so the
    now-vestigial `secondsPerEpoch` param was dropped from `cancellationStates`,
    `aggregateSurveys`, and `governanceSinceUnix` (call sites in `state.tsx` +
    `survey.test.ts` updated). Side benefit: an ended survey that had a real
    cancellation no longer shows a misleading "unverified claim" warning — it's
    just "ended".
- **Cancellation owner-proof verification (Phase 2, item 3a)** — replaced the
  "honor any cancellation" stopgap with full CIP-179 mechanism-A verification.
  - A cancellation is a bare `survey_ref`; authenticity is the _cancelling tx_
    proving the survey's `owner` credential. Koios `/tx_info` exposes no
    `required_signers`/witnesses, but `/tx_cbor` returns the raw tx — so
    `data/txProof.ts` (lazy evolution-sdk) decodes `body.required_signers` and the
    witness-set native scripts into a framework-agnostic `CancellationProof`.
  - `domain/cancellation.ts` (pure, 11 tests): key owner ⟹ `keyHash ∈
required_signers`; native-script owner ⟹ script (from the witness set, hashed
    via `blake2b-224(0x00‖cbor)`) satisfied by the signers, incl. all/any/atLeast/
    nested/timelock; Plutus owner / absent proof ⟹ unverified.
  - `koios.ts` batches `/tx_cbor` (25/req) for cancellation txs only and attaches
    the proof; failure → `proof:null` → unverified (never sinks the snapshot).
  - `aggregateSurveys` is now tri-state (`domain/survey.test.ts`, 6 tests):
    `cancelled` means **owner-verified + within `end_epoch`** (only this closes a
    survey); `cancellationClaimed` flags an unverified claim, surfaced as a warning
    in the Survey + Respond screens but never suppressing the survey. `epochOfSlot`
    moved to `survey.ts` (shared, re-exported from `audit.ts`) for the deadline rule.
  - Investigation note: evolution-sdk's full `Transaction.fromCBORHex` decodes all
    recent CIP-179 txs fine (only 2021 pre-Alonzo 3-element txs fail) — confirmed by
    a repro worker; we still wrap decode in try/catch → unverified for safety.
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
