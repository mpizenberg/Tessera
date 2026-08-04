# DRepTalk Preprod Interoperability and Tessera Operator Readiness

## Progress

- Plan created from DRepTalk maintainer feedback.
- Increment 1 complete: preprod is strict shared configuration across backend, verifier, transaction building, explorer/storage utilities, and a local/static frontend mode; full repository checks, a preprod build, and a Wrangler dry run pass.
- Increment 1 follow-up: Preview Wrangler commands now select an explicit named environment, matching preprod and mainnet and eliminating ambiguous-environment warnings.

## Decisions

- **Treat a survey as DRepTalk's first-class forum resource, with governance actions as optional relations.** The action-centric alternative in the earlier integration report would give standalone or multiply linked surveys no canonical discussion, URL, or notification target. DRepTalk will own admission and topic creation; Tessera will continue to index every protocol-valid survey. Reversing this after forum data exists would require topic and URL migration, so this supersedes the earlier recommendation now.
- **Keep this plan Tessera-focused and use the existing HTTP API as the integration boundary.** The alternative was to begin DRepTalk's Survey category and schema in parallel. Proving network, transaction, validation, and operating-cost seams first avoids building DRepTalk persistence around an unmeasured service. DRepTalk implementation remains a separate follow-on plan in its repository.
- **Add preprod to the shared network model, not as a backend-only special case.** The alternative was a second backend network type beside the app/core type. One strict `mainnet | preprod | preview` model prevents testnet confusion across the backend, verifier, transaction builder, explorer links, storage keys, and optional local Tessera app. A deployed preprod backend is required; a public Tessera preprod frontend is optional. Reversible, but splitting network models later would add rather than remove concepts.
- **Select a named Wrangler environment for Preview as well as preprod and mainnet.** The alternative was to keep Preview implicit in the top-level configuration, which made routine deploy, development, and migration commands emit ambiguous-environment warnings and treated one network differently. The top-level Preview values remain a safe fallback, while project commands consistently pass `--env`; this is cheaply reversible.
- **Measure Cloudflare resource usage with provider telemetry and keep `/api/health` focused on application health.** The alternative was to approximate Worker CPU, D1 billable rows, and database storage inside Tessera. Cloudflare already exposes the authoritative CPU, wall-time, query, row, latency, and storage metrics; duplicating them would be incomplete and would add writes. Tessera may add phase/change counters where they explain workload, but not a shadow billing system.
- **Replace whole-snapshot D1 rewrites with incremental reconciliation during this spike.** The alternative was to measure the current implementation and defer remediation. Every refresh currently deletes and reinserts every survey and response, so writes grow with total history and the D1 batch approaches the paid-plan 1,000-query invocation limit at roughly 1,000 materialized records. Immutable records and an authoritative full scan permit insert/update/delete diffs while retaining atomic publication. Reversing this would restore a known operating ceiling.
- **Prove independent key-DRep response submission before any combined governance vote and response.** The alternative was the earlier spike criterion requiring both transaction forms. Independent submission isolates the widget/API/wallet boundary and follows DRepTalk's desired product sequence; combined submission remains an optional later convenience.
- **Do not add a DRepTalk-specific Tessera endpoint unless the spike identifies a missing capability.** The alternative was an integration projection or webhook. The existing exact-reference survey bundle, artifact, tip, protocol-parameter, transaction-status, health, and CORS contracts cover the proposed first flow, and DRepTalk can cache only its admitted subset while Tessera scans all surveys.

## Context

The earlier report at `plans/2026-08-02-cip-179-dreptalk-integration.md` established the protocol boundary correctly but proposed governance-action threads as the first survey home. DRepTalk's maintainer accepted the technical ownership split and changed the product model:

