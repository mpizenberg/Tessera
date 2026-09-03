/**
 * `IndexerDataSource` — the `DataSource` seam over `cardano-tessera-client`:
 * the browser's read path against the serving backend
 * (`backend/ARCHITECTURE.md` §2, §5, §7). Where
 * {@link import("cardano-tessera-koios").KoiosDataSource} makes every browser
 * re-scan Koios, this reads the snapshot the server assembled once per
 * interval. Each seam method is one client call; the seam's contract throws
 * where the client answers a typed not-ready state, and hands back a whole
 * bundle where the client pages. `KoiosDataSource` stays the direct /
 * power-user / offline path when no backend URL is configured.
 */

import {
  createTesseraClient,
  type BackendHealth,
  type Network,
  type SnapshotAnswer,
  type SurveyBundlePayload,
  type SurveyListParams,
  type SurveyListPayload,
  type TesseraClient,
} from "cardano-tessera-client";
import type { DataSource } from "cardano-tessera-core";
import type { SurveyRef } from "cip-179";
import type { TallyArtifact } from "cip-179/tally";

export class IndexerDataSource implements DataSource {
  private readonly client: TesseraClient;

  /**
   * @param baseUrl serving-tier origin (no trailing slash), e.g.
   * `http://localhost:8787`. May be a same-origin path prefix.
   * @param network the network this app serves; the backend must match.
   */
  constructor(
    private readonly baseUrl: string,
    network: Network,
  ) {
    this.client = createTesseraClient({ baseUrl, network });
  }

  private ready<T>(answer: SnapshotAnswer<T>): T {
    if (!answer.ready)
      throw new Error(
        `Backend at ${this.baseUrl} has not completed its first snapshot yet`,
      );
    return answer.body;
  }

  async surveyList(): Promise<SurveyListPayload> {
    return this.ready(await this.client.surveys());
  }

  async surveyListPage(params: SurveyListParams): Promise<SurveyListPayload> {
    return this.ready(await this.client.surveys(params));
  }

  async surveyBundle(ref: SurveyRef): Promise<SurveyBundlePayload> {
    return this.ready(await this.client.wholeBundle(ref));
  }

  async respondedKeys(credentialKeys: readonly string[]): Promise<string[]> {
    if (credentialKeys.length === 0) return [];
    return [
      ...this.ready(await this.client.responded(credentialKeys)).surveyKeys,
    ];
  }

  artifact(ref: SurveyRef): Promise<TallyArtifact | null> {
    return this.client.artifact(ref);
  }

  /** Display-only chrome: not gated on the compatibility handshake. */
  health(): Promise<BackendHealth> {
    return this.client.health();
  }

  async txStatus(
    txHashes: readonly string[],
  ): Promise<Map<string, number | null>> {
    return new Map(Object.entries(await this.client.txStatus(txHashes)));
  }
}
