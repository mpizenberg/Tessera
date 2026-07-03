/**
 * `IndexerDataSource` — the browser's read path against the Tier-1 serving
 * backend (`backend/ARCHITECTURE.md` §2, §5, §8).
 *
 * Where {@link import("@tessera/koios").KoiosDataSource} makes every browser
 * re-scan Koios (a shared token baked in the bundle; load scaling with
 * users × refreshes), this fetches a single snapshot the server already
 * assembled once per interval. It speaks the HTTP contract in
 * `backend/server/src/http.ts`, one route per `DataSource` method:
 *   - `GET /api/surveys`                    the Explore-list payload
 *   - `GET /api/surveys/{txHash}/{index}`   one survey's self-contained bundle
 *   - `GET /api/responded?credentials=`     survey keys a credential answered
 *   - `GET /api/tx_status`                  live confirmation counts
 *
 * Bodies arrive in the `@tessera/core` JSON-safe wire form (bytes → hex,
 * bigint → decimal string) and are decoded with {@link fromJsonSafe} back to
 * the exact `Uint8Array`/`bigint`/`Map`-bearing shapes the domain layer
 * expects — so the rest of the app can't tell whether Koios or the indexer
 * produced them. `KoiosDataSource` stays available as the direct/power-user/
 * offline path (when no indexer URL is configured); this is an addition.
 */

import { bytesToHex, fromJsonSafe } from "@tessera/core";
import type {
  DataSource,
  Network,
  SurveyBundle,
  SurveyListPayload,
  TallyArtifact,
} from "@tessera/core";
import type { SurveyRef } from "cip-179";

/** Abort a serving-tier request that hangs (all routes are cache-served, fast). */
const REQUEST_TIMEOUT_MS = 30_000;

export class IndexerDataSource implements DataSource {
  /**
   * One-time confirmation that the backend serves the network this app was
   * built for. Deployments are single-network on both sides, so a mismatch is
   * always a configuration error (wrong URL in the env or the Settings
   * override) — and silently mixing networks would show the wrong surveys and
   * feed the wrong protocol parameters into transaction building. Checked
   * against `/health` alongside the first snapshot fetch; memoized on success,
   * evicted on failure so a transient error doesn't poison later loads.
   */
  private networkOk: Promise<void> | null = null;

  /**
   * @param baseUrl serving-tier origin (no trailing slash), e.g.
   * `http://localhost:8787`. May be a same-origin path prefix; routes are joined
   * as plain strings so a prefix is preserved.
   * @param network the network this app serves; the backend must match.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly network: Network,
  ) {}

  /**
   * The wire form of every per-page route body is the JSON-safe encoding of the
   * decoded records ({@link fromJsonSafe} reverses it), plus the freshness
   * stamp the server appends — extra fields the seam types simply don't expose.
   */
  async surveyList(): Promise<SurveyListPayload> {
    const [raw] = await Promise.all([
      this.getJson<unknown>(`${this.baseUrl}/api/surveys`),
      this.assertNetwork(),
    ]);
    return fromJsonSafe(raw) as SurveyListPayload;
  }

  async surveyBundle(ref: SurveyRef): Promise<SurveyBundle> {
    const [raw] = await Promise.all([
      this.getJson<unknown>(
        `${this.baseUrl}/api/surveys/${bytesToHex(ref.txId)}/${ref.index}`,
      ),
      this.assertNetwork(),
    ]);
    return fromJsonSafe(raw) as SurveyBundle;
  }

  async respondedKeys(credentialKeys: readonly string[]): Promise<string[]> {
    if (credentialKeys.length === 0) return [];
    const qs = new URLSearchParams({ credentials: credentialKeys.join(",") });
    const [body] = await Promise.all([
      this.getJson<{ surveyKeys: string[] }>(
        `${this.baseUrl}/api/responded?${qs.toString()}`,
      ),
      this.assertNetwork(),
    ]);
    return body.surveyKeys;
  }

  /**
   * The survey's final artifact, or null if none exists yet (404). Artifacts
   * are wire-plain by design (weights are decimal strings, no bytes/bigints),
   * so this is a plain `JSON.parse` — no `fromJsonSafe` decode.
   */
  async artifact(ref: SurveyRef): Promise<TallyArtifact | null> {
    const url =
      `${this.baseUrl}/api/surveys/` +
      `${bytesToHex(ref.txId)}/${ref.index}/artifact`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Indexer ${url} → ${res.status}`);
    return (await res.json()) as TallyArtifact;
  }

  async txStatus(
    txHashes: readonly string[],
  ): Promise<Map<string, number | null>> {
    if (txHashes.length === 0) return new Map();
    const qs = new URLSearchParams({ hashes: txHashes.join(",") });
    const body = await this.getJson<Record<string, number | null>>(
      `${this.baseUrl}/api/tx_status?${qs.toString()}`,
    );
    return new Map(Object.entries(body));
  }

  /** See {@link networkOk}. */
  private assertNetwork(): Promise<void> {
    if (!this.networkOk) {
      const p = (async (): Promise<void> => {
        const health = await this.getJson<{ network?: string }>(
          `${this.baseUrl}/health`,
        );
        if (health.network !== this.network) {
          throw new Error(
            `Backend at ${this.baseUrl} serves network "${health.network}", ` +
              `but this app is built for "${this.network}" — fix the backend ` +
              `URL (VITE_INDEXER_URL or the Settings override).`,
          );
        }
      })();
      this.networkOk = p;
      p.catch(() => {
        if (this.networkOk === p) this.networkOk = null;
      });
    }
    return this.networkOk;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 503 = the server hasn't completed its first snapshot refresh yet.
      const hint =
        res.status === 503 ? " — serving-tier snapshot not ready yet" : "";
      throw new Error(`Indexer ${url} → ${res.status}${hint}`);
    }
    return res.json() as Promise<T>;
  }
}