- an admitted survey receives one canonical topic in a Survey category;
- the topic owns Overview, Discussion, Participate, Results, and related-action presentation;
- zero or more governance actions may link to the same survey;
- DRepTalk admits only an automatically gated subset of surveys, while Tessera scans all label-17 definitions;
- response submission is independent first, with combined vote-and-response deferred;
- DRepTalk may operate one Tessera backend per network if its footprint is modest and predictable.

This plan addresses the Tessera work needed to answer that operational question and make a preprod interoperability test possible. Where it conflicts with the earlier report's action-centric model or sequence, this plan governs the next work.

## Objective

Deliver a reproducible Cardano preprod Tessera service and evidence that DRepTalk can safely depend on its HTTP boundary without implementing CIP-179 rules or accepting an unknown Cloudflare/Koios cost profile.

The spike succeeds when:

1. Tessera identifies and serves Cardano preprod distinctly from Preview and mainnet.
2. A known preprod survey is readable by exact reference through Tessera's API.
3. A DRepTalk development client can use the published response widget with a connected key-DRep credential, submit an independent label-17 response alongside label 674, and have Tessera validate and count it.
4. A replacement response demonstrates latest-valid-response-wins across both applications.
5. An operator can deploy the tested Tessera commit into a separate Worker and D1 database using documented commands and configuration.
6. A written benchmark reports Koios calls, Worker CPU/wall time, D1 reads/writes/query latency/storage, and growth behavior for steady refresh, ingestion, reads, public finalization, and sealed reveal.
7. Snapshot publication costs scale with changed records rather than the entire retained corpus.

## Scope

### In scope

- strict preprod network support in shared configuration, backend, verifier, transaction selection, and affected frontend utilities;
- dedicated preprod Worker/D1 configuration and deployment documentation;
- incremental D1 snapshot reconciliation with atomic publication and reorg/window deletion behavior;
- provider-backed operational measurement and a repeatable collection script/runbook;
- synthetic/local scale scenarios where producing sufficient on-chain preprod volume would be wasteful;
- public and sealed preprod fixtures sufficient to exercise validation and reveal paths;
- a small, versioned interoperability record containing survey references, expected decoded values, and backend commit/deployment identity;
- support for DRepTalk's temporary development host during the independent-response test;
- updating the earlier integration report with measured findings and the accepted first-class survey model when the spike concludes.

### Out of scope

- DRepTalk migrations, Survey category, topic admission, reciprocal cards, or production UI;
- automatic forum import of every Tessera survey;
- survey authoring through DRepTalk;
- owner-credential import challenges and replay protection;
- a reusable `<tessera-results>` component;
- notifications, profile history, or additional responder roles;
- combined governance vote plus survey response;
- changing CIP-179, Tessera artifact rules, or weighting semantics;
- a mainnet deployment commitment.

## Baseline and known risk

The live Preview `/api/health` response observed at plan creation reported:

- 24 surveys and 57 responses;
- 480 refreshes and zero failures over 24 hours;
- 2,405 Koios calls over 24 hours, approximately five per refresh;
- a latest refresh duration of about 2.7 seconds;
- 67,124 bytes of logical materialized payload;
- no response-validation backlog.

These are useful application metrics but do not include Worker CPU, D1 rows read/written, query latency, or physical database size.

The current D1 `replaceSnapshot` executes two table-wide deletes, one insert per survey, one insert per response, and one metadata upsert on every refresh. At the observed 81 domain rows and 480 refreshes per day, the base delete/insert work is about 78,000 changed rows per day before index maintenance and other backend writes. More importantly, the batch contains one SQL statement per materialized record and therefore has a hard paid-plan invocation ceiling near 1,000 records. The spike must remove this total-corpus write/query amplification rather than merely document it.

## Work plan

Each increment ends with tests, a Progress update, and a commit. Decisions or deviations discovered during implementation are appended above and repeated in that increment's summary.

### Increment 1 — Strict three-network foundation

**Goal:** make preprod an explicit, test-covered network everywhere the Tessera service and its verification/submission tools interpret a network.

