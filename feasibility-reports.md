# Feasibility reports: health footer & proposals pagination

Date: 2026-07-05 · Scope: analysis only, no code changed. Breaking changes are acceptable (pre-release).

---

# 1. Health metrics thin footer (Koios usage & operational headroom)

## Verdict

**Feasible with low effort, and a useful slice of it is free.** The snapshot age already reaches the browser unused, and the backend already counts Koios subrequests per cron run — it just logs the number instead of persisting or exposing it. The work is mostly plumbing: persist last-run stats, expose them on an endpoint, render a thin footer.

## Current state

- **The one existing operational counter** lives in `backend/server/src/worker.ts:56-77` (`countedRefresh`): it monkey-patches `globalThis.fetch` around a cron refresh, counts subrequests, and logs `cron refresh ok: N Koios subrequests`. It only covers the Worker cron path — the Node dev loop (`refresh.ts:89-102` / `startRefreshLoop`) is uninstrumented.
- **Freshness data already ships to the frontend unused**: `GET /api/surveys` includes `fetchedAt` and `ageSeconds` (`http.ts:177-178`), but `state.tsx:242-254` drops them (only `tip`, `surveys`, `incomplete` are kept). A "snapshot age" indicator needs zero backend change.
- **`GET /health` exists but is minimal** (`http.ts:143`): `{ ok, network }`, used only for network-match verification.
- **No metrics persistence**: no meta/KV table, no Analytics Engine binding, no timing measurement anywhere. Storage is the `BackendStore` seam (`store.ts:163`) with three impls (D1 / node:sqlite / mem) and migrations as the shared schema source.
- **No rate-limit handling in the Koios clients**: both funnels (`packages/koios/src/koios.ts:179-197` and `tallyInputs.ts:89-107`) throw on non-OK; there is no 429/backoff logic and no tier-limit constants anywhere in the repo. "Retry" is structural: failed batches mark the snapshot `incomplete` and get re-attempted on the next refresh.

### Cost model of one wake-up (what the footer would surface)

Refresh runs every 3 min (Worker cron `*/3 * * * *` in `wrangler.toml`; Node default `REFRESH_SECONDS = 180`, `config.ts:49`). Per refresh:

| Component | Koios calls | Steady state |
|---|---|---|
| Baseline (`/tip` ×2, `/epoch_params`, `/proposal_list`) | ~4 GETs | constant |
| Survey scan `/tx_by_metalabel` | ceil(rows/100) pages, cap 50 pages | grows with total label-17 txs |
| `/tx_metadata` (batch 50) | per *new* tx only (cached in `tx_metadata_cache`) | ≈ 0 |
| `/tx_cbor` cancellations (batch 25) | per open-survey cancellation | usually 0 |
| Response validation `/tx_info` + `/tx_cbor` | per *new* response batch | ≈ 0 |
| Finalization (`tallyInputs.ts`) | 2 POSTs per 50 stakeholders + **1 GET per DRep credential** + 2 totals calls | 0 except when a survey closes |

Key insight: **usage is spiky, not steady.** The steady-state refresh converges to a handful of calls; the worst case is at epoch boundaries when surveys finalize (per-DRep GETs dominate, `tallyInputs.ts:217-219`). The relevant limits are:

1. **Cloudflare Worker subrequest cap per invocation** — 50 on the free plan, 1000 paid (already noted at `worker.ts:50-54`). This is the *hard* ceiling a single cron run can hit.
2. **Koios tier quota** (daily/rate limits of the anonymous vs token tier — `KOIOS_TOKEN` optional, `config.ts:42`). Not encoded in the repo; should be a config value, not hardcoded.
3. **Snapshot blob size** — the whole survey list is one JSON TEXT row (`snapshot_cache`, migration `0001`); it grows with every survey and is the first thing to collide with D1 statement/row size limits. Cheap to measure (`payload.length`) at `store.put` time.

## Recommended metric set

**Footer (at-a-glance, 4–5 items max):**
- Snapshot age (`ageSeconds`, already shipped) — with a stale threshold (> 2× refresh interval → warning color).
- Koios subrequests last refresh / per-invocation cap (e.g. `37/50`) — the "close to limits" number the request asks for.
- Last refresh outcome: ok / failed / `incomplete` (partial scan).
- Validation backlog: count of never-completed validations (`validate.ts` NULL-row retries) — nonzero persistently means something is wedged.

