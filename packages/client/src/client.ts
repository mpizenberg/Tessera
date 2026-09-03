/**
 * The typed client over a Tessera serving backend — one method per route,
 * decoded bodies, the contract's input rules applied before a request leaves,
 * and its version checked before the first snapshot read is trusted.
 */

import type { SurveyRef } from "cip-179";
import { refKey, type ChainTip } from "cip-179/domain";
import { fromJsonSafe, type TallyArtifact } from "cip-179/tally";

import { collectSurveyBundle } from "./bundle.js";
import {
  decodeArtifact,
  decodeHealth,
  decodeLiveness,
  decodeResponded,
  decodeSurveyBundle,
  decodeSurveyList,
  decodeTip,
  decodeTxResponses,
  decodeTxStatus,
} from "./decode.js";
import type { Network } from "./network.js";
import {
  API_VERSION,
  MAX_CREDENTIALS,
  MAX_PAGE_LIMIT,
  MAX_TX_STATUS_HASHES,
  SURVEY_KEY_RE,
  apiMajor,
  type BackendHealth,
  type BackendLiveness,
  type RespondedPayload,
  type SurveyBundlePayload,
  type SurveyListParams,
  type SurveyListPayload,
  type TxResponsesPayload,
} from "./payloads.js";

export interface TesseraClientOptions {
  /**
   * The backend's origin, or an origin plus path prefix, without a trailing
   * slash (one is trimmed): `https://tessera-backend-preprod.example.dev`.
   */
  readonly baseUrl: string;
  /**
   * The network the caller is built for. When given, the first snapshot read
   * refuses a backend serving another network — a configuration error that
   * would otherwise show the wrong surveys. The contract major is checked in
   * the same read whether or not a network is given.
   */
  readonly network?: Network | undefined;
  /** The `fetch` to use; the global one by default. */
  readonly fetch?: typeof fetch | undefined;
  /** Per-request budget in milliseconds, body included. Default 30 000. */
  readonly timeoutMs?: number | undefined;
}

/**
 * The answer of a snapshot-derived route. `ready: false` is the backend's
 * `503 {"error":"snapshot not ready"}` — it has not completed its first
 * refresh — an ordinary state to wait through, not an outage; every other
 * non-2xx status throws {@link TesseraHttpError}.
 */
export type SnapshotAnswer<T> =
  | { readonly ready: true; readonly body: T }
  | { readonly ready: false };