Work:

- Extend the shared `Network` type and endpoint/duration tables with:
  - `preprod` Koios: `https://preprod.koios.rest/api/v1`;
  - `preprod` epoch duration: 432,000 seconds.
- Introduce one strict network parser used by backend and verifier boundaries:
  - an absent development setting may retain the documented Preview default;
  - an unknown non-empty value must fail startup/verification instead of silently selecting Preview.
- Update backend config tests for all three networks and bad input.
- Update the verifier so `/health` is validated rather than cast to `Network` or defaulted when malformed.
- Select the correct Evolution chain configuration for preprod transaction construction.
- Audit network-dependent explorer paths, wallet mismatch copy, local-storage keys, test fixtures, and build-time frontend parsing.
- Remove the frontend's two-network "counterpart" assumption. If the app exposes cross-network links, derive a list from explicit per-network deployment URLs; do not invent one "other" network in a three-network model.
- Add a preprod Vite mode sufficient for local fixture authoring and optional static deployment.
- Update comments and docs that claim Tessera supports only mainnet and Preview.

Validation:

- focused core/backend/frontend/verifier tests for three network values and invalid input;
- transaction-builder test proving preprod does not select Preview configuration;
- `pnpm type-check`, `pnpm test`, and `pnpm format:check`.

Commit boundary: preprod is a first-class local capability; no Cloudflare resource is required yet.

### Increment 2 — Incremental, atomic snapshot reconciliation

**Goal:** remove D1 work proportional to the complete survey/response archive while preserving one-generation visibility and deletion correctness.

Work:

- Capture a provider-metrics baseline for the existing Preview deployment before changing snapshot persistence.
- Rework the snapshot store contract around reconciliation rather than unconditional replacement:
  - compare immutable response coordinates and stored survey projections;
  - insert only new responses;
  - update only changed survey projections;
  - delete rows absent from the authoritative scan, covering shallow reorgs and movement behind the configured scan floor;
  - update `snapshot_meta` only in the same D1 transaction as the row changes.
- Keep the Node/SQLite and D1 adapters behaviorally identical.
- Bound deletion and insertion SQL with chunked set operations so a large reorg or first materialization does not recreate a one-statement-per-record ceiling.
- Preserve response ordering, ETags, exact bundle bytes, finalized-cancellation overlays, and all current API contracts.
- Add compact per-refresh change counts if needed to explain provider metrics: surveys inserted/updated/deleted and responses inserted/deleted. Do not add generic query or billing counters already supplied by Cloudflare.
- Delete the obsolete whole-replacement path and stale architecture prose in the same increment.

Validation:

- no-op refresh changes only the freshness envelope, not every domain row;
- one new response inserts one response and updates only its survey projection;
- response replacement remains a distinct immutable response row while counts remain deduped;
- removed/reorged records disappear atomically;
- readers never observe rows from two snapshot generations;
- first materialization and large synthetic diffs remain within D1 invocation limits;
- existing API, store-adapter, refresh, finalization, and pagination tests remain green;
- full repository checks.

Commit boundary: the backend has no known total-corpus D1 write/query ceiling in its normal steady-state refresh.

### Increment 3 — Reproducible preprod deployment and measurement tooling

**Goal:** let either maintainer deploy the same code and collect comparable operating evidence without adding provider coupling to runtime logic.

Work:

- Add a dedicated `env.preprod` Worker configuration with its own name, D1 binding, network variable, migrations, limits, and deploy scripts.
- Keep database identifiers and secrets out of source until the operator creates the resource; document exact creation, migration, secret, deploy, rollback, and health-check commands.
- Add a small dependency-free operator script or documented GraphQL queries that collect, over an explicit window:
  - Worker request outcomes, CPU-time quantiles, and wall-time quantiles;
  - D1 `rowsRead`, `rowsWritten`, `readQueries`, `writeQueries`, `queryBatchTimeMs`, and `databaseSizeBytes`;
  - current D1 size from `wrangler d1 info --json`;
  - Tessera `/api/health` refresh counts, failures, duration, upstream calls, corpus size, and validation backlog.
