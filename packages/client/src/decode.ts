/**
 * Structural guards over each body the contract answers: a parsed JSON value
 * in, the payload type out, or a `Cip179DecodeError` naming the field that
 * does not fit. The record sections go through the `cip-179/tally` record
 * decoders; the envelope around them is plain JSON, checked field by field
 * against the type it is declared to be, so a malformed body is a decode
 * error at the boundary and never data.
 */

import { Cip179DecodeError } from "cip-179";
import type { ChainTip, GovLink } from "cip-179/domain";
import {
  decodeCancellationRecord,
  decodeResponseRecord,
  decodeSurveyRecord,
  type TallyArtifact,
} from "cip-179/tally";

import type {
  BackendHealth,
  BackendLiveness,
  RespondedPayload,
  SurveyBundlePayload,
  SurveyChangesPayload,
  SurveyFinalState,
  SurveyListCounts,
  SurveyListPayload,
  TxResponse,
  TxResponsesPayload,
} from "./payloads.js";

type Obj = Record<string, unknown>;
type Shape<T> = (v: unknown, path: string) => T;

const fail = (message: string, path: string): never => {
  throw new Cip179DecodeError(message, path);
};

const at = (path: string, key: string): string =>
  path ? `${path}.${key}` : key;

const obj = (v: unknown, path: string): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Obj)
    : fail(v === undefined ? "missing" : "expected object", path);

const str = (v: unknown, path: string): string =>
  typeof v === "string"
    ? v
    : fail(v === undefined ? "missing" : "expected string", path);

const num = (v: unknown, path: string): number =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : fail(v === undefined ? "missing" : "expected number", path);

const bool = (v: unknown, path: string): boolean =>
  typeof v === "boolean"
    ? v
    : fail(v === undefined ? "missing" : "expected boolean", path);

const list = <T>(v: unknown, path: string, item: Shape<T>): T[] =>
  Array.isArray(v)
    ? v.map((x, i) => item(x, `${path}[${i}]`))
    : fail(v === undefined ? "missing" : "expected array", path);

/** An object used as a map: every own value goes through `item`. */
const dict = <T>(v: unknown, path: string, item: Shape<T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(obj(v, path)).map(([k, x]) => [k, item(x, at(path, k))]),
  );

/** Present-or-absent: `undefined` stays absent, anything else must decode. */
const opt = <T>(v: unknown, path: string, item: Shape<T>): T | undefined =>
  v === undefined ? undefined : item(v, path);

/** Present-or-null: `null` is a value here, only `undefined` is absent. */
const nullable = <T>(v: unknown, path: string, item: Shape<T>): T | null =>
  v === null ? null : item(v, path);

const tip = (v: unknown, path: string): ChainTip => {
  const o = obj(v, path);
  return {
    epoch: num(o.epoch, at(path, "epoch")),
    slot: num(o.slot, at(path, "slot")),
    time: num(o.time, at(path, "time")),
    epochSlot: num(o.epochSlot, at(path, "epochSlot")),
    govActionLifetime: num(o.govActionLifetime, at(path, "govActionLifetime")),
  };
};

const govLink = (v: unknown, path: string): GovLink => {
  const o = obj(v, path);
  return {
    surveyKey: str(o.surveyKey, at(path, "surveyKey")),
    actionId: str(o.actionId, at(path, "actionId")),
    endEpoch: num(o.endEpoch, at(path, "endEpoch")),
    title: nullable(o.title, at(path, "title"), str),
  };
};

const finalState = (v: unknown, path: string): SurveyFinalState => {
  const o = obj(v, path);
  switch (o.state) {
    case "finalized":
    case "cancelled":
      return {
        state: o.state,
        artifactHash: str(o.artifactHash, at(path, "artifactHash")),
      };
    case "untalliable":
      return { state: "untalliable" };
    default:
      return fail(`unknown final state ${String(o.state)}`, at(path, "state"));
  }
};

const counts = (v: unknown, path: string): SurveyListCounts => {
  const o = obj(v, path);
  return {
    all: num(o.all, at(path, "all")),
    linked: num(o.linked, at(path, "linked")),
    active: num(o.active, at(path, "active")),
    sealed: num(o.sealed, at(path, "sealed")),
    public: num(o.public, at(path, "public")),
    mine: num(o.mine, at(path, "mine")),
  };
};