/** A non-2xx answer from the backend, other than the typed not-ready state. */
export class TesseraHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${url} → ${status}${body ? `: ${body}` : ""}`);
    this.name = "TesseraHttpError";
  }
}

/** A survey named either by its record's ref or by its key (`<txHash>:<index>`). */
export type SurveyId = SurveyRef | string;

export interface TesseraClient {
  /** `GET /health`: liveness, network, contract version. Not gated. */
  liveness(): Promise<BackendLiveness>;
  /** `GET /api/health`: operational metrics. Not gated. */
  health(): Promise<BackendHealth>;
  /**
   * `GET /api/surveys`, the paged selection. Refuses a `limit` outside
   * 1–{@link MAX_PAGE_LIMIT} or more than {@link MAX_CREDENTIALS} credentials
   * with a `RangeError` before any request.
   */
  surveys(
    params?: SurveyListParams,
  ): Promise<SnapshotAnswer<SurveyListPayload>>;
  /**
   * `GET /api/surveys?refs=`, the by-reference selection: the list payload for
   * exactly the keys named (1–{@link MAX_PAGE_LIMIT}, each matching
   * {@link SURVEY_KEY_RE}); a key matching nothing is absent from the answer.
   */
  surveysByRefs(
    keys: readonly string[],
  ): Promise<SnapshotAnswer<SurveyListPayload>>;
  /**
   * One page of a survey's bundle (`GET /api/surveys/{txHash}/{index}`); pass
   * the previous page's `nextCursor` to continue. An unknown survey is a
   * {@link TesseraHttpError} with status 404.
   */
  bundle(
    survey: SurveyId,
    cursor?: string | null,
  ): Promise<SnapshotAnswer<SurveyBundlePayload>>;
  /**
   * The whole bundle — every page of responses, verdicts merged — collected
   * with {@link collectSurveyBundle}'s restart rule. What a tally or an audit
   * reads; a host that only feeds `<tessera-respond>` needs {@link bundle}'s
   * first page.
   */
  wholeBundle(survey: SurveyId): Promise<SnapshotAnswer<SurveyBundlePayload>>;
  /** `GET /api/responded?credentials=` (at most {@link MAX_CREDENTIALS}). */
  responded(
    credentials: readonly string[],
  ): Promise<SnapshotAnswer<RespondedPayload>>;
  /**
   * `GET /api/responses/{txHash}`: the responses one transaction carried,
   * empty while the transaction is not indexed yet.
   */
  responsesByTx(txHash: string): Promise<SnapshotAnswer<TxResponsesPayload>>;
  /** The survey's final tally artifact, or `null` while none exists. Not gated. */
  artifact(survey: SurveyId): Promise<TallyArtifact | null>;
  /** An artifact by its content hash, or `null` when unknown. Not gated. */
  artifactByHash(hash: string): Promise<TallyArtifact | null>;
  /** `GET /api/tip`: the near-live chain tip. Not gated. */
  tip(): Promise<ChainTip>;
  /**
   * `GET /api/tx_status`: confirmations per transaction hash, `null` while a
   * transaction is not in a block (at most {@link MAX_TX_STATUS_HASHES}; an
   * empty list answers `{}` without a request). Not gated.
   */
  txStatus(hashes: readonly string[]): Promise<Record<string, number | null>>;
  /**
   * `GET /api/pparams`: the latest epoch's protocol parameters in the
   * evolution-sdk `ProtocolParameters` shape, decoded from the wire form. The
   * client does not depend on evolution-sdk, so the caller names the type.
   * Not gated.
   */
  pparams(): Promise<unknown>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NOT_READY_BODY = "snapshot not ready";

/** Thrown inside a page collection to surface the not-ready state past it. */
class NotReadySignal extends Error {}

const surveyKeyOf = (survey: SurveyId): string => {
  if (typeof survey !== "string") return refKey(survey);
  if (!SURVEY_KEY_RE.test(survey))
    throw new RangeError(`malformed survey key: ${survey}`);
  return survey;
};

const hex64 = (value: string, what: string): string => {
  if (!HEX64.test(value)) throw new RangeError(`malformed ${what}: ${value}`);
  return value;
};

const credentialsQuery = (credentials: readonly string[]): string => {
  if (credentials.length > MAX_CREDENTIALS)
    throw new RangeError(
      `at most ${MAX_CREDENTIALS} credentials per request, got ${credentials.length}`,
    );
  return credentials.join(",");
};

export function createTesseraClient(
  options: TesseraClientOptions,
): TesseraClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const network = options.network;

  const get = (url: string): Promise<Response> => {
    const init: RequestInit = {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    };
    return options.fetch ? options.fetch(url, init) : fetch(url, init);
  };

  const json = async (url: string): Promise<unknown> => {
    const res = await get(url);
    if (!res.ok) throw new TesseraHttpError(url, res.status, await res.text());
    return res.json();
  };

  const liveness = async (): Promise<BackendLiveness> =>
    decodeLiveness(await json(`${base}/health`));

  // Memoized on success, evicted on failure so a transient error does not
  // poison later reads.
  let compatible: Promise<void> | null = null;
  const ensureCompatible = (): Promise<void> => {
    if (!compatible) {
      const p = (async (): Promise<void> => {
        const live = await liveness();
        if (network !== undefined && live.network !== network)
          throw new Error(
            `Backend at ${base} serves network "${live.network}", not "${network}"`,
          );
        if (apiMajor(live.apiVersion) !== apiMajor(API_VERSION))
          throw new Error(
            `Backend at ${base} serves API version ${live.apiVersion}; ` +
              `this client speaks ${API_VERSION}`,
          );
      })();
      compatible = p;
      p.catch(() => {
        if (compatible === p) compatible = null;
      });
    }
    return compatible;
  };

  /** A snapshot-derived read: the compatibility check rides beside it. */
  const snapshot = async <T>(
    url: string,
    decode: (json: unknown) => T,
  ): Promise<SnapshotAnswer<T>> => {
    const [res] = await Promise.all([get(url), ensureCompatible()]);
    if (res.status === 503) {
      const text = await res.text();
      let error: unknown;
      try {
        error = (JSON.parse(text) as { error?: unknown }).error;
      } catch {
        error = undefined;
      }
      if (error === NOT_READY_BODY) return { ready: false };
      throw new TesseraHttpError(url, res.status, text);
    }
    if (!res.ok) throw new TesseraHttpError(url, res.status, await res.text());
    return { ready: true, body: decode(await res.json()) };
  };

  const artifactAt = async (url: string): Promise<TallyArtifact | null> => {
    const res = await get(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new TesseraHttpError(url, res.status, await res.text());
    return decodeArtifact(await res.json());
  };

  const bundleUrl = (survey: SurveyId): string => {
    const [txHash, index] = surveyKeyOf(survey).split(":");
    return `${base}/api/surveys/${txHash}/${index}`;
  };

  const bundle = (
    survey: SurveyId,
    cursor: string | null = null,
  ): Promise<SnapshotAnswer<SurveyBundlePayload>> => {
    const url = bundleUrl(survey);
    return snapshot(
      cursor === null ? url : `${url}?cursor=${encodeURIComponent(cursor)}`,
      decodeSurveyBundle,
    );
  };

  return {
    liveness,

    health: async () => decodeHealth(await json(`${base}/api/health`)),

    surveys: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.limit !== undefined) {
        if (
          !Number.isInteger(params.limit) ||
          params.limit < 1 ||
          params.limit > MAX_PAGE_LIMIT
        )
          throw new RangeError(
            `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}, got ${params.limit}`,
          );
        qs.set("limit", String(params.limit));
      }
      if (params.cursor) qs.set("cursor", params.cursor);
      if (params.filter && params.filter !== "all")
        qs.set("filter", params.filter);
      if (params.credentials?.length)
        qs.set("credentials", credentialsQuery(params.credentials));
      const search = params.search?.trim();
      if (search) qs.set("q", search);
      const query = qs.toString();
      return snapshot(
        `${base}/api/surveys${query ? `?${query}` : ""}`,
        decodeSurveyList,
      );
    },

    surveysByRefs: (keys) => {
      if (keys.length === 0 || keys.length > MAX_PAGE_LIMIT)
        throw new RangeError(
          `refs takes 1 to ${MAX_PAGE_LIMIT} survey keys, got ${keys.length}`,
        );
      for (const key of keys) surveyKeyOf(key);
      const qs = new URLSearchParams({ refs: keys.join(",") });
      return snapshot(`${base}/api/surveys?${qs}`, decodeSurveyList);
    },

    bundle,

    wholeBundle: async (survey) => {
      try {
        const body = await collectSurveyBundle(async (cursor) => {
          const page = await bundle(survey, cursor);
          if (!page.ready) throw new NotReadySignal();
          return page.body;
        });
        return { ready: true, body };
      } catch (e) {
        if (e instanceof NotReadySignal) return { ready: false };
        throw e;
      }
    },

    responded: (credentials) => {
      const qs = new URLSearchParams({
        credentials: credentialsQuery(credentials),
      });
      return snapshot(`${base}/api/responded?${qs}`, decodeResponded);
    },

    responsesByTx: (txHash) =>
      snapshot(
        `${base}/api/responses/${hex64(txHash, "tx hash")}`,
        decodeTxResponses,
      ),

    artifact: (survey) => artifactAt(`${bundleUrl(survey)}/artifact`),

    artifactByHash: (hash) =>
      artifactAt(`${base}/api/artifacts/${hex64(hash, "artifact hash")}`),

    tip: async () => decodeTip(await json(`${base}/api/tip`)),

    txStatus: (hashes) => {
      if (hashes.length === 0) return Promise.resolve({});
      if (hashes.length > MAX_TX_STATUS_HASHES)
        throw new RangeError(
          `at most ${MAX_TX_STATUS_HASHES} tx hashes per request, got ${hashes.length}`,
        );
      for (const h of hashes) hex64(h, "tx hash");
      const qs = new URLSearchParams({ hashes: hashes.join(",") });
      return json(`${base}/api/tx_status?${qs}`).then(decodeTxStatus);
    },

    pparams: async () => fromJsonSafe(await json(`${base}/api/pparams`)),
  };
}