- Ensure reports identify account, Worker, D1 database, network, git commit, window, cron cadence, and workload so figures are comparable.
- Document Koios token separation and which calls consume operator versus passthrough quota.
- Deploy and migrate a preprod backend when credentials are available; verify `/health` returns `preprod` before permitting any client to consume it.
- Optionally deploy the static Tessera preprod app for fixture authoring; DRepTalk must not depend on that frontend.

Validation:

- dry-run/config tests prevent Preview and preprod from sharing a D1 binding or Worker name;
- measurement script fails clearly on missing credentials or mismatched resource/network;
- fresh deployment reaches a first complete snapshot and reports no validation backlog;
- deployment and rollback are reproducible from a clean checkout.

Commit boundary: deployment configuration, collection tooling, and runbook are complete. Actual Cloudflare resource creation is recorded separately because credentials and generated IDs are operator state, not portable source.

### Increment 4 — Preprod protocol fixtures and independent-response proof

**Goal:** prove the exact boundary DRepTalk will consume without introducing production DRepTalk schema or combined transactions.

Work:

- Publish or identify a small preprod fixture set:
  - one public survey accepting DReps and ending far enough in the future for testing;
  - one sealed survey for reveal/cost measurement;
  - content anchors with stable, hash-verifiable bytes where enrichment is needed.
- Record survey references, owner/eligible roles, expected decoded questions, submission mode, end epoch, and Tessera backend commit in a versioned interoperability document or fixture file.
- Confirm exact-reference bundle and artifact routes expose every value the response widget and a compact DRepTalk result summary need.
- Provide the pinned published package versions and minimal host contract:
  - decoded/enriched definition and survey reference into the widget;
  - connected key-DRep responder map;
  - emitted metadatum attached exactly once at label 17;
  - DRepTalk attribution retained separately at label 674;
  - required signer/proof supplied by DRepTalk's transaction builder.
- Support a DRepTalk temporary route through the following tests:
  1. read the fixture by exact reference;
  2. render all fixture questions through `<tessera-respond>`;
  3. submit an independent key-DRep response;
  4. poll confirmation;
  5. observe a decided positive proof verdict and counted response in Tessera;
  6. submit a valid replacement and observe latest-valid-response-wins;
  7. verify DRepTalk and Tessera decode the same role, credential, reference, and answers.
- Exercise sealed submission and reveal separately for backend behavior and CPU measurement; it need not be part of DRepTalk's first UI proof.
- Add any discovered cross-project vectors as package/backend tests. Fix the protocol boundary rather than adding host-specific exceptions.

Validation:

- the response metadatum round-trips without mutation through the published codec;
- labels 17 and 674 coexist;
- Tessera proof validation recognizes the DRep required signer;
- the invalid-later-response case does not suppress an earlier valid response;
- public and sealed fixture states are distinguishable without DRepTalk reimplementing Tessera rules;
- no combined governance vote is required for spike completion.

Commit boundary: Tessera's side of the interoperability contract is fixed and independently reproducible. The on-chain transaction references are recorded in Progress.

### Increment 5 — Workload study and DRepTalk handoff

**Goal:** answer whether DRepTalk can operate Tessera with a modest, predictable footprint and leave a bounded next decision.

Measure these scenarios with the same reporting window/schema where possible:

1. steady-state refresh with no new label-17 records;
2. ingestion and proof validation of new public responses;
3. repeated HTTP reads of list, exact-reference bundle, artifact, tip, protocol parameters, and transaction status;
4. public survey finalization with DRep weights;
5. sealed reveal, including per-response CPU and multi-pass pacing;
6. synthetic retained corpora at approximately 100, 1,000, and 10,000 response rows to establish query, storage, and serving curves without manufacturing chain spam;
7. a transient Koios or anchor failure to confirm soft failure and recovery costs.