/** The optional fields a paged body may carry, absent when absent. */
const paging = (
  o: Obj,
): {
  nextCursor?: string | null;
  resync?: boolean;
} => {
  const nextCursor = opt(o.nextCursor, "nextCursor", (x, p) =>
    nullable(x, p, str),
  );
  const resync = opt(o.resync, "resync", bool);
  return {
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(resync === undefined ? {} : { resync }),
  };
};

/** The list body every selection of `/api/surveys` shares. */
function surveyListBody(
  o: Obj,
): Omit<SurveyListPayload, "counts" | "nextCursor" | "resync"> {
  const countedByRole = opt(o.countedByRole, "countedByRole", (x, p) =>
    dict(x, p, (y, q) => dict(y, q, num)),
  );
  const finalStates = opt(o.finalState, "finalState", (x, p) =>
    dict(x, p, finalState),
  );
  const incomplete = opt(o.incomplete, "incomplete", bool);
  const fetchedAt = opt(o.fetchedAt, "fetchedAt", num);
  return {
    surveys: list(o.surveys, "surveys", decodeSurveyRecord),
    cancellations: list(
      o.cancellations,
      "cancellations",
      decodeCancellationRecord,
    ),
    govLinks: list(o.govLinks, "govLinks", govLink),
    tip: tip(o.tip, "tip"),
    responseCounts: dict(o.responseCounts, "responseCounts", num),
    ...(countedByRole === undefined ? {} : { countedByRole }),
    ...(finalStates === undefined ? {} : { finalState: finalStates }),
    ...(incomplete === undefined ? {} : { incomplete }),
    ...(fetchedAt === undefined ? {} : { fetchedAt }),
  };
}

/** `GET /api/surveys`, the paged and by-reference selections. */
export function decodeSurveyList(json: unknown): SurveyListPayload {
  const o = obj(json, "");
  const chipCounts = opt(o.counts, "counts", counts);
  const changesCursor = opt(o.changesCursor, "changesCursor", str);
  return {
    ...surveyListBody(o),
    ...(chipCounts === undefined ? {} : { counts: chipCounts }),
    ...(changesCursor === undefined ? {} : { changesCursor }),
    ...paging(o),
  };
}

/** `GET /api/surveys?changes=`, the change selection. */
export function decodeSurveyChanges(json: unknown): SurveyChangesPayload {
  const o = obj(json, "");
  const resync = opt(o.resync, "resync", bool);
  return {
    ...surveyListBody(o),
    removed: list(o.removed, "removed", str),
    nextCursor: nullable(o.nextCursor, "nextCursor", str),
    ...(resync === undefined ? {} : { resync }),
  };
}

/** One page of `GET /api/surveys/{txHash}/{index}`. */
export function decodeSurveyBundle(json: unknown): SurveyBundlePayload {
  const o = obj(json, "");
  const verdicts = opt(o.verdicts, "verdicts", (x, p) => dict(x, p, bool));
  const govLinks = opt(o.govLinks, "govLinks", (x, p) => list(x, p, govLink));
  const fetchedAt = opt(o.fetchedAt, "fetchedAt", num);
  return {
    survey: decodeSurveyRecord(o.survey),
    responses: list(o.responses, "responses", decodeResponseRecord),
    cancellations: list(
      o.cancellations,
      "cancellations",
      decodeCancellationRecord,
    ),
    tip: tip(o.tip, "tip"),
    ...(verdicts === undefined ? {} : { verdicts }),
    ...(govLinks === undefined ? {} : { govLinks }),
    ...(fetchedAt === undefined ? {} : { fetchedAt }),
    ...paging(o),
  };
}

/** `GET /health`. */
export function decodeLiveness(json: unknown): BackendLiveness {
  const o = obj(json, "");
  if (o.ok !== true) fail("expected true", "ok");
  return {
    ok: true,
    network: str(o.network, "network"),
    apiVersion: str(o.apiVersion, "apiVersion"),
  };
}

