/**
 * A real store on an in-memory SQLite database, for the behavioural tests
 * (routes, validation, finalization, governance links). They run against the
 * SQL the deployments run, so a query and the behaviour it backs can no longer
 * pass separately.
 *
 * It also exposes the tables a test asserts on directly as plain maps. These
 * are *views*, read out of the same database on each access and mapped by the
 * store's own row mappers — never a second copy of the state — so an assertion
 * about "what got written" is an assertion about the real rows.
 */

import { DatabaseSync } from "node:sqlite";

import type { GovLinkDoc } from "cip-179/domain";

import type {
  ArtifactRow,
  BackendStore,
  ResponseRow,
  SettledGovEpoch,
  SlotRange,
  SurveyIndexRow,
  ValidatedResponseRow,
  WeightRow,
} from "../store";
import { govEpochFromDb, validationKey, type DbGovEpochRow } from "../store";
import { nodeBackendStore } from "../store-node";
import {
  ARTIFACT_COLUMNS,
  VALIDATED_COLUMNS,
  surveyRowFromDb,
  validatedFromDb,
  type DbSurveyRow,
  type DbValidatedRow,
} from "../store-sql";
import { RESPONSE_ROW_COLUMNS, SURVEY_ROW_COLUMNS } from "../sqlBuilders";

/** The range admitting every row — how tests seed via `reconcileSegment`. */
export const ALL_SLOTS: SlotRange = {
  fromSlot: 0,
  toSlot: Number.MAX_SAFE_INTEGER,
};

/** The stored tables tests read back, keyed as their primary keys are. */
export interface StoredRows {
  /** Every materialized survey row, whole. */
  readonly surveyRows: SurveyIndexRow[];
  /** Every materialized response row, whole. */
  readonly responseRows: ResponseRow[];
  readonly validated: Map<string, ValidatedResponseRow>;
  readonly weights: Map<string, WeightRow>;
  readonly artifacts: Map<string, ArtifactRow>;
  /** Persisted untalliable verdicts. */
  readonly untalliable: Set<string>;
  /** Banked anchor classifications by hash; null = verified non-link. */
  readonly govAnchors: Map<string, GovLinkDoc | null>;
  readonly govEpochs: Map<number, SettledGovEpoch>;
}

export type TestStore = BackendStore &
  StoredRows & { readonly db: DatabaseSync };

export function testStore(): TestStore {
  const db = new DatabaseSync(":memory:");
  const store = nodeBackendStore(db) as TestStore;
  const rows = <T>(sql: string): T[] => db.prepare(sql).all() as unknown as T[];
  const view = <T>(get: () => T) => ({ get, enumerable: true });

  return Object.defineProperties(store, {
    db: { value: db },
    surveyRows: view(() =>
      rows<DbSurveyRow>(`SELECT ${SURVEY_ROW_COLUMNS} FROM survey_index`).map(
        surveyRowFromDb,
      ),
    ),
    responseRows: view(() =>
      rows<ResponseRow>(`SELECT ${RESPONSE_ROW_COLUMNS} FROM response`),
    ),
    validated: view(
      () =>
        new Map(
          rows<DbValidatedRow>(
            `SELECT ${VALIDATED_COLUMNS} FROM validated_response`,
          ).map((r) => [
            validationKey(r.txHash, r.responseIndex),
            validatedFromDb(r),
          ]),
        ),
    ),
    weights: view(
      () =>
        new Map(
          rows<Omit<WeightRow, "registered"> & { registered: number }>(
            `SELECT epoch, role, credential, weight, registered,
                    fetched_at AS fetchedAt
             FROM weight_snapshot`,
          ).map((r) => [
            `${r.epoch}|${r.role}|${r.credential}`,
            { ...r, registered: r.registered !== 0 },
          ]),
        ),
    ),
    artifacts: view(
      () =>
        new Map(
          rows<ArtifactRow>(
            `SELECT ${ARTIFACT_COLUMNS} FROM tally_artifact`,
          ).map((r) => [r.surveyKey, r]),
        ),
    ),
    untalliable: view(
      () =>
        new Set(
          rows<{ surveyKey: string }>(
            "SELECT survey_key AS surveyKey FROM untalliable_survey",
          ).map((r) => r.surveyKey),
        ),
    ),
    govAnchors: view(
      () =>
        new Map(
          rows<{ hash: string; link: string }>(
            "SELECT anchor_hash AS hash, link FROM gov_anchor",
          ).map((r) => [r.hash, JSON.parse(r.link) as GovLinkDoc | null]),
        ),
    ),
    govEpochs: view(
      () =>
        new Map(
          rows<DbGovEpochRow>(
            `SELECT expiration, links, gave_up AS gaveUp,
                    settled_at AS settledAt
             FROM gov_epoch`,
          ).map((r) => [r.expiration, govEpochFromDb(r)]),
        ),
    ),
  });
}