For each scenario report:

- workload and corpus size;
- refresh cadence and measurement duration;
- Koios/operator/passthrough/anchor calls;
- Worker CPU and wall-time percentiles and resource-exceeded count;
- D1 rows read/written, query counts/latency, and physical storage;
- logical payload size and API response size;
- whether cost is constant, proportional to new records, per-survey participation, or retained history;
- observed limit/headroom and the first likely scaling boundary;
- projected monthly included usage or charges, with Cloudflare plan assumptions stated explicitly.

Do not declare the footprint acceptable using an arbitrary Tessera-only threshold. Present the evidence to DRepTalk's maintainer and record one of:

- DRepTalk is comfortable operating one instance per network;
- another bounded Tessera optimization is required, with a named trigger and follow-up plan;
- Tessera remains externally operated for the first integration phase.

Finish by:

- updating `plans/2026-08-02-cip-179-dreptalk-integration.md` so its summary, decisions, sequencing, and operational findings no longer recommend an action-centric survey home;
- documenting the stable API/package/deployment contract and known limits;
- removing temporary fixtures/scripts that are not useful for regression or operations;
- listing what the work made obsolete and confirming it was deleted;
- committing the final report and handoff.

Commit boundary: the spike is complete and the next DRepTalk increment can be planned from measured facts.

## Test matrix

The minimum matrix across the increments is:

| Area | Preview | Preprod | Mainnet |
|---|---:|---:|---:|
| Strict config parsing | yes | yes | yes |
| Koios URL and epoch duration | yes | yes | yes |
| Backend `/health` identity | yes | yes | yes |
| Evolution transaction chain selection | yes | yes | yes |
| Verifier backend-network validation | yes | yes | yes |
| Cross-network backend rejection | yes | yes | yes |
| Snapshot reconciliation adapter contract | runtime-neutral | runtime-neutral | runtime-neutral |
| Cloudflare deployment exercised | existing | required | not required |
| On-chain response fixture | existing | required | not required |

Preprod and Preview both report CIP-30 network id `0`. Tests and user-facing documentation must not claim that `getNetworkId()` distinguishes them. Exact backend identity, deployment configuration, Koios URL, and transaction submission target provide the service-level separation; wallet testnet selection needs an explicit supported check or an honest limitation rather than a false guarantee.

## Operational evidence sources

Use authoritative Cloudflare metrics rather than inferred counters:

- Workers metrics and GraphQL Analytics for request outcomes, CPU time, and wall time;
- D1 `d1AnalyticsAdaptiveGroups`, `d1QueriesAdaptiveGroups`, and `d1StorageAdaptiveGroups` for rows, queries, latency, and storage;
- `wrangler d1 info --json` for current database size/state;
- Tessera `/api/health` for protocol-service freshness, refresh outcomes, upstream calls, corpus size, and validation backlog;
- Koios account telemetry when available for quota confirmation.

Store generated benchmark reports without secrets. Raw provider exports may remain local if they contain account identifiers; commit the normalized figures and the command/query that produced them.

## Coordination notes for DRepTalk

The spike should give DRepTalk a small contract, not a second protocol implementation:

- DRepTalk identifies a survey by `{txId, index}` and owns its admitted topic.
- DRepTalk persists why a survey was admitted and the evidence for that gate; protocol validity alone does not imply forum admission.
- A governance action linking a survey is a relation, not an owner endorsement.
- DRepTalk fetches/caches admitted survey state from Tessera by exact reference and fails the feature soft when Tessera is unavailable.
- The response widget owns answer drafting, validation, and sealing.
- DRepTalk owns wallet identity, transaction construction, signing, submission, confirmation UX, discussion, and presentation.
- The first transaction is response-only. Combined vote-and-response remains deferred until both independent flows have production evidence.