**Behind a tap/expand or `/api/health` only (not in the footer):**
- Last refresh duration; rolling 24 h Koios call total (vs configured tier quota); snapshot payload bytes; per-refresh breakdown (scan / validate / finalize); consecutive-failure count; surveys/responses totals.

## Implementation direction

**Phase 0 — free win (frontend only).** Surface `ageSeconds`/`fetchedAt` + `incomplete` in a thin footer. Stop dropping them in `state.tsx:242-254`. No backend change.

**Phase 1 — instrument and persist.**
1. Replace the fetch monkey-patch with a hook on the two client funnels: give `KoiosDataSource` and `KoiosTallyInputs` an optional `onRequest(path)` callback (or injected counting `fetch`) in their `get`/`post` wrappers. This counts *exactly* Koios calls, works identically on Node and Worker, and avoids the monkey-patch's flaw that concurrent live HTTP traffic (`/api/tip`, `/api/tx_status` Koios pass-throughs) during a refresh window pollutes the count.
2. In `refreshSnapshot` (`refresh.ts:18-83`), capture start/end timestamps, per-stage call counts, and outcome.
3. Persist to a new migration `0006_refresh_stats.sql`. Recommended: a small append table `refresh_run(started_at, duration_ms, koios_calls, ok, incomplete, payload_bytes, ...)` pruned to ~7 days, rather than a single-row table — an append table gives you the rolling 24 h quota total and a history/sparkline for near-free, and the pruning `DELETE` is trivial. Extend `BackendStore` + the three impls (the D1 upsert at `store-d1.ts:58-68` is the pattern template).

**Phase 2 — expose and render.**
- Endpoint: two viable shapes. (a) Piggyback a `health` object onto the `/api/surveys` payload — zero extra round trip, refreshes with the list, and the ETag story (`W/"surveys-{fetchedAt}"`) is unchanged. (b) A dedicated `GET /api/health` — cleaner separation, footer can poll independently of the heavy list. **Recommendation: (a) for the footer's needs**; add (b) later only if you want external monitoring/uptime checks against it. Either way keep the existing `/health` untouched (the frontend uses it for network verification, `indexer.ts:124-144`).
- Frontend: a `HealthFooter` component. Natural home: `App.tsx:15-29` next to `<BottomNav />` (the only existing persistent chrome) so it appears app-wide, or at the bottom of `Explore.tsx` under `<Legend />` if you want it explore-only. Given "home explore view" in the request, start under the Legend; promoting it to App-level later is a one-line move.
- Note a mode caveat: when the frontend runs in direct-`KoiosDataSource` mode (no `VITE_INDEXER_URL`), there is no backend and no refresh — the footer should degrade to showing nothing or only client-side info.

**Config additions:** `KOIOS_DAILY_LIMIT` (or per-tier map) and `SUBREQUEST_CAP` as env vars with sensible defaults, so thresholds aren't hardcoded.

## Risks / open questions

- **Threshold coloring needs real limit numbers.** Koios tier quotas aren't in the repo; confirm the actual anonymous/free-tier numbers before painting anything red.
- **Worker isolate lifetime:** an in-memory-only counter would vanish between cron invocations on Workers — persistence (Phase 1.3) is required, not optional, for the Worker deployment.
- **Effort:** Phase 0 ~1 h; Phases 1–2 roughly 1–2 days including tests across the three store impls.

---

# 2. Pagination of the proposals (Explore) table

## Verdict

**Feasible, but it is a data-model change, not a UI tweak.** Surveys are not rows anywhere — the entire list is one JSON blob in a single-row table (`snapshot_cache`, id=1), served whole by `GET /api/surveys` and filtered/sectioned entirely client-side. Real pagination means materializing per-survey rows during refresh and redesigning the list payload into a lightweight summary. The codebase anticipates exactly this: the header comment at `http.ts:28-34` flags per-survey tables/indexes as the planned evolution once the blob shows up in a profile. Since breaking changes are fine, go straight to the row model rather than layering cursors over the blob.

## Current state

