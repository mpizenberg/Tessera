/**
 * In-memory {@link BackendStore} for unit tests (route tests, validation and
 * finalization tests) — no SQLite, no D1. Same latest-wins/insert-or-ignore
 * semantics as the real stores. Not part of any runtime wiring.
 */

import type {
  ArtifactRow,
  BackendStore,
  CachedSnapshot,
  ValidatedResponseRow,
  WeightRow,
} from "./store";
import { validationKey } from "./store";

export interface MemBackendStore extends BackendStore {
  /** Direct row access for assertions. */
  readonly validated: Map<string, ValidatedResponseRow>;
  readonly weights: Map<string, WeightRow>;
  readonly totals: Map<string, { total: string; endpoint: string }>;
  readonly artifacts: Map<string, ArtifactRow>;
  readonly txMetadata: Map<string, unknown>;
}

export function memBackendStore(
  initial: CachedSnapshot | null = null,
): MemBackendStore {
  let snapshot = initial;
  const validated = new Map<string, ValidatedResponseRow>();
  const weights = new Map<string, WeightRow>();
  const totals = new Map<string, { total: string; endpoint: string }>();
  const artifacts = new Map<string, ArtifactRow>();
  const txMetadata = new Map<string, unknown>();

  const weightKey = (epoch: number, role: number, credential: string) =>
    `${epoch}|${role}|${credential}`;

  return {
    validated,
    weights,
    totals,
    artifacts,
    txMetadata,

    async get() {
      return snapshot;
    },
    async put(s) {
      snapshot = s;
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
    async upsertWeightRows(rows) {
      for (const r of rows)
        weights.set(weightKey(r.epoch, r.role, r.credential), r);
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
      for (const h of txHashes) if (txMetadata.has(h)) out.set(h, txMetadata.get(h));
      return out;
    },
    async putTxMetadata(entries) {
      for (const [h, m] of entries) if (!txMetadata.has(h)) txMetadata.set(h, m);
    },

    close() {},
  };
}