/** `GET /api/health`. */
export function decodeHealth(json: unknown): BackendHealth {
  const o = obj(json, "");
  const snapshot = nullable(o.snapshot, "snapshot", (x, p) => {
    const s = obj(x, p);
    return {
      fetchedAt: num(s.fetchedAt, at(p, "fetchedAt")),
      ageSeconds: num(s.ageSeconds, at(p, "ageSeconds")),
    };
  });
  const lastRefresh = nullable(o.lastRefresh, "lastRefresh", (x, p) => {
    const r = obj(x, p);
    return {
      startedAt: num(r.startedAt, at(p, "startedAt")),
      durationMs: num(r.durationMs, at(p, "durationMs")),
      upstreamRequests: num(r.upstreamRequests, at(p, "upstreamRequests")),
      koiosCalls: num(r.koiosCalls, at(p, "koiosCalls")),
      ok: bool(r.ok, at(p, "ok")),
      error: nullable(r.error, at(p, "error"), str),
      govLinksOk: bool(r.govLinksOk, at(p, "govLinksOk")),
      incomplete: bool(r.incomplete, at(p, "incomplete")),
      surveys: num(r.surveys, at(p, "surveys")),
      responses: num(r.responses, at(p, "responses")),
      payloadBytes: num(r.payloadBytes, at(p, "payloadBytes")),
    };
  });
  const scan = nullable(o.scan, "scan", (x, p) => {
    const s = obj(x, p);
    return {
      cursorSlot: nullable(s.cursorSlot, at(p, "cursorSlot"), num),
      caughtUp: bool(s.caughtUp, at(p, "caughtUp")),
    };
  });
  const day = obj(o.last24h, "last24h");
  const quotas = obj(o.quotas, "quotas");
  return {
    network: str(o.network, "network"),
    apiVersion: str(o.apiVersion, "apiVersion"),
    commit: nullable(o.commit, "commit", str),
    snapshot,
    lastRefresh,
    scan,
    last24h: {
      runs: num(day.runs, "last24h.runs"),
      failures: num(day.failures, "last24h.failures"),
      upstreamRequests: num(day.upstreamRequests, "last24h.upstreamRequests"),
      koiosCalls: num(day.koiosCalls, "last24h.koiosCalls"),
      passthroughCalls: num(day.passthroughCalls, "last24h.passthroughCalls"),
    },
    validationBacklog: num(o.validationBacklog, "validationBacklog"),
    quotas: {
      subrequestsPerInvocation: nullable(
        quotas.subrequestsPerInvocation,
        "quotas.subrequestsPerInvocation",
        num,
      ),
      koiosCallsPerDay: nullable(
        quotas.koiosCallsPerDay,
        "quotas.koiosCallsPerDay",
        num,
      ),
    },
  };
}

/** `GET /api/responded`. */
export function decodeResponded(json: unknown): RespondedPayload {
  const o = obj(json, "");
  return {
    surveyKeys: list(o.surveyKeys, "surveyKeys", str),
    fetchedAt: num(o.fetchedAt, "fetchedAt"),
  };
}

const txResponse = (v: unknown, path: string): TxResponse => {
  const o = obj(v, path);
  return {
    responseIndex: num(o.responseIndex, at(path, "responseIndex")),
    surveyKey: str(o.surveyKey, at(path, "surveyKey")),
    role: num(o.role, at(path, "role")),
    credential: str(o.credential, at(path, "credential")),
    slot: num(o.slot, at(path, "slot")),
  };
};

/** `GET /api/responses/{txHash}`. */
export function decodeTxResponses(json: unknown): TxResponsesPayload {
  const o = obj(json, "");
  return {
    responses: list(o.responses, "responses", txResponse),
    fetchedAt: num(o.fetchedAt, "fetchedAt"),
  };
}

/** `GET /api/tip`. */
export const decodeTip = (json: unknown): ChainTip => tip(json, "");

/** `GET /api/tx_status`: confirmations per hash, `null` while not in a block. */
export const decodeTxStatus = (json: unknown): Record<string, number | null> =>
  dict(json, "", (x, p) => nullable(x, p, num));

/**
 * A tally artifact body. Artifacts are wire-plain (weights are decimal
 * strings, no bytes or bigints) and content-addressed, so the body is taken
 * as served once its two top-level sections are there: a reader that needs
 * more than shape recomputes `artifactHash` over `tally`.
 */
export function decodeArtifact(json: unknown): TallyArtifact {
  const o = obj(json, "");
  obj(o.tally, "tally");
  obj(o.provenance, "provenance");
  return o as unknown as TallyArtifact;
}