- **Frontend** (SolidJS): `Explore.tsx` holds the full list in one `createResource` (`state.tsx:242-254`), then does everything in memory — filter chips via `.filter()` over all surveys (`Explore.tsx:61-81`), debounced text search over per-survey haystacks (`Explore.tsx:100-107, 206-211`), chip counts over the full set (`Explore.tsx:214-226`), and *sectioning* (gov-linked / open / closed, `Explore.tsx:236-242`) rather than sorting — row order is whatever the backend sent.
- **Backend**: `GET /api/surveys` (`http.ts:147-181`) decodes the whole snapshot blob and returns every `SurveyRecord` (full `SurveyDefinition` each — title, description, all questions and option labels; hundreds of bytes to several KB per survey), plus all cancellations, govLinks, tip, `responseCounts`, `finalizedCancelled`. No `limit`/`offset`/`cursor` anywhere in the API surface (`source.ts:229-262`).
- **Storage**: `SnapshotStore` is just `get()`/`put()` of the whole blob (`store.ts:20-24`). No survey table, no indexes on survey attributes, in any of the three store impls.
- **Ordering today** is implicit: Koios scan order `absolute_slot.desc` (`koios.ts:279`), newest first, capped at 50 pages × 100 rows (source of the `incomplete` flag).
- **Status** (`active`/`ended`/`cancelled`, `survey.ts:30,61-69`) is derived **client-side** from `tip.epoch` vs each survey's `endEpoch` — it is not stored anywhere, so status-based server ordering/filtering doesn't exist yet.
- **No integrity constraint blocks this**: the list payload carries no signature (only tally artifacts are hash-addressed/immutable), so restructuring it breaks nothing cryptographic.

## Recommended target design

### Data model: materialize a `survey` summary table during refresh

Refresh already decodes everything (`refresh.ts:18-83`); add a step that upserts one row per survey into a new table (migration `0006_survey_index.sql` or similar):

```
survey(
  survey_key TEXT PRIMARY KEY,      -- txHash#index
  tx_hash TEXT, tx_index INTEGER,
  slot INTEGER, epoch_no INTEGER,   -- creation position (keyset sort key)
  end_epoch INTEGER,
  cancelled INTEGER,                -- verified cancellation flag
  gov_linked INTEGER,               -- has verified gov link
  sealed INTEGER,                   -- commit-reveal vs public
  title TEXT,
  response_count INTEGER,           -- deduped, denormalized at refresh
  summary_json TEXT                 -- the per-row payload the list needs
)
+ INDEX on (end_epoch), (slot DESC)
```

Two deliberate choices baked in:

1. **Serve summaries, not full definitions.** The list view uses only a fraction of `SurveyRecord` (title, ref, status inputs, flags, counts); the detail page already fetches the full bundle per survey (`GET /api/surveys/:txHash/:index`). Shrinking list items to a summary row solves the payload-growth problem *and* makes rows cheap enough that pages of 50 are trivial. This is the main breaking change to `SurveyListPayload` — acceptable per the brief.
2. **Store status *inputs*, compute status at query time.** Don't store a `status` column that goes stale when the epoch ticks; store `end_epoch` + `cancelled` and compute the active/ended split in SQL against the current tip epoch (known from the snapshot): `CASE WHEN cancelled THEN 2 WHEN end_epoch < :tipEpoch THEN 1 ELSE 0 END`. This keeps rows immutable-ish and correct without an epoch-boundary re-write job.

### API: keyset pagination, filter server-side

`GET /api/surveys?filter=<all|linked|active|sealed|public>&cursor=<slot:ref>&limit=50`

- **Keyset, not OFFSET**: cursor = `(slot, survey_key)` of the last row, ordered `slot DESC, survey_key` — stable under inserts (new surveys land on page 1), and the natural continuation of today's implicit ordering. `SurveyRecord` already carries both keys.
- Response: `{ rows: SurveySummary[], nextCursor, counts: {all, linked, active, sealed, public}, tip, fetchedAt, ageSeconds, incomplete }`. The chip counts become five cheap indexed `COUNT` queries (or one grouped query) so the chips stay globally accurate even though only one page is loaded.
- **ETag** stays `W/"surveys-{fetchedAt}"` — caches key by full URL, so every (filter, cursor) combination revalidates independently with the same tag value. No change to the 304 model (`http.ts:102-106`).
- Keep `cancellations`/`govLinks` out of the list response entirely — fold their effects into row flags at refresh time (denormalization), and let the detail bundle carry the raw records as it already does.

