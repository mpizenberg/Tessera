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

import {
  decodePayload,
  METADATA_LABEL,
  type Cip179Payload,
  type SurveyRef,
} from "cip-179";

import { bytesToHex, hexToBytes, parseCip179Link } from "@tessera/core";
import type {
  AppConfig,
  CancellationProof,
  CancellationRecord,
  ChainTip,
  Cip179Records,
  DataSource,
  GovLink,
  ResponseRecord,
  SurveyRecord,
} from "@tessera/core";
import { Koios } from "@evolution-sdk/evolution/sdk/provider/Koios";
import type { ProtocolParameters } from "@evolution-sdk/evolution/sdk/provider/Provider";
import { koiosJsonToMetadatum, type KoiosJson } from "./metadatum";
import { decodeCancellationProof } from "./txProof";

/** Max tx hashes per /tx_metadata POST (larger bodies return HTTP 413). */
const TX_METADATA_BATCH = 50;

/** Max tx hashes per /tx_cbor POST — raw CBOR is bulky, so a smaller page (100 returns 413). */
const TX_CBOR_BATCH = 25;

/**
 * Rows per label-index page. Koios allows up to 1000 rows/response, but we page
 * at 100 to keep each request small (gentler on rate-limited endpoints); the
 * loop below fetches as many pages as needed, so coverage is unaffected.
 */
const PAGE_SIZE = 100;

/**
 * Hard cap on label-index pages (≈ {@link PAGE_SIZE} × this many = 5,000 rows). A
 * backstop against an unbounded scan; if reached, the snapshot is flagged
 * `incomplete` rather than silently truncated.
 */
const MAX_PAGES = 50;

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

interface EpochParamsRow {
  /** Epochs a governance action stays open for voting (Conway parameter). */
  gov_action_lifetime: number | null;
}

interface TxStatusRow {
  tx_hash: string;
  /** Number of blocks built on top, or null until the tx is in a block. */
  num_confirmations: number | null;
}

interface TxCborRow {
  tx_hash: string;
  /** Full transaction CBOR (hex), or null if unavailable. */
  cbor: string | null;
}

