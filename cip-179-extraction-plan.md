# Extraction plan — a reusable `cip-179` package

Status: executed. The package now lives at `packages/cip179` with the
`cip-179` / `/domain` / `/tally` / `/txproof` / `/tlock` subpath surface
described below; `@tessera/tlock` has been folded in and removed.

Goal: separate what is Tessera-specific from what any CIP-179 application could
reuse, and grow the existing `cip-179` package (today: codec only, ~1.9k lines,
zero deps, unpublished) into that reusable surface. Publish from this monorepo
for now; extract to a dedicated repository once the CIP stabilizes.

## 1. Context — current organization

The monorepo already has a gradient from "pure spec" to "Tessera app":

| Layer           | Package                          | Contents                                                                                                                                                                | Deps                   |
| --------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------| ---------------------- |
| Spec codec      | `cip-179` (in `frontend/cip179`) | types, encode/decode metadatum, validate, constants                                                                                                                     | none                   |
| Domain          | `@tessera/core`                  | survey aggregation, audit, dedupe, cancellation, credential proof, count + stake-weighted tally, canonical JSON, tally artifact, gov-link parsing, `DataSource` seam, `wire.ts`, `config.ts`, `page.ts` | @noble/hashes          |
| Sealed          | `@tessera/tlock`                 | drand round math, lazy tlock client, padding, seal/reveal, CBOR envelope                                                                                                | tlock-js, evolution-sdk |
| Data access     | `@tessera/koios`                 | `KoiosDataSource`, Koios-JSON/tx-CBOR adapters, stake inputs, tx proofs, bech32 ids                                                                                     | evolution-sdk          |
| Tooling         | `@tessera/verifier`              | standalone artifact re-verifier CLI                                                                                                                                     | all of the above       |
| App             | `frontend/app`, `backend/server` | SolidJS UI/wallet/i18n; Cloudflare serving tier + stores                                                                                                                | —                      |

Observations that shaped the plan:

- The boundary problem is not in the codec but in `@tessera/core`: most of it is
  **spec semantics** (any implementation needs dedupe, cancellation, credential
  proof, tallying), not Tessera choices. The genuinely Tessera parts are thin:
  `config.ts`, the `DataSource` seam, and the Explore-list paging.
- Sealed submission is in the CIP itself (`sealed_submission_mode`), so the
  tlock stack is spec material, not a Tessera extension.
- Natural fault lines follow dependency weight: codec (zero-dep) → domain/tally
  (@noble only) → txproof/tlock (evolution-sdk, tlock-js — both already behind
  dynamic imports).
- `cip-179` is not on npm yet, the CIP is `Status: Proposed`, and two spec
  change proposals are in flight — API churn is expected.

## 2. Decisions and reasoning

Settled in discussion (2026-07-07):

1. **The tally ruleset + content-addressed artifact is a cross-implementation
   standard.** Other CIP-179 apps should produce hash-identical artifacts, so
   tally/audit/artifact/weightedTally are published. The artifact format is
   currently Tessera-driven because the CIP does not yet specify it; it is to
   be specified and integrated into the CIP later. Until then the package
   README carries the normative description and a compatibility table
   (package version ↔ `SPEC_VERSION` ↔ ruleset hash) as the interim anchor —
   an old artifact is re-verified by installing the matching package version.
2. **One package, subpath exports** (`cip-179`, `/domain`, `/tally`,
   `/txproof`, `/tlock`) rather than a package family. One version, one README;
   heavy deps become optional peers so codec-only consumers stay light.
3. **No fetching seam is published.** `DataSource` is shaped by how Tessera's
   pages organize their reads ("one method per page-shaped read"); another app
   would organize requests differently. The published surface is *pure
   functions over already-fetched data*. The on-chain **record shapes**
   (`SurveyRecord`, `ResponseRecord`, `CancellationRecord`, `TxProof`,
   `ChainTip`, `SurveyBundle`, …) ARE published — the pure functions are
   defined over them. `source.ts` splits accordingly. `SurveyBundle` is
   published deliberately: it is the input contract for re-verification
   ("a published result re-verifies from exactly this bundle").
4. **`page.ts` stays Tessera** for the same reason as `DataSource`: Explore's
   filtering/search/keyset pagination is Tessera page organization.
5. **`wire.ts` moves wholesale** (initially planned as a split, but the file is
   only `toJsonSafe`/`fromJsonSafe`, and the artifact's hashed body depends on
   those tagged-JSON conventions — they are normative for the artifact
   standard).
6. **`txProof.ts` and `bech32.ts` are published** even though they depend on
   evolution-sdk: they are pure functions over fetched tx bytes, and every
   implementation needs a sanctioned way to produce `TxProof` (cancellation
   verification and mechanism-B proofs are defined over it). The README
   documents the evolution-sdk dependency — dropping it would mean
   re-implementing Cardano primitives; maybe later.