### The awkward filters: `mine` / responded, and text search

- **`mine`/`responded` are wallet-derived client-side** (`Explore.tsx:165-188`) — the server doesn't know the wallet. Two workable options: (a) the existing `GET /api/responded` route already answers "which survey keys has this credential responded to" — for the `mine` chip, fetch that key list and request those rows by key (`?keys=...`), skipping pagination for what is inherently a small personal set; (b) keep `mine` client-side over responded-key lookups. Either avoids leaking wallet identity into generic list queries beyond what `/api/responded` already does.
- **Text search** currently greps client-built haystacks of the *full* definitions. Under pagination, either (a) move it server-side as `?q=` with `LIKE` over a haystack column built at refresh (add `haystack TEXT` to the row; FTS5 is available on node:sqlite but not reliably on D1, so plain `LIKE` is the portable choice), or (b) defer: leave search fetching a larger window. Recommendation: build the haystack column now (refresh already has all the text in hand), wire `?q=` — it is a few lines of SQL once rows exist.

### Frontend changes

- `DataSource.surveyList()` (`source.ts:229`) becomes `surveyPage(params)`; `IndexerDataSource` passes query params through. The Solid resource in `state.tsx` keys on `(filter, cursor, q)`; Explore's `matchesFilter`/`counts`/haystack code is deleted in favor of server values.
- **Sectioning → sorting**: the gov/open/closed section split (`Explore.tsx:236-242`) assumes the full set. Under pagination, either make sections filter tabs (each paginated independently — simplest and arguably better UX at scale), or order pages as `status-bucket, slot DESC` so sections emerge naturally within the stream. Recommendation: fold sections into the existing chip-filter mechanism.
- **Optimistic creates** (`state.tsx:283-357`): still works — optimistic rows prepend to page 1 (newest-first ordering guarantees the confirmed row will appear on page 1) and are pruned on match, same as today. Reconciliation only needs to check the loaded window.
- UI: "load more" button or infinite scroll appended to the existing `<For>` rows; the fixed 6-row skeleton (`Explore.tsx:737`) becomes the page-fetch skeleton.

## What pagination does *not* fix (note for the report)

The upstream Koios scan itself is capped at 5,000 label-17 txs per refresh (`MAX_PAGES` × `PAGE_SIZE`, `koios.ts:58,65`) — the origin of `incomplete`. At the scale where table pagination matters, incremental scanning (persist the scan high-water slot, only fetch new txs) becomes the companion piece; the `tx_metadata_cache` table already does half of this. Worth scheduling together, not blocking on it.

## Phasing & effort

| Phase | Work | Effort |
|---|---|---|
| 1 (optional stopgap) | Client-side windowing in Explore (`slice` + "show more", pattern already exists on the Survey detail page at `Survey.tsx:1077-1079`) | ~1–2 h |
| 2 (core) | `survey` table migration + refresh upsert + paged `/api/surveys` with filters/counts + frontend resource rework | ~3–4 days incl. tests across 3 store impls |
| 3 | Server-side `?q=` search over haystack column; `mine` via `/api/responded` keys | ~0.5–1 day |

Phase 1 is worth doing immediately regardless: it removes any near-term rendering concern for free and buys time to do Phase 2 properly.

## Risks / open questions

- **Page size & UX choice** (load-more vs infinite scroll vs numbered pages) — product call, cheap to change later.
- **Chip-count queries per request**: five COUNTs per page load is fine at D1 scale here, but they can be folded into one grouped query if it ever matters.
- **Dual-store parity**: every schema/queries change lands in D1, node:sqlite, and mem impls; the migration files are shared, but query code is triplicated — the main source of implementation friction and where tests should focus.

---

## Shared observation

Both features converge on the same underlying move: **refresh-time materialization into D1 rows** (metrics rows for the footer, summary rows for pagination) instead of everything living in the single snapshot blob. If both are built, do the footer's `refresh_run` table and the pagination `survey` table in the same migration wave — the `BackendStore` interface extension and triple-impl work overlaps substantially.
