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
  GovLink,
  ResponseRecord,
  SurveyRecord,
} from "./source";

/** Max tx hashes per /tx_metadata POST (larger bodies return HTTP 413). */
const TX_METADATA_BATCH = 50;

/** Per-request timeout: a stalled connection should fail, not hang forever. */
const REQUEST_TIMEOUT_MS = 15_000;

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
  epoch_slot: number;
  block_time: number;
}

interface TxStatusRow {
  tx_hash: string;
  /** Number of blocks built on top, or null until the tx is in a block. */
  num_confirmations: number | null;
}

interface ProposalRow {
  proposal_id: string;
  proposal_type: string;
  /** Epoch the action's voting period ends. */
  expiration: number | null;
  /** Anchor JSON, resolved by Koios when reachable (may be null). */
  meta_json: unknown;
}

/** The CIP-179 link discriminator carried in an Info Action's anchor. */
const GOV_LINK_KIND = "cardano-governance-survey-link";

export class KoiosDataSource implements DataSource {
  /**
   * `getToken` lets the active Koios token change at runtime (Settings override)
   * without rebuilding the source; defaults to the startup-resolved config token.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly getToken: () => string | undefined = () =>
      config.koiosToken,
  ) {}

  private headers(extra?: Record<string, string>): HeadersInit {
    const h: Record<string, string> = { ...extra };
    const token = this.getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.config.koiosUrl + path, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Koios GET ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.config.koiosUrl + path, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Koios POST ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async tip(): Promise<TipRow> {
    const rows = await this.get<TipRow[]>("/tip");
    const tip = rows[0];
    if (!tip) throw new Error("Koios /tip returned no rows");
    return tip;
  }

  async chainTip(): Promise<ChainTip> {
    const tip = await this.tip();
    return {
      epoch: tip.epoch_no,
      slot: tip.abs_slot,
      time: tip.block_time,
      epochSlot: tip.epoch_slot,
    };
  }

  async fetchAll(): Promise<Cip179Records> {
    // Filter by absolute_slot (which we already select) rather than
    // tx_timestamp (which we don't): Koios only allows filtering on selected
    // columns. Post-Shelley slots are 1s, so the cutoff slot for `sinceUnix`
    // is derived linearly from the current tip — no per-network genesis math.
    const tip = await this.tip();
    const sinceSlot = Math.max(
      0,
      Math.floor(tip.abs_slot - (tip.block_time - this.config.sinceUnix)),
    );
    const slots = await this.get<TxByLabel[]>(
      `/tx_by_metalabel?_label=${METADATA_LABEL}` +
        `&select=tx_hash,absolute_slot` +
        `&absolute_slot=gte.${sinceSlot}` +
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
    // Resolve batches independently: a transient failure on one batch should
    // drop only that page, not blank the entire snapshot (see file header).
    const metaPages = await Promise.allSettled(
      batches.map((batch) =>
        this.post<TxMetadata[]>("/tx_metadata?select=tx_hash,metadata", {
          _tx_hashes: batch,
        }),
      ),
    );
    const metas: TxMetadata[] = [];
    for (const page of metaPages) {
      if (page.status === "fulfilled") metas.push(...page.value);
      else console.warn(`skipping tx_metadata batch: ${String(page.reason)}`);
    }

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

  async txStatus(
    txHashes: readonly string[],
  ): Promise<Map<string, number | null>> {
    if (txHashes.length === 0) return new Map();
    const rows = await this.post<TxStatusRow[]>("/tx_status", {
      _tx_hashes: [...txHashes],
    });
    return new Map(rows.map((r) => [r.tx_hash, r.num_confirmations ?? null]));
  }

  async fetchGovernanceLinks(sinceUnix: number): Promise<GovLink[]> {
    // Info Actions only (the sole linkable action type), and only those created
    // at/after `sinceUnix` — older actions can't link to a still-active survey,
    // so bounding here avoids scanning the full Info-Action history. Koios
    // requires the filtered column be selected, hence `block_time` in select.
    // Koios resolves the anchor JSON into `meta_json` when the document is
    // reachable; we read the CIP-179 link fields straight from it.
    const rows = await this.get<ProposalRow[]>(
      `/proposal_list?proposal_type=eq.InfoAction` +
        `&select=proposal_id,proposal_type,expiration,meta_json,block_time` +
        `&block_time=gte.${Math.floor(sinceUnix)}`,
    );
    const links: GovLink[] = [];
    for (const row of rows) {
      const link = parseGovLink(row);
      if (link) links.push(link);
    }
    return links;
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

/**
 * Extract a CIP-179 survey link from an Info Action's anchor metadata. The link
 * object may be the whole anchor document or nested under a CIP-108 `body`;
 * we accept either and pull a human title from `body.title` when present.
 * Returns null for any action whose anchor doesn't carry a (well-formed) link.
 */
function parseGovLink(row: ProposalRow): GovLink | null {
  if (row.expiration === null) return null;
  const meta = row.meta_json;
  if (typeof meta !== "object" || meta === null) return null;
  const obj = meta as Record<string, unknown>;
  const body =
    typeof obj["body"] === "object" && obj["body"] !== null
      ? (obj["body"] as Record<string, unknown>)
      : undefined;

  const link = [obj, body].find(
    (c): c is Record<string, unknown> => !!c && c["kind"] === GOV_LINK_KIND,
  );
  if (!link) return null;

  const txid = link["surveyTxId"];
  if (typeof txid !== "string") return null;
  const idx = link["surveyIndex"];
  // A malformed/missing index must not silently resolve to survey 0.
  if (
    idx !== undefined &&
    !(typeof idx === "number" && Number.isInteger(idx) && idx >= 0)
  ) {
    return null;
  }
  const index = typeof idx === "number" ? idx : 0;
  const title =
    body && typeof body["title"] === "string" ? body["title"] : null;

  return {
    surveyKey: `${txid.toLowerCase()}:${index}`,
    actionId: row.proposal_id,
    endEpoch: row.expiration,
    title,
  };
}