export interface ProposalRow {
  proposal_id: string;
  proposal_type: string;
  /**
   * Koios's `expiration` epoch: the epoch in which the action *drops out* of the
   * proposal set. This is one PAST the action's last active epoch — the ledger's
   * `gasExpiresAfter = proposed_epoch + gov_action_lifetime` is the last epoch the
   * action is still votable, and Koios reports `gasExpiresAfter + 1` here. So the
   * action's voting-end epoch (what CIP-179 aligns against a survey's `end_epoch`)
   * is `expiration - 1`, applied in {@link parseGovLink}.
   */
  expiration: number | null;
  /** Anchor JSON, resolved by Koios when reachable (may be null). */
  meta_json: unknown;
}

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
      govActionLifetime: await this.govActionLifetime(tip.epoch_no),
    };
  }

  /**
   * The `gov_action_lifetime` parameter for an epoch. Best-effort: returns 0 if
   * the lookup fails, so a flaky params call can't sink the whole snapshot — it
   * only feeds the optional governance-link end-epoch helper, which falls back
   * to manual entry when the value is unknown.
   */
  private async govActionLifetime(epoch: number): Promise<number> {
    try {
      const rows = await this.get<EpochParamsRow[]>(
        `/epoch_params?_epoch_no=${epoch}&select=gov_action_lifetime`,
      );
      return rows[0]?.gov_action_lifetime ?? 0;
    } catch (err) {
      console.warn(`gov_action_lifetime lookup failed: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Full protocol parameters for the latest epoch, in evolution-sdk's
   * `ProtocolParameters` shape. The serving tier exposes these so the browser's
   * transaction builder can pass them as `build({ fullProtocolParameters })` and
   * skip the provider's own pparams fetch — the one Koios read that tx building
   * otherwise needs, letting the client build without a Koios token
   * (`backend/ARCHITECTURE.md` §8). Deposits, execution budgets, and
   * coins-per-UTxO-byte are BigInt; cost models are index-keyed per language.
   */
  async protocolParameters(): Promise<ProtocolParameters> {
    // The SDK's own Koios provider already fetches and maps /epoch_params into
    // this shape — delegate rather than duplicate the field-by-field mapping.
    return new Koios(
      this.config.koiosUrl,
      this.getToken(),
    ).getProtocolParameters();
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

    // Page through every label-17 tx since the cutoff. Koios returns at most
    // PAGE_SIZE rows per request, so a single fixed `limit` would silently drop
    // older records on a busy network — and responses live in the same index as
    // definitions, so the loss would undercount tallies, not just the survey
    // list. Offset-paginate newest-first until a short page (exhausted) or the
    // page cap, which flags the snapshot `incomplete` instead of lying. Keyed by
    // tx_hash in a Map so a row re-seen across pages (a tx landing mid-scan) is
    // deduped rather than fetched twice.
    const slotByHash = new Map<string, number>();
    let incomplete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.get<TxByLabel[]>(
        `/tx_by_metalabel?_label=${METADATA_LABEL}` +
          `&select=tx_hash,absolute_slot` +
          `&absolute_slot=gte.${sinceSlot}` +
          `&order=absolute_slot.desc` +
          `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      );
      for (const s of rows) {
        if (!slotByHash.has(s.tx_hash))
          slotByHash.set(s.tx_hash, s.absolute_slot);
      }
      if (rows.length < PAGE_SIZE) break; // last page reached → exhausted
      if (page === MAX_PAGES - 1) {
        // A full final page means there may be more we won't fetch.
        incomplete = true;
        console.warn(
          `tx_by_metalabel exceeded ${MAX_PAGES * PAGE_SIZE} rows; snapshot is incomplete`,
        );
      }
    }
    const hashes = [...slotByHash.keys()];

    const surveys: SurveyRecord[] = [];
    const responses: ResponseRecord[] = [];
    const cancellations: CancellationRecord[] = [];
    if (hashes.length === 0)
      return { surveys, responses, cancellations, incomplete };

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

    // A cancellation only matters while its target survey is still open: once a
    // survey has ended (tip past its end_epoch) it's closed regardless, so
    // there's nothing to suppress — and fetching + decoding its cancelling tx's
    // CBOR (the owner proof) would be wasted work. So verify proofs only for
    // cancellations of still-open surveys; the rest (closed, or referencing an
    // unknown survey) keep `proof: null`, which the domain treats as unverified —
    // moot for a closed survey. Mirrors `cancellationStates` in domain/survey.ts.
    const refKeyOf = (ref: SurveyRef): string =>
      `${bytesToHex(ref.txId)}:${ref.index}`;
    const openSurveyKeys = new Set(
      surveys
        .filter((s) => tip.epoch_no <= s.definition.endEpoch)
        .map((s) => refKeyOf(s.ref)),
    );
    const openCancellations: CancellationRecord[] = [];
    const closedCancellations: CancellationRecord[] = [];
    for (const c of cancellations) {
      if (openSurveyKeys.has(refKeyOf(c.target))) openCancellations.push(c);
      else closedCancellations.push(c);
    }

    return {
      surveys,
      responses,
      cancellations: [
        ...(await this.withCancellationProofs(openCancellations)),
        ...closedCancellations,
      ],
      incomplete,
    };
  }

  /**
   * Fill each cancellation's owner-proof evidence by fetching the cancelling
   * transaction's CBOR (`/tx_cbor`) and decoding its `required_signers` +
   * witness-set native scripts. Callers pass only cancellations of still-open
   * surveys (a closed survey can't be suppressed, so verifying its cancellation
   * would be wasted work — see {@link fetchAll}). Cancellations are rare, so this
   * is one extra (batched) request per refresh only when any exist. A failed
   * fetch/decode leaves `proof: null` → the cancellation is treated as
   * unverified, never an error that sinks the snapshot. Decoded once per unique
   * tx (a batched cancellation tx can target several surveys).
   */
  private async withCancellationProofs(
    cancellations: readonly CancellationRecord[],
  ): Promise<CancellationRecord[]> {
    if (cancellations.length === 0) return [...cancellations];

    const txHashes = [...new Set(cancellations.map((c) => c.txHash))];
    const cborByHash = new Map<string, string>();
    for (let i = 0; i < txHashes.length; i += TX_CBOR_BATCH) {
      const batch = txHashes.slice(i, i + TX_CBOR_BATCH);
      try {
        const rows = await this.post<TxCborRow[]>(
          "/tx_cbor?select=tx_hash,cbor",
          { _tx_hashes: batch },
        );
        for (const r of rows) if (r.cbor) cborByHash.set(r.tx_hash, r.cbor);
      } catch (err) {
        console.warn(
          `tx_cbor batch failed; cancellations stay unverified: ${String(err)}`,
        );
      }
    }

    const proofByHash = new Map<string, CancellationProof | null>();
    await Promise.all(
      [...cborByHash.entries()].map(async ([hash, cbor]) => {
        proofByHash.set(hash, await decodeCancellationProof(cbor));
      }),
    );

    return cancellations.map((c) => ({
      ...c,
      proof: proofByHash.get(c.txHash) ?? null,
    }));
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
          // `proof` is filled in a second pass (withCancellationProofs), which
          // fetches the cancelling tx's CBOR to read its owner-proof evidence.
          out.cancellations.push({ txHash, slot, target, proof: null });
        }
        break;
    }
  }
}

/**
 * Extract a CIP-179 survey link from an Info Action's anchor metadata. The link
 * lives in `body.cip179` (so it is part of the CIP-108 canonicalized, author-
 * witnessed body), is tagged `kind: "survey-link"`, and carries the survey's
 * `surveyTxId` / `surveyIndex`. The human title shown is the action's own
 * CIP-108 `body.title`. Returns null for any action whose anchor doesn't carry
 * a (well-formed) link.
 */
export function parseGovLink(row: ProposalRow): GovLink | null {
  if (row.expiration === null) return null;
  // Shared shape validation (single source of truth with the proposal builder);
  // here we need only the ref — a missing/malformed link yields null.
  const { surveyRef } = parseCip179Link(row.meta_json);
  if (!surveyRef) return null;

  // The human title shown is the action's own CIP-108 `body.title`.
  // TODO(govlink-title-trust): `title` is attacker-controlled off-chain anchor
  // JSON. It's escaped before render (no XSS), and epoch-alignment is enforced,
  // but the title's *content* is not authenticated — a malicious Info Action can
  // claim e.g. "Official Cardano Foundation Poll" to lend a survey false
  // authority. The UI currently shows it as "Advertised by {title}". Later:
  // present it as unverified (length-clamp + an explicit caveat) and soften the
  // "Advertised by" wording so it doesn't overstate verification.
  const meta = row.meta_json as Record<string, unknown>;
  const body = meta["body"] as Record<string, unknown>;
  const title = typeof body["title"] === "string" ? body["title"] : null;

  return {
    surveyKey: `${surveyRef.txId}:${surveyRef.index}`,
    actionId: row.proposal_id,
    // Koios's `expiration` is the epoch the action drops out (one past its last
    // active epoch); the action's voting-end epoch — what a linked survey's
    // `end_epoch` must equal — is `expiration - 1`. See ProposalRow.expiration.
    endEpoch: row.expiration - 1,
    title,
  };
}
