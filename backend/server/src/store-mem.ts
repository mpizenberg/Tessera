/**
 * In-memory {@link BackendStore} for unit tests (route tests, validation and
 * finalization tests) — no SQLite, no D1. Same latest-wins/insert-or-ignore
 * semantics as the real stores. Not part of any runtime wiring.
 */

import type { SurveyListFilter } from "cardano-tessera-core";
import type { Role } from "cip-179";
import { BINDABLE_ROLES, type GovLink, type GovLinkDoc } from "cip-179/domain";

import type {
  ArtifactRow,
  BackendStore,
  CancellationRow,
  RefreshRunRow,
  ResponseRow,
  ScanState,
  SealedRevealRow,
  SettledGovEpoch,
  SnapshotMeta,
  SurveyIndexRow,
  UpstreamKind,
  ValidatedLinkCursor,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import {
  OPERATIONAL_RETENTION_SECONDS,
  tallyBucket,
  UPSTREAM_KINDS,
  upstreamTotalsFrom,
  validationKey,
} from "./store";

export interface MemBackendStore extends BackendStore {
  /** Direct row access for assertions. */
  readonly validated: Map<string, ValidatedResponseRow>;
  /** Reveal outcomes by {@link validationKey}; null = undecryptable. */
  readonly reveals: Map<string, string | null>;
  readonly weights: Map<string, WeightRow>;
  readonly totals: Map<string, { total: string; endpoint: string }>;
  readonly artifacts: Map<string, ArtifactRow>;
  readonly txMetadata: Map<string, unknown>;
  /** Banked anchor classifications by hash; null = verified non-link. */
  readonly govAnchors: Map<string, GovLinkDoc | null>;
  readonly govEpochs: Map<number, SettledGovEpoch>;
  readonly refreshRuns: Map<number, RefreshRunRow>;
  surveyIndex: readonly SurveyIndexRow[];
}

export function memBackendStore(): MemBackendStore {
  const validated = new Map<string, ValidatedResponseRow>();
  const reveals = new Map<string, string | null>();
  const weights = new Map<string, WeightRow>();
  const totals = new Map<string, { total: string; endpoint: string }>();
  const artifacts = new Map<string, ArtifactRow>();
  const txMetadata = new Map<string, unknown>();
  const txProofCbor = new Map<string, string>();
  const govAnchors = new Map<string, GovLinkDoc | null>();
  const govEpochs = new Map<number, SettledGovEpoch>();
  const refreshRuns = new Map<number, RefreshRunRow>();
  let upstreamTally: { bucket: number; kind: UpstreamKind; calls: number }[] =
    [];
  let lease: { holder: string; expiresAt: number } | null = null;
  let surveyIndexRows: readonly SurveyIndexRow[] = [];
  let responseRows: readonly ResponseRow[] = [];
  let cancellationRows: readonly CancellationRow[] = [];
  let meta: SnapshotMeta | null = null;
  let scanStateRow: ScanState | null = null;
  // Rides the scan-state row, as in SQL: no row banked yet, no floor to bank.
  let settlementFloorValue = 0;

  // Same semantics as the SQL in snapshotSql.ts (and core's pageSurveyList).
  const bucketOf = (r: SurveyIndexRow, tipEpoch: number): number =>
    r.govLinked ? 0 : r.cancelled || r.endEpoch < tipEpoch ? 2 : 1;
  const matchesTerms = (r: SurveyIndexRow, terms: readonly string[]) =>
    terms.every((t) => r.haystack.includes(t));
  const matchesFilter = (
    r: SurveyIndexRow,
    filter: SurveyListFilter,
    tipEpoch: number,
    credentials: ReadonlySet<string>,
  ): boolean => {
    const active = !r.cancelled && r.endEpoch >= tipEpoch;
    switch (filter) {
      case "all":
        return true;
      case "linked":
        return r.govLinked;
      case "active":
        return active;
      case "sealed":
        return r.sealed && active;
      case "public":
        return !r.sealed && active;
      case "mine":
        return credentials.has(r.owner);
    }
  };

  const weightKey = (epoch: number, role: number, credential: string) =>
    `${epoch}|${role}|${credential}`;

  const bySurveyKey = (a: SurveyIndexRow, b: SurveyIndexRow) =>
    a.surveyKey < b.surveyKey ? -1 : a.surveyKey > b.surveyKey ? 1 : 0;

  return {
    validated,
    reveals,
    weights,
    totals,
    artifacts,
    txMetadata,
    govAnchors,
    govEpochs,
    refreshRuns,
    get surveyIndex() {
      return surveyIndexRows;
    },

    async completedValidationsForSurveys(surveyKeys) {
      const wanted = new Set(surveyKeys);
      return new Map(
        [...validated.values()]
          .filter(
            (r) =>
              wanted.has(r.surveyKey) &&
              r.blockIndex !== null &&
              r.proofOk !== null,
          )
          .map((r) => [
            validationKey(r.txHash, r.responseIndex),
            {
              linkedActionId: r.linkedActionId,
              slot: r.slot,
              epochNo: r.epochNo,
            },
          ]),
      );
    },
    async validatedLinkCursors() {
      const out = new Map<string, ValidatedLinkCursor>();
      for (const r of validated.values()) {
        if (r.blockIndex === null || r.proofOk === null) continue;
        if (!BINDABLE_ROLES.has(r.role as Role)) continue;
        out.set(JSON.stringify([r.surveyKey, r.linkedActionId]), {
          surveyKey: r.surveyKey,
          linkedActionId: r.linkedActionId,
        });
      }
      return [...out.values()];
    },
    async incompleteValidationSurveys() {
      return [
        ...new Set(
          [...validated.values()]
            .filter((r) => r.blockIndex === null || r.proofOk === null)
            .map((r) => r.surveyKey),
        ),
      ];
    },
    async upsertValidatedResponses(rows) {
      for (const r of rows)
        validated.set(validationKey(r.txHash, r.responseIndex), r);
    },
    async validatedForSurvey(surveyKey) {
      return [...validated.values()].filter((r) => r.surveyKey === surveyKey);
    },
    async deleteValidatedResponses(keys) {
      for (const k of keys) {
        validated.delete(validationKey(k.txHash, k.responseIndex));
        reveals.delete(validationKey(k.txHash, k.responseIndex));
      }
    },
    async sealedReveals(surveyKey) {
      const out = new Map<string, string | null>();
      for (const r of validated.values()) {
        if (r.surveyKey !== surveyKey) continue;
        const key = validationKey(r.txHash, r.responseIndex);
        if (reveals.has(key)) out.set(key, reveals.get(key)!);
      }
      return out;
    },
    async putSealedReveals(rows: readonly SealedRevealRow[]) {
      for (const r of rows) {
        const key = validationKey(r.txHash, r.responseIndex);
        if (!reveals.has(key)) reveals.set(key, r.response);
      }
    },

    async weightRows(epoch, role) {
      return [...weights.values()].filter(
        (r) => r.epoch === epoch && r.role === role,
      );
    },
    async insertWeightRows(rows) {
      for (const r of rows) {
        const key = weightKey(r.epoch, r.role, r.credential);
        if (!weights.has(key)) weights.set(key, r);
      }
    },
    async epochTotal(epoch, role) {
      return totals.get(`${epoch}|${role}`)?.total ?? null;
    },
    async putEpochTotal(epoch, role, total, endpoint) {
      totals.set(`${epoch}|${role}`, { total, endpoint });
    },

    async artifactBySurvey(surveyKey) {
      return artifacts.get(surveyKey) ?? null;
    },
    async artifactByHash(artifactHash) {
      return (
        [...artifacts.values()].find((a) => a.artifactHash === artifactHash) ??
        null
      );
    },
    async putArtifact(row) {
      if (!artifacts.has(row.surveyKey)) artifacts.set(row.surveyKey, row);
    },
    async finalizedArtifactKeys() {
      return {
        finalized: new Set(artifacts.keys()),
        cancelled: new Set(
          [...artifacts.values()]
            .filter((a) => {
              const body = JSON.parse(a.artifact) as {
                tally?: { cancelled?: unknown };
              };
              return body.tally?.cancelled != null;
            })
            .map((a) => a.surveyKey),
        ),
      };
    },

    async cachedTxMetadata(txHashes) {
      const out = new Map<string, unknown>();
      for (const h of txHashes)
        if (txMetadata.has(h)) out.set(h, txMetadata.get(h));
      return out;
    },
    async putTxMetadata(entries) {
      for (const [h, m] of entries)
        if (!txMetadata.has(h)) txMetadata.set(h, m);
    },

    async cachedTxProofCbor(txHashes) {
      const out = new Map<string, string>();
      for (const h of txHashes) {
        const cbor = txProofCbor.get(h);
        if (cbor !== undefined) out.set(h, cbor);
      }
      return out;
    },
    async putTxProofCbor(entries) {
      for (const [h, cbor] of entries)
        if (!txProofCbor.has(h)) txProofCbor.set(h, cbor);
    },
    async cachedTxProofHashes() {
      return [...txProofCbor.keys()];
    },
    async deleteTxProofCbor(txHashes) {
      for (const h of txHashes) txProofCbor.delete(h);
    },

    async cachedGovAnchors(hashes) {
      const out = new Map<string, GovLinkDoc | null>();
      for (const h of hashes)
        if (govAnchors.has(h)) out.set(h, govAnchors.get(h)!);
      return out;
    },
    async putGovAnchors(entries) {
      for (const [h, link] of entries)
        if (!govAnchors.has(h)) govAnchors.set(h, link);
    },
    async deleteGovAnchors(hashes) {
      for (const h of hashes) govAnchors.delete(h);
    },
    async settledGovEpochs(expirations) {
      const out = new Map<number, SettledGovEpoch>();
      for (const e of expirations)
        if (govEpochs.has(e)) out.set(e, govEpochs.get(e)!);
      return out;
    },
    async putSettledGovEpoch(row) {
      if (!govEpochs.has(row.expiration)) govEpochs.set(row.expiration, row);
    },
    async settlementFloor() {
      return settlementFloorValue;
    },
    async putSettlementFloor(expiration) {
      if (scanStateRow !== null) settlementFloorValue = expiration;
    },

    async reconcileSnapshot(surveys, responses, cancellations, envelope) {
      surveyIndexRows = [...surveys];
      responseRows = [...responses];
      cancellationRows = [...cancellations];
      meta = envelope;
    },
    async publishSnapshotMeta(envelope) {
      meta = envelope;
    },
    async snapshotMeta() {
      return meta;
    },
    async surveyGovLinks(minEndEpoch) {
      return new Map(
        surveyIndexRows
          .filter((r) => r.endEpoch >= minEndEpoch && r.govLinks !== "[]")
          .map((r) => [r.surveyKey, JSON.parse(r.govLinks) as GovLink[]]),
      );
    },
    async surveyBundle(surveyKey) {
      const survey = surveyIndexRows.find((r) => r.surveyKey === surveyKey);
      if (!survey) return null;
      return {
        record: survey.record,
        cancellations: survey.cancellations,
        responses: responseRows
          .filter((r) => r.surveyKey === surveyKey)
          .sort(
            (a, b) =>
              a.slot - b.slot ||
              (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) ||
              a.responseIndex - b.responseIndex,
          )
          .map((r) => r.record),
      };
    },
    async respondedSurveyKeys(credentials) {
      const wanted = new Set(credentials);
      return [
        ...new Set(
          responseRows
            .filter((r) => wanted.has(r.credential))
            .map((r) => r.surveyKey),
        ),
      ];
    },
    async surveyIndexPage(q) {
      const credentials = new Set(q.credentials);
      return surveyIndexRows
        .filter(
          (r) =>
            matchesTerms(r, q.searchTerms) &&
            matchesFilter(r, q.filter, q.tipEpoch, credentials),
        )
        .map((r) => ({ ...r, bucket: bucketOf(r, q.tipEpoch) }))
        .sort(
          (x, y) =>
            x.bucket - y.bucket ||
            y.slot - x.slot ||
            (x.surveyKey < y.surveyKey
              ? -1
              : x.surveyKey > y.surveyKey
                ? 1
                : 0),
        )
        .filter((r) => {
          const c = q.cursor;
          if (!c) return true;
          if (r.bucket !== c.bucket) return r.bucket > c.bucket;
          if (r.slot !== c.slot) return r.slot < c.slot;
          return r.surveyKey > c.key;
        })
        .slice(0, q.limit);
    },
    async surveyIndexCounts(tipEpoch, credentials, searchTerms) {
      const creds = new Set(credentials);
      const rows = surveyIndexRows.filter((r) => matchesTerms(r, searchTerms));
      const by = (f: SurveyListFilter) =>
        rows.filter((r) => matchesFilter(r, f, tipEpoch, creds)).length;
      return {
        all: rows.length,
        linked: by("linked"),
        active: by("active"),
        sealed: by("sealed"),
        public: by("public"),
        mine: by("mine"),
      };
    },
    async ownedSurveyCount(credentials) {
      const wanted = new Set(credentials);
      return surveyIndexRows.filter((r) => wanted.has(r.owner)).length;
    },
    async scanState() {
      return scanStateRow;
    },
    async putScanState(state) {
      scanStateRow = state;
    },
    async reconcileSegment(range, surveys, responses, cancellations, envelope) {
      // Same upsert/sweep semantics as the SQL program, with the same changed-
      // row count: replaced-but-identical rows are not changes.
      const rowText = (row: object) =>
        JSON.stringify(Object.entries(row).sort());
      const inRange = (slot: number) =>
        range !== null && slot >= range.fromSlot && slot <= range.toSlot;
      let changes = 0;
      const merge = <T extends { readonly slot: number }>(
        stored: readonly T[],
        given: readonly T[],
        keyOf: (row: T) => string,
      ): T[] => {
        const byKey = new Map(stored.map((r) => [keyOf(r), r]));
        for (const r of given) {
          const prev = byKey.get(keyOf(r));
          if (prev === undefined || rowText(prev) !== rowText(r)) changes++;
          byKey.set(keyOf(r), r);
        }
        const givenKeys = new Set(given.map(keyOf));
        return [...byKey.values()].filter((r) => {
          const swept = inRange(r.slot) && !givenKeys.has(keyOf(r));
          if (swept) changes++;
          return !swept;
        });
      };
      surveyIndexRows = merge(
        surveyIndexRows,
        [...surveys],
        (r) => r.surveyKey,
      );
      responseRows = merge(responseRows, [...responses], (r) =>
        validationKey(r.txHash, r.responseIndex),
      );
      cancellationRows = merge(
        cancellationRows,
        [...cancellations],
        (r) => `${r.txHash}|${r.surveyKey}`,
      );
      meta = envelope;
      return changes;
    },
    async surveyRowsByKeys(keys) {
      const wanted = new Set(keys);
      return surveyIndexRows
        .filter((r) => wanted.has(r.surveyKey))
        .sort(bySurveyKey);
    },
    async responseRowsForSurveys(surveyKeys) {
      const wanted = new Set(surveyKeys);
      return responseRows
        .filter((r) => wanted.has(r.surveyKey))
        .sort(
          (a, b) =>
            (a.surveyKey < b.surveyKey
              ? -1
              : a.surveyKey > b.surveyKey
                ? 1
                : 0) ||
            a.slot - b.slot ||
            (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) ||
            a.responseIndex - b.responseIndex,
        );
    },
    async responseRowsInSlotRange(range) {
      return responseRows
        .filter((r) => r.slot >= range.fromSlot && r.slot <= range.toSlot)
        .sort(
          (a, b) =>
            a.slot - b.slot ||
            (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) ||
            a.responseIndex - b.responseIndex,
        );
    },
    async cancellationRowsForSurveys(surveyKeys) {
      const wanted = new Set(surveyKeys);
      return cancellationRows
        .filter((r) => wanted.has(r.surveyKey))
        .sort(
          (a, b) =>
            (a.surveyKey < b.surveyKey
              ? -1
              : a.surveyKey > b.surveyKey
                ? 1
                : 0) ||
            a.slot - b.slot ||
            (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0),
        );
    },
    async cancellationRowsInSlotRange(range) {
      return cancellationRows
        .filter((r) => r.slot >= range.fromSlot && r.slot <= range.toSlot)
        .sort(
          (a, b) =>
            a.slot - b.slot ||
            (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0),
        );
    },
    async staleCancelledSurveyKeys(tipEpoch) {
      return surveyIndexRows
        .filter(
          (r) => r.cancelled && !r.finalizedCancelled && r.endEpoch < tipEpoch,
        )
        .map((r) => r.surveyKey);
    },
    async markFinalizedCancelled(surveyKeys) {
      const wanted = new Set(surveyKeys);
      let changes = 0;
      surveyIndexRows = surveyIndexRows.map((r) => {
        if (!wanted.has(r.surveyKey) || r.finalizedCancelled) return r;
        changes++;
        return { ...r, finalizedCancelled: true, cancelled: true };
      });
      return changes;
    },
    async surveyEndEpochs(minEndEpoch) {
      return [
        ...new Set(
          surveyIndexRows
            .filter((r) => r.endEpoch >= minEndEpoch)
            .map((r) => r.endEpoch),
        ),
      ].sort((a, b) => a - b);
    },
    async unfinalizedClosedSurveyRows(tipEpoch) {
      return surveyIndexRows
        .filter((r) => r.endEpoch < tipEpoch && !artifacts.has(r.surveyKey))
        .sort(bySurveyKey);
    },
    async surveyRowsEndingAtOrAfter(minEndEpoch) {
      return surveyIndexRows
        .filter((r) => r.endEpoch >= minEndEpoch)
        .sort(bySurveyKey);
    },

    async putRefreshRun(row) {
      refreshRuns.set(row.startedAt, row);
      const cutoff = row.startedAt - OPERATIONAL_RETENTION_SECONDS;
      for (const at of refreshRuns.keys())
        if (at < cutoff) refreshRuns.delete(at);
    },
    async lastRefreshRun() {
      let last: RefreshRunRow | null = null;
      for (const r of refreshRuns.values())
        if (!last || r.startedAt > last.startedAt) last = r;
      return last;
    },
    async refreshTotalsSince(sinceUnix) {
      const rows = [...refreshRuns.values()].filter(
        (r) => r.startedAt >= sinceUnix,
      );
      return {
        runs: rows.length,
        failures: rows.filter((r) => !r.ok).length,
      };
    },
    async addUpstreamCalls(nowSec, calls) {
      const bucket = tallyBucket(nowSec);
      for (const kind of UPSTREAM_KINDS) {
        const n = calls[kind];
        if (n) upstreamTally.push({ bucket, kind, calls: n });
      }
    },
    async upstreamTotalsSince(sinceUnix) {
      const since = tallyBucket(sinceUnix);
      return upstreamTotalsFrom(upstreamTally.filter((r) => r.bucket >= since));
    },
    async pruneUpstreamTally(beforeUnix) {
      const before = tallyBucket(beforeUnix);
      upstreamTally = upstreamTally.filter((r) => r.bucket >= before);
    },
    async incompleteValidationCount() {
      return [...validated.values()].filter(
        (r) => r.blockIndex === null || r.proofOk === null,
      ).length;
    },

    async acquireRefreshLease(nowSec, ttlSeconds) {
      if (lease && lease.expiresAt > nowSec) return null;
      lease = { holder: crypto.randomUUID(), expiresAt: nowSec + ttlSeconds };
      return lease.holder;
    },
    async releaseRefreshLease(token) {
      if (lease?.holder === token) lease = null;
    },

    close() {},
  };
}
