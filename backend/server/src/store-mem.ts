/**
 * In-memory {@link BackendStore} for unit tests (route tests, validation and
 * finalization tests) — no SQLite, no D1. Same latest-wins/insert-or-ignore
 * semantics as the real stores. Not part of any runtime wiring.
 */

import type { SurveyListFilter } from "@tessera/core";

import type {
  ArtifactRow,
  BackendStore,
  RefreshRunRow,
  ResponseRow,
  SnapshotMeta,
  SurveyIndexRow,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import { REFRESH_RUN_RETENTION_SECONDS, validationKey } from "./store";

export interface MemBackendStore extends BackendStore {
  /** Direct row access for assertions. */
  readonly validated: Map<string, ValidatedResponseRow>;
  readonly weights: Map<string, WeightRow>;
  readonly totals: Map<string, { total: string; endpoint: string }>;
  readonly artifacts: Map<string, ArtifactRow>;
  readonly txMetadata: Map<string, unknown>;
  readonly refreshRuns: Map<number, RefreshRunRow>;
  surveyIndex: readonly SurveyIndexRow[];
}

export function memBackendStore(): MemBackendStore {
  const validated = new Map<string, ValidatedResponseRow>();
  const weights = new Map<string, WeightRow>();
  const totals = new Map<string, { total: string; endpoint: string }>();
  const artifacts = new Map<string, ArtifactRow>();
  const txMetadata = new Map<string, unknown>();
  const refreshRuns = new Map<number, RefreshRunRow>();
  let lease: { holder: string; expiresAt: number } | null = null;
  let surveyIndexRows: readonly SurveyIndexRow[] = [];
  let responseRows: readonly ResponseRow[] = [];
  let meta: SnapshotMeta | null = null;

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

  return {
    validated,
    weights,
    totals,
    artifacts,
    txMetadata,
    refreshRuns,
    get surveyIndex() {
      return surveyIndexRows;
    },

    async completedValidations() {
      return new Map(
        [...validated.values()]
          .filter((r) => r.blockIndex !== null && r.proofOk !== null)
          .map((r) => [
            validationKey(r.txHash, r.responseIndex),
            r.linkedActionId,
          ]),
      );
    },
    async upsertValidatedResponses(rows) {
      for (const r of rows)
        validated.set(validationKey(r.txHash, r.responseIndex), r);
    },
    async validatedForSurvey(surveyKey) {
      return [...validated.values()].filter((r) => r.surveyKey === surveyKey);
    },
    async deleteValidatedResponses(keys) {
      for (const k of keys)
        validated.delete(validationKey(k.txHash, k.responseIndex));
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
    async finalizedSurveyKeys() {
      return new Set(artifacts.keys());
    },
    async finalizedCancelledKeys() {
      return new Set(
        [...artifacts.values()]
          .filter((a) => {
            const body = JSON.parse(a.artifact) as {
              tally?: { cancelled?: unknown };
            };
            return body.tally?.cancelled != null;
          })
          .map((a) => a.surveyKey),
      );
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

    async replaceSnapshot(surveys, responses, envelope) {
      surveyIndexRows = [...surveys];
      responseRows = [...responses];
      meta = envelope;
    },
    async snapshotMeta() {
      return meta;
    },
    async surveyRow(surveyKey) {
      return surveyIndexRows.find((r) => r.surveyKey === surveyKey) ?? null;
    },
    async responsesForSurvey(surveyKey) {
      return responseRows
        .filter((r) => r.surveyKey === surveyKey)
        .sort(
          (a, b) =>
            a.slot - b.slot ||
            (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0) ||
            a.responseIndex - b.responseIndex,
        )
        .map((r) => r.record);
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

    async putRefreshRun(row) {
      refreshRuns.set(row.startedAt, row);
      const cutoff = row.startedAt - REFRESH_RUN_RETENTION_SECONDS;
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
        koiosCalls: rows.reduce((sum, r) => sum + r.koiosCalls, 0),
      };
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