7. **The verifier stays a Tessera repo tool** (clone-and-run); a published
   `cip179-verify` CLI is deferred to the eventual repo split.
8. **`frontend/cip179` moves to `packages/cip179`** (its `frontend/` location
   is historical) and the whole published surface gets a real dist build.
9. **Network constants stay hard-coded** (`epochOfSlot` mainnet/preview
   parameters, drand quicknet pinning) for now.
10. **Monorepo now, dedicated repo later**, once the CIP moves past Proposed.

## 3. Target shape

`packages/cip179`, package name `cip-179`, five subpath entries:

| Subpath           | Contents                                          | Runtime deps                                |
| ----------------- | ------------------------------------------------- | ------------------------------------------- |
| `cip-179`         | existing codec, unchanged                         | none                                        |
| `cip-179/domain`  | pure semantics over on-chain records              | none                                        |
| `cip-179/tally`   | reference ruleset + content-addressed artifact    | `@noble/hashes`                             |
| `cip-179/txproof` | tx CBOR → `TxProof`, bech32/CIP-129 ids           | evolution-sdk (optional peer, lazy import)  |
| `cip-179/tlock`   | sealed-response stack                             | tlock-js + evolution-sdk (optional peers, lazy import) |

### File moves

**→ `cip-179/domain`** (from `packages/core/src`):

- `survey.ts`, `dedupe.ts`, `cancellation.ts`, `proof.ts`, `audit.ts`,
  `answer.ts`, `govLink.ts`, `hex.ts`
- new `records.ts`: the published half of `source.ts` — `ChainPos`,
  `SurveyRecord`, `ResponseRecord`, `CancellationRecord`, `NativeScriptInfo`,
  `CancellationProof`, `VoteBinding`, `TxProof`, `ChainTip`, `Cip179Records`,
  `GovLink`, `SurveyBundle`

**→ `cip-179/tally`** (from `packages/core/src`):

- `tally.ts`, `weightedTally.ts`, `tallyInput.ts`, `canonical.ts`, `wire.ts`,
  `artifact.ts` (`RULESET_DESCRIPTOR`, `rulesetHash()`, `TallyArtifact`)

**→ `cip-179/txproof`** (from `packages/koios/src`):

- `txProof.ts`, `bech32.ts` (both keep their dynamic-import discipline)

**→ `cip-179/tlock`**:

- all of `packages/tlock/src`, quicknet beacon fixture included;
  `@tessera/tlock` is then deleted and the app's `~/tlock/*` shims re-point

**Stays Tessera:**

- `@tessera/core` slims to `config.ts`, `page.ts`, and the seam half of
  `source.ts` (`DataSource`, `SurveyListPayload`, `BackendHealth`), importing
  record types from `cip-179/domain`
- `@tessera/koios` keeps `koios.ts`, `metadatum.ts`, `tallyInputs.ts`,
  importing `bech32`/`decodeTxProof` from `cip-179/txproof`
- `@tessera/verifier`, `frontend/app`, `backend/server` unchanged in role
- tests move with their files

### Package mechanics

- exports map with per-subpath `types`/`import`; tsc dist build (`.js` +
  `.d.ts` + maps); `sideEffects: false`; root subpath stays zero-dependency
- `@evolution-sdk/evolution` and `@mattpiz/tlock-js` as `peerDependencies`
  with `peerDependenciesMeta.optional: true`
- README documents: subpath → required-peer table; the evolution-sdk note on
  `txproof`; the interim artifact-spec section with the
  version ↔ `SPEC_VERSION` ↔ ruleset-hash compatibility table, marked as
  Tessera-driven pending CIP integration

## 4. Migration order

Each step ends green: `pnpm -r type-check && pnpm -r test`.

1. Move `frontend/cip179` → `packages/cip179`; update `pnpm-workspace.yaml`
   and the root `build:libs` script.
2. Add the subpath skeleton, exports map, and build config.
3. Move the domain files; split `source.ts`; `@tessera/core`'s index
   re-exports the moved names so app/server importers don't churn yet.
4. Move the tally files (same re-export bridge).
5. Move `txProof.ts`/`bech32.ts`; update `@tessera/koios` imports directly
   (3 call sites).
6. Move tlock; re-point the app's `~/tlock/*` shims and the verifier; delete
   `@tessera/tlock`.
7. Slim `@tessera/core`; migrate server/verifier/koios to direct `cip-179`
   imports (few files — doing it now makes the later repo split trivial); the
   app keeps its shim pattern.
8. README + compatibility table; full workspace check.
