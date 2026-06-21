/**
 * Koios-backed `DataSource`.
 *
 * Read path (mirrors the elm-cardano reference):
 *   1. GET  /tx_by_metalabel?_label=17   → tx hashes carrying CIP-179 metadata
 *   2. POST /tx_metadata                  → the label-17 JSON metadata per tx
 *   3. JSON → Metadatum → decodePayload   → classify into the three record sets
 *
 * One malformed payload never sinks the whole snapshot: decode failures are
 * logged and skipped, so a single bad transaction can't blank the explorer.
 */

import { decodePayload, METADATA_LABEL, type Cip179Payload } from "cip-179";

import type { AppConfig } from "~/config";
import { hexToBytes } from "~/util/hex";
import { koiosJsonToMetadatum, type KoiosJson } from "./metadatum";
import type {
  CancellationRecord,
  ChainTip,
  Cip179Records,
  DataSource,
  ResponseRecord,
  SurveyRecord,
} from "./source";

/** Max tx hashes per /tx_metadata POST (larger bodies return HTTP 413). */
const TX_METADATA_BATCH = 50;

interface TxByLabel {
  tx_hash: string;
  absolute_slot: number;
}

interface TxMetadata {
  tx_hash: string;
  metadata: Record<string, KoiosJson> | null;
}

interface TipRow {
  epoch_no: number;
  abs_slot: number;
}

export class KoiosDataSource implements DataSource {
  constructor(private readonly config: AppConfig) {}

  private headers(extra?: Record<string, string>): HeadersInit {
    const h: Record<string, string> = { ...extra };
    if (this.config.koiosToken) {
      h["Authorization"] = `Bearer ${this.config.koiosToken}`;
    }
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.config.koiosUrl + path, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Koios GET ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.config.koiosUrl + path, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Koios POST ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  async chainTip(): Promise<ChainTip> {
    const rows = await this.get<TipRow[]>("/tip");
    const tip = rows[0];
    if (!tip) throw new Error("Koios /tip returned no rows");
    return { epoch: tip.epoch_no, slot: tip.abs_slot };
  }

  async fetchAll(): Promise<Cip179Records> {
    const slots = await this.get<TxByLabel[]>(
      `/tx_by_metalabel?_label=${METADATA_LABEL}` +
        `&select=tx_hash,absolute_slot` +
        `&tx_timestamp=gte.${this.config.sinceUnix}` +
        `&order=absolute_slot.desc&limit=1000`,
    );
    const slotByHash = new Map(slots.map((s) => [s.tx_hash, s.absolute_slot]));
    const hashes = slots.map((s) => s.tx_hash);

    const surveys: SurveyRecord[] = [];
    const responses: ResponseRecord[] = [];
    const cancellations: CancellationRecord[] = [];
    if (hashes.length === 0) return { surveys, responses, cancellations };

    // Koios caps the bulk POST body size, so request metadata in batches
    // (1000 hashes in one shot returns 413 Payload Too Large) and merge.
    const batches: string[][] = [];
    for (let i = 0; i < hashes.length; i += TX_METADATA_BATCH) {
      batches.push(hashes.slice(i, i + TX_METADATA_BATCH));
    }
    const metaPages = await Promise.all(
      batches.map((batch) =>
        this.post<TxMetadata[]>("/tx_metadata?select=tx_hash,metadata", {
          _tx_hashes: batch,
        }),
      ),
    );
    const metas = metaPages.flat();

    for (const row of metas) {
      const raw = row.metadata?.[String(METADATA_LABEL)];
      if (raw === undefined) continue;
      const slot = slotByHash.get(row.tx_hash) ?? 0;
      let payload: Cip179Payload;
      try {
        payload = decodePayload(koiosJsonToMetadatum(raw));
      } catch (err) {
        console.warn(`skipping label-17 tx ${row.tx_hash}: ${String(err)}`);
        continue;
      }
      this.classify(payload, row.tx_hash, slot, {
        surveys,
        responses,
        cancellations,
      });
    }

    return { surveys, responses, cancellations };
  }

  private classify(
    payload: Cip179Payload,
    txHash: string,
    slot: number,
    out: {
      surveys: SurveyRecord[];
      responses: ResponseRecord[];
      cancellations: CancellationRecord[];
    },
  ): void {
    switch (payload.type) {
      case "definitions": {
        const txId = hexToBytes(txHash);
        payload.definitions.forEach((definition, index) => {
          out.surveys.push({
            txHash,
            slot,
            ref: { txId, index },
            definition,
          });
        });
        break;
      }
      case "responses":
        for (const response of payload.responses) {
          out.responses.push({ txHash, slot, response });
        }
        break;
      case "cancellations":
        for (const target of payload.cancellations) {
          out.cancellations.push({ txHash, slot, target });
        }
        break;
    }
  }
}
