/**
 * Koios-backed `DataSource`.
 *
 * Read path (mirrors the elm-cardano reference):
 *   1. GET  /tx_by_metalabel?_label=17   → tx hashes carrying CIP-179 metadata
 *   2. POST /tx_metadata                  → the label-17 JSON metadata per tx
 *   3. JSON → Metadatum → decodePayloadItems → classify into the three record sets
 *
 * One malformed record never sinks the whole snapshot: an unreadable payload
 * envelope is logged and skipped, and within a batched payload each item is
 * decoded on its own, so neither a bad transaction nor a bad sibling can blank
 * the explorer or cost a well-formed record its place.
 */

import {
  decodePayloadItems,
  METADATA_LABEL,
  type DecodedPayloadItems,
  type SurveyRef,
} from "cip-179";

import {
  bytesToHex,
  credentialKey,
  hexToBytes,
  refKey,
  responseCounts,
  scriptCredentialHash,
} from "cip-179/domain";
import type {
  CancellationRecord,
  ChainTip,
  Cip179Records,
  GovLink,
  GovLinkScan,
  NativeScriptInfo,
  ResponseRecord,
  SurveyBundle,
  SurveyRecord,
  TxProof,
} from "cip-179/domain";
import type { TallyArtifact } from "cip-179/tally";
import type {
  AppConfig,
  DataSource,
  SurveyListPayload,
} from "cardano-tessera-core";
import { Koios } from "@evolution-sdk/evolution/sdk/provider/Koios";
import type { ProtocolParameters } from "@evolution-sdk/evolution/sdk/provider/Provider";
import { koiosJsonToMetadatum, type KoiosJson } from "./metadatum";
import { koiosFetchJson, mapSettled, MAX_INFLIGHT_BATCHES } from "./http";
import {
  govLinkScan,
  govProposal,
  resolveGovAnchors,
  type GovProposal,
  type ProposalRow,
  type ResolveAnchorsOptions,
} from "./govLinks";
import { decodeResolvedNativeScript, decodeTxProof } from "cip-179/txproof";
import { evolutionCodec } from "cip-179/evolution";

/** Max tx hashes per /tx_metadata POST (larger bodies return HTTP 413). */
const TX_METADATA_BATCH = 50;

/** Max tx hashes per /tx_cbor POST — raw CBOR is bulky, so a smaller page (100 returns 413). */
const TX_CBOR_BATCH = 25;

/** Max script hashes per /script_info POST (native-script resolution by hash). */
const SCRIPT_INFO_BATCH = 50;

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

/**
 * How long one `surveyList()` spends resolving governance anchors before it
 * publishes what it has. The list is already behind a full chain scan; a page
 * load must not additionally wait out every unreachable anchor at the surveys'
 * end epochs.
 */
const GOV_LINK_BUDGET_MS = 10_000;

interface TxByLabel {
  tx_hash: string;
  absolute_slot: number;
  epoch_no: number;
}

interface TxInfoRow {
  tx_hash: string;
  /** Position of the tx within its block (§6.3 same-slot ordering). */
  tx_block_index: number | null;
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

interface ScriptInfoRow {
  script_hash: string;
  /** Koios script type: native scripts are `multisig`/`timelock`; the rest are Plutus. */
  type: string;
  /** The script's CBOR (hex), or null if unavailable. */
  bytes: string | null;
}

/**
 * Fetch-once persistence for what a transaction hash content-addresses: its
 * label-17 metadata and its CBOR. Neither can change under a fixed hash, so
 * once fetched neither needs re-fetching. Entries are immutable — every `put`
 * is insert-or-ignore — and every read returns only the cached subset of the
 * requested hashes.
 *
 * Metadata is what lets the snapshot scan *converge* across runs instead of
 * re-paying every `/tx_metadata` batch per refresh: a run cut short (Worker
 * subrequest cap, timeout) banks the batches it did fetch, and the next run
 * fetches only the remainder. Snapshot membership still comes from the fresh
 * label-index scan, so a rolled-back tx simply stops being requested — a stale
 * entry is inert, never served.
 *
 * Proof CBOR is the credential-proof evidence behind owner-proofs and response
 * proofs, and saves the `/tx_cbor` batches an open survey would otherwise pay
 * on every scan. The *bytes* are cached, never the decoded proof: mechanism-A
 * resolution folds in scripts fetched by hash from the chain, and a script
 * absent today can be registered tomorrow, so a merged proof is only true as of
 * its fetch. Decoding and merging therefore run per call.
 *
 * The implementation is expected to *evict* proof CBOR (unlike metadata, whose
 * rows are small and always potentially wanted); a miss only ever costs the
 * re-fetch it would have cost anyway.
 */
export interface ScanCache {
  metadata(txHashes: readonly string[]): Promise<Map<string, unknown>>;
  putMetadata(entries: ReadonlyMap<string, unknown>): Promise<void>;
  proofCbor(txHashes: readonly string[]): Promise<Map<string, string>>;
  putProofCbor(entries: ReadonlyMap<string, string>): Promise<void>;
}

/**
 * A slot-bounded slice of the label-17 scan
 * ({@link KoiosDataSource.fetchSegment}).
 *
 * `from` is the resume point, in two shapes. Without `txHash`, an inclusive
 * slot floor (`absolute_slot ≥ slot`) — for re-deriving a settled margin,
 * where re-listing already-integrated txs is the point. With `txHash`,
 * strictly after the `(slot, txHash)` pair in scan order — for continuing a
 * budget-capped walk without re-listing anything, exact because the scan
 * orders by that same pair.
 */
export interface ScanSegment {
  readonly from: { readonly slot: number; readonly txHash?: string };
  /** Inclusive slot ceiling; omitted, the segment runs to the tip. */
  readonly toSlot?: number;
  /** Listing pages this call may spend; defaults to the `MAX_PAGES` backstop. */
  readonly pageBudget?: number;
}

/** What one segment walk covered — see {@link KoiosDataSource.fetchSegment}. */
export interface SegmentScan {
  readonly records: Cip179Records;
  /** The last row listed — the next run's `from`; null when nothing was listed. */
  readonly cursor: { readonly slot: number; readonly txHash: string } | null;
  /** A short page was reached: nothing in the segment is left unlisted. */
  readonly exhausted: boolean;
}

export class KoiosDataSource implements DataSource {
  /**
   * The full scan (records + tip) for the current load. `surveyList()` starts a
   * fresh one; `surveyBundle()`/`respondedKeys()` reuse it, so one page load
   * runs one Koios scan even though the seam exposes three per-page reads —
   * mirroring the memo `IndexerDataSource` keeps over its HTTP fetches.
   */
  private currentScan: Promise<{
    records: Cip179Records;
    tip: ChainTip;
  }> | null = null;

  /**
   * `getToken` lets the active Koios token change at runtime (Settings override)
   * without rebuilding the source; defaults to the startup-resolved config token.
   * `cache` is the optional {@link ScanCache} — the serving tier passes a
   * store-backed one so scans resume across crons; the browser passes none
   * (each page load is a fresh context anyway).
   * `onRequest` fires once per Koios HTTP request issued through this source —
   * the serving tier meters it against the Koios daily quota and the Worker's
   * per-invocation subrequest budget.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly getToken: () => string | undefined = () =>
      config.koiosToken,
    private readonly cache?: ScanCache,
    private readonly onRequest?: () => void,
  ) {}

  private headers(extra?: Record<string, string>): HeadersInit {
    const h: Record<string, string> = { ...extra };
    const token = this.getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    return koiosFetchJson<T>(
      this.config.koiosUrl + path,
      { headers: this.headers() },
      { label: path, onRequest: this.onRequest },
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return koiosFetchJson<T>(
      this.config.koiosUrl + path,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
      { label: path, onRequest: this.onRequest },
    );
  }

  private async tip(): Promise<TipRow> {
    const rows = await this.get<TipRow[]>("/tip");
    const tip = rows[0];
    if (!tip) throw new Error("Koios /tip returned no rows");
    return tip;
  }

  /**
   * `banked` is a tip the caller already holds — the serving tier's previous
   * snapshot. `gov_action_lifetime` is a protocol parameter, fixed for the whole
   * of an epoch, so when the banked tip names the epoch just read its value is
   * reused and the `/epoch_params` request is skipped outright. Exact rather
   * than a TTL: the epoch number *is* the cache key. Callers holding nothing
   * (the browser, the verifier) pass nothing and pay the read.
   */
  async chainTip(
    banked?: { epoch: number; govActionLifetime: number } | null,
  ): Promise<ChainTip> {
    const tip = await this.tip();
    return {
      epoch: tip.epoch_no,
      slot: tip.abs_slot,
      time: tip.block_time,
      epochSlot: tip.epoch_slot,
      govActionLifetime:
        banked?.epoch === tip.epoch_no
          ? banked.govActionLifetime
          : await this.govActionLifetime(tip.epoch_no),
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
    // It issues exactly one request per call, so counting it here is exact
    // unless the SDK retries internally, which this side cannot observe.
    this.onRequest?.();
    return new Koios(
      this.config.koiosUrl,
      this.getToken(),
    ).getProtocolParameters();
  }

  /**
   * `at` is a tip the caller already read. Passing it spares a second `/tip`
   * and, more than that, keeps the scan cutoff and the tip published beside the
   * records from straddling a block: two independent reads can land either side
   * of one. Only the slot and time are used, so any tip will do.
   */
  async fetchAll(at?: ChainTip): Promise<Cip179Records> {
    // Filter by absolute_slot (which we already select) rather than
    // tx_timestamp (which we don't): Koios only allows filtering on selected
    // columns. Post-Shelley slots are 1s, so the cutoff slot for `sinceUnix`
    // is derived linearly from the current tip — no per-network genesis math.
    const own = at ? null : await this.tip();
    const tip = own
      ? { slot: own.abs_slot, time: own.block_time, epoch: own.epoch_no }
      : { slot: at!.slot, time: at!.time, epoch: at!.epoch };
    const sinceSlot = Math.max(
      0,
      Math.floor(tip.slot - (tip.time - this.config.sinceUnix)),
    );

    // Page through every label-17 tx since the cutoff — responses live in the
    // same index as definitions, so a truncated listing would undercount
    // tallies, not just the survey list. Newest-first, so a scan cut off at
    // the page cap keeps the newest txs; the cap (like a failed page) flags
    // the snapshot `incomplete` instead of lying, and finalization postpones
    // on `incomplete`.
    const { posByHash, failed, exhausted } = await this.listLabelTxs(
      `&absolute_slot=gte.${sinceSlot}`,
      "desc",
      MAX_PAGES,
    );
    if (!failed && !exhausted) {
      console.warn(
        `tx_by_metalabel exceeded ${MAX_PAGES * PAGE_SIZE} rows; snapshot is incomplete`,
      );
    }
    return this.recordsFrom(posByHash, tip.epoch, failed || !exhausted);
  }

  /**
   * One slot segment of the label-17 index — the serving tier's windowed
   * refresh primitive. Ascending `(absolute_slot, tx_hash)` order, so a run
   * that stops early (page budget) has covered a contiguous prefix and the
   * returned cursor resumes it exactly; the newest-first `fetchAll` keeps the
   * newest rows instead, which suits a one-shot browser scan but cannot
   * resume.
   *
   * The caller advances its banked cursor to `cursor` only when
   * `records.incomplete` is false: a failed listing page or a dropped metadata
   * batch means a tx inside the listed range may be missing its record, and a
   * cursor advanced past it would settle the gap in. The segment is fully
   * covered (nothing left to list below `toSlot`/the tip) only when
   * `exhausted` is also true.
   *
   * A rollback landing mid-listing can shift ascending offsets and hide a row
   * from this pass; segment integration is idempotent re-derivation, so the
   * next run's re-scan of the settled margin picks it up.
   */
  async fetchSegment(segment: ScanSegment, at: ChainTip): Promise<SegmentScan> {
    const { from, toSlot, pageBudget } = segment;
    const floor =
      from.txHash === undefined
        ? `&absolute_slot=gte.${from.slot}`
        : `&or=(absolute_slot.gt.${from.slot},` +
          `and(absolute_slot.eq.${from.slot},tx_hash.gt.${from.txHash}))`;
    const ceiling = toSlot === undefined ? "" : `&absolute_slot=lte.${toSlot}`;
    const { posByHash, last, failed, exhausted } = await this.listLabelTxs(
      floor + ceiling,
      "asc",
      pageBudget ?? MAX_PAGES,
    );
    return {
      records: await this.recordsFrom(posByHash, at.epoch, failed),
      cursor: last && { slot: last.absolute_slot, txHash: last.tx_hash },
      exhausted,
    };
  }

  /**
   * Offset-paginate the label-17 index under `filter`, deduping rows by tx
   * hash (a tx landing mid-scan shifts its neighbours across a page boundary,
   * so a row can be listed twice).
   *
   * The order breaks slot ties on `tx_hash` (finding 17): `absolute_slot`
   * alone is a *partial* order, so several label-17 txs sharing a slot across
   * a page boundary could shuffle between the successive page requests and let
   * a row slip through unseen — a response missed by the scan, which would
   * read as a false MISMATCH, not a truncation. `tx_hash` is unique and
   * already selected, so `(absolute_slot, tx_hash)` is a total order stable
   * across pages. (Same discipline as `tallyInputs.postAll`.)
   *
   * A failed page returns what was already listed with `failed` set rather
   * than throwing (finding 39): a transient blip on one page shouldn't blank
   * an otherwise-good snapshot, and the fetch itself already absorbs a single
   * transient failure with one retry. `exhausted` means a short page was
   * reached — everything under `filter` was listed; false when `maxPages` ran
   * out first or a page failed. `last` is the final row of the last fulfilled
   * page, in the requested order.
   */
  private async listLabelTxs(
    filter: string,
    order: "asc" | "desc",
    maxPages: number,
  ): Promise<{
    posByHash: Map<string, { slot: number; epochNo: number }>;
    last: TxByLabel | null;
    failed: boolean;
    exhausted: boolean;
  }> {
    const posByHash = new Map<string, { slot: number; epochNo: number }>();
    let last: TxByLabel | null = null;
    for (let page = 0; page < maxPages; page++) {
      let rows: TxByLabel[];
      try {
        rows = await this.get<TxByLabel[]>(
          `/tx_by_metalabel?_label=${METADATA_LABEL}` +
            `&select=tx_hash,absolute_slot,epoch_no` +
            filter +
            `&order=absolute_slot.${order},tx_hash.${order}` +
            `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
        );
      } catch (err) {
        console.warn(`tx_by_metalabel page ${page} failed: ${String(err)}`);
        return { posByHash, last, failed: true, exhausted: false };
      }
      for (const s of rows) {
        if (!posByHash.has(s.tx_hash))
          posByHash.set(s.tx_hash, {
            slot: s.absolute_slot,
            epochNo: s.epoch_no,
          });
      }
      if (rows.length > 0) last = rows[rows.length - 1]!;
      if (rows.length < PAGE_SIZE)
        return { posByHash, last, failed: false, exhausted: true };
    }
    return { posByHash, last, failed: false, exhausted: false };
  }

  /**
   * Turn listed label-17 txs into the three record sets: consult the metadata
   * cache, fetch the remainder in batches, decode and classify, then attach
   * owner-proof evidence for surveys still open at `tipEpoch`.
   * `listingIncomplete` seeds the flag for failures the listing already
   * suffered; a dropped metadata batch adds to it.
   */
  private async recordsFrom(
    posByHash: ReadonlyMap<string, { slot: number; epochNo: number }>,
    tipEpoch: number,
    listingIncomplete: boolean,
  ): Promise<Cip179Records> {
    let incomplete = listingIncomplete;
    const hashes = [...posByHash.keys()];

    const surveys: SurveyRecord[] = [];
    const responses: ResponseRecord[] = [];
    const cancellations: CancellationRecord[] = [];
    if (hashes.length === 0)
      return { surveys, responses, cancellations, incomplete };

    // Consult the fetch-once cache first (serving tier only): tx metadata is
    // immutable, so anything fetched by an earlier run never hits Koios again.
    // Best-effort — a cache read failure degrades to a full fetch, never sinks
    // the scan.
    const cached = this.cache
      ? await this.cache.metadata(hashes).catch((err) => {
          console.warn(`tx metadata cache read failed: ${String(err)}`);
          return new Map<string, unknown>();
        })
      : new Map<string, unknown>();
    const missing = hashes.filter((h) => !cached.has(h));

    // Koios caps the bulk POST body size, so request metadata in batches
    // (1000 hashes in one shot returns 413 Payload Too Large) and merge.
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += TX_METADATA_BATCH) {
      batches.push(missing.slice(i, i + TX_METADATA_BATCH));
    }
    // Resolve batches independently: a transient failure on one batch should
    // drop only that page, not blank the entire snapshot (see file header).
    // Each fulfilled batch is banked into the cache *before* it resolves — a
    // run that dies mid-scan (subrequest budget, timeout) keeps the progress it
    // made, so repeated over-budget runs still converge instead of re-fetching
    // the same batches forever. Hashes a fulfilled batch returned no row for
    // are banked as null (answered authoritatively: no metadata) so they are
    // not re-requested every run either.
    //
    // Capped at MAX_INFLIGHT_BATCHES in flight (finding 39): firing every batch
    // at once is the shape that trips Koios's rate limiter, whose 429s would
    // otherwise cascade batches into `incomplete` and postpone finalization.
    // `mapSettled` keeps the same per-batch settle semantics as the former
    // `Promise.allSettled`, just throttled.
    const metaPages = await mapSettled(
      batches,
      MAX_INFLIGHT_BATCHES,
      async (batch) => {
        const rows = await this.post<TxMetadata[]>(
          "/tx_metadata?select=tx_hash,metadata",
          { _tx_hashes: batch },
        );
        if (this.cache) {
          const byHash = new Map<string, unknown>(batch.map((h) => [h, null]));
          for (const r of rows) byHash.set(r.tx_hash, r.metadata);
          await this.cache
            .putMetadata(byHash)
            .catch((err) =>
              console.warn(`tx metadata cache write failed: ${String(err)}`),
            );
        }
        return rows;
      },
    );
    const metas: TxMetadata[] = [];
    for (const hash of hashes) {
      if (!cached.has(hash)) continue;
      metas.push({
        tx_hash: hash,
        metadata: cached.get(hash) as TxMetadata["metadata"],
      });
    }
    for (const page of metaPages) {
      if (page.status === "fulfilled") metas.push(...page.value);
      else {
        // A dropped batch shrinks the snapshot (missing responses/cancellations)
        // — flag it incomplete so finalization postpones instead of hashing a
        // tally that's missing responders or misses a cancellation.
        incomplete = true;
        console.warn(
          `skipping tx_metadata batch (snapshot incomplete): ${String(page.reason)}`,
        );
      }
    }

    for (const row of metas) {
      const raw = row.metadata?.[String(METADATA_LABEL)];
      if (raw === undefined) continue;
      // Every metadata row was requested by tx_hash from posByHash, so a miss is
      // impossible. Throw rather than fabricate {slot:0, epochNo:0}, which would
      // silently mark the response on-time and collapse every dedup tie.
      const pos = posByHash.get(row.tx_hash);
      if (!pos) throw new Error(`metadata for unknown tx ${row.tx_hash}`);
      let decoded: DecodedPayloadItems;
      try {
        decoded = decodePayloadItems(koiosJsonToMetadatum(raw));
      } catch (err) {
        // Envelope-level failure (unknown tag, not an array): nothing to keep.
        console.warn(`skipping label-17 tx ${row.tx_hash}: ${String(err)}`);
        continue;
      }
      for (const s of decoded.skipped) {
        console.warn(
          `skipping label-17 item ${row.tx_hash}[${s.index}]: ${String(s.error)}`,
        );
      }
      this.classify(decoded.payload, row.tx_hash, pos, {
        surveys,
        responses,
        cancellations,
      });
    }

    // Owner-proof evidence, gathered for still-open surveys only. CIP-179 asks
    // the same question of a survey's *defining* transaction ("MUST prove
    // ownership of the `owner` credential") and of a transaction cancelling it
    // (same credential, same mechanism A), so one `txProofs` call answers both
    // — a single tx can even be both, a batch that defines one survey and
    // cancels another. Records outside that set keep `proof: null`, which the
    // domain treats as unverified.
    //
    // Deliberately NOT extended to closed surveys (considered, rejected): every
    // definition and every in-window cancellation ever posted would then have
    // its tx CBOR fetched on every scan, forever — a permanent, cumulative
    // cost, and for cancellations an adversarial one: anyone can post
    // cancellation txs against open surveys for ~one tx fee each, buying
    // ⌈N/25⌉ extra Koios requests per scan for the rest of the deployment's
    // life (against the Worker's subrequest cap, and per visitor in direct
    // mode). Open-only keeps that cost transient — it evaporates when the
    // targeted surveys close — and it tracks where each proof matters: an
    // unproven owner matters while a survey can still attract responses (the UI
    // badges it untalliable and blocks answering, so nobody pays a fee to a
    // survey published under a borrowed name), and a cancellation can only
    // suppress a survey that is still open. Once closed, the finalized artifact
    // carries both verdicts, and the emitter re-reads the proofs itself before
    // freezing one.
    //
    // The gap that leaves HERE: a cancelled-then-closed survey looks merely
    // "ended". The serving tier covers it from the artifact instead
    // (`finalizedCancelled` in the list payload); direct-Koios mode has no
    // artifacts and accepts the gap. Mirrors `cancellationStates` in
    // cardano-tessera-core's survey.ts.
    const refKeyOf = (ref: SurveyRef): string =>
      `${bytesToHex(ref.txId)}:${ref.index}`;
    const openSurveyKeys = new Set(
      surveys
        .filter((s) => tipEpoch <= s.definition.endEpoch)
        .map((s) => refKeyOf(s.ref)),
    );
    const openSurveys = surveys.filter((s) =>
      openSurveyKeys.has(refKeyOf(s.ref)),
    );
    const openCancellations: CancellationRecord[] = [];
    const closedCancellations: CancellationRecord[] = [];
    for (const c of cancellations) {
      if (openSurveyKeys.has(refKeyOf(c.target))) openCancellations.push(c);
      else closedCancellations.push(c);
    }

    // A script-credentialed owner's native script may not be attached to the tx
    // that has to prove it (CIP-179 mechanism A allows chain resolution), so
    // tell `txProofs` which script hash each tx claims and let it resolve the
    // hash when the witness set lacks it (finding 7).
    const ownerByKey = new Map(
      surveys.map((s) => [refKeyOf(s.ref), s.definition.owner]),
    );
    const neededScripts = new Map<string, string[]>();
    const needScript = (txHash: string, scriptHash: string | null): void => {
      if (!scriptHash) return;
      const list = neededScripts.get(txHash);
      if (list) list.push(scriptHash);
      else neededScripts.set(txHash, [scriptHash]);
    };
    for (const s of openSurveys) {
      needScript(s.txHash, scriptCredentialHash(s.definition.owner));
    }
    for (const c of openCancellations) {
      const owner = ownerByKey.get(refKeyOf(c.target));
      needScript(c.txHash, owner ? scriptCredentialHash(owner) : null);
    }

    const proofTxs = [
      ...new Set([
        ...openSurveys.map((s) => s.txHash),
        ...openCancellations.map((c) => c.txHash),
      ]),
    ];
    const proofs =
      proofTxs.length === 0
        ? new Map<string, TxProof | null>()
        : await this.txProofs(proofTxs, neededScripts);

    return {
      surveys: surveys.map((s) =>
        openSurveyKeys.has(refKeyOf(s.ref))
          ? { ...s, proof: proofs.get(s.txHash) ?? null }
          : s,
      ),
      responses,
      cancellations: [
        ...openCancellations.map((c) => ({
          ...c,
          proof: proofs.get(c.txHash) ?? null,
        })),
        ...closedCancellations,
      ],
      incomplete,
    };
  }

  /**
   * The current load's scan, starting one if nothing is in flight yet. The tip
   * is read first and handed to the scan rather than fetched twice in parallel:
   * `fetchAll` awaits a tip before paging either way, so one read costs no
   * latency and the records cannot be cut off at a different block than the tip
   * published with them.
   */
  private scan(): Promise<{ records: Cip179Records; tip: ChainTip }> {
    return (this.currentScan ??= this.chainTip().then(async (tip) => ({
      records: await this.fetchAll(tip),
      tip,
    })));
  }

  async surveyList(): Promise<SurveyListPayload> {
    this.currentScan = null; // a list load always scans fresh
    const { records, tip } = await this.scan();
    // Governance links are best-effort enrichment (mirrors the serving tier's
    // refresh): a failure must not sink the survey list. Bounded by the scanned
    // surveys' end epochs — no other action could link a survey we'd show.
    //
    // Resolving anchors means dereferencing one document per candidate action,
    // with no bank to shorten the work (each load is a fresh context), so the
    // whole resolution runs under one budget: a dead anchor delays the list by
    // at most that, and simply doesn't appear as a link. The serving tier — the
    // path that must not lose a link to a slow gateway — banks each verified
    // fetch instead and waits epochs, not seconds.
    const { links: govLinks } = await this.fetchGovernanceLinks(
      records.surveys.map((s) => s.definition.endEpoch),
      { signal: AbortSignal.timeout(GOV_LINK_BUDGET_MS) },
    ).catch((err) => {
      console.warn(`governance linkage unavailable: ${String(err)}`);
      return { links: [] as GovLink[], unresolved: [] };
    });
    return {
      surveys: records.surveys,
      cancellations: records.cancellations,
      govLinks,
      tip,
      responseCounts: responseCounts(records.responses),
      ...(records.incomplete !== undefined && {
        incomplete: records.incomplete,
      }),
    };
  }

  async surveyBundle(ref: SurveyRef): Promise<SurveyBundle> {
    const { records, tip } = await this.scan();
    const key = refKey(ref);
    const survey = records.surveys.find((s) => refKey(s.ref) === key);
    if (!survey) throw new Error(`unknown survey ${key}`);
    return {
      survey,
      responses: records.responses.filter(
        (r) => refKey(r.response.surveyRef) === key,
      ),
      cancellations: records.cancellations.filter(
        (c) => refKey(c.target) === key,
      ),
      tip,
    };
  }

  async respondedKeys(credentialKeys: readonly string[]): Promise<string[]> {
    if (credentialKeys.length === 0) return [];
    const { records } = await this.scan();
    const wanted = new Set(credentialKeys);
    const keys = new Set<string>();
    for (const r of records.responses) {
      if (wanted.has(credentialKey(r.response.credential))) {
        keys.add(refKey(r.response.surveyRef));
      }
    }
    return [...keys];
  }

  /**
   * Credential-proof evidence per transaction: fetch each tx's CBOR
   * (`/tx_cbor`, batched) and decode required signers, native scripts, and
   * vote bindings. Used at scan time for the owner-proofs of open surveys and
   * of the transactions cancelling them, and for response credential-proofs
   * (§6.3 rule 2) by the serving tier's validation pass. Each unique tx is
   * fetched and decoded once, so a batch that carries several records costs one
   * row — and where a {@link ScanCache} is present, once across all refreshes.
   * The decode runs per call even on a cached hit, so the mechanism-A merge
   * below is never banked and a decoder fix needs no re-fetch.
   *
   * The two map outcomes are semantically distinct and callers MUST NOT conflate
   * them:
   *  - a **non-null `TxProof`** is a *definitive, complete* reading of the tx's
   *    evidence — an empty proof (no matching signer / no script / no vote) means
   *    the credential is genuinely *unproven*, a final negative verdict;
   *  - **`null`** means the evidence *could not be established this refresh* (the
   *    batch fetch threw, the row carried no CBOR, or the decode failed) — i.e.
   *    *unknown*, so the caller must retry on a later refresh, never treat it as
   *    a negative verdict (freezing an artifact on it would be wrong — finding 1).
   *
   * `neededScripts` maps a tx hash to the native-script *credential* hashes its
   * record(s) claim (a script owner/response credential). CIP-179 mechanism A
   * lets that script be resolved by hash through a chain index, not only from the
   * carrying tx's witness set — a metadata-only tx need not attach it — so any
   * such hash absent from the witness set is fetched via `/script_info` and
   * folded into that tx's `nativeScripts` (the pure evaluation is unchanged). A
   * script that resolves cleanly but is genuinely *absent* on-chain (or Plutus,
   * so no native mechanism-A path) stays unmerged → a *final* unproven, which is
   * correct and can't paralyse finalization. But a `/script_info` request that
   * *failed* (couldn't ask) for a needed, non-witnessed script downgrades that
   * tx's proof to `null` (unknown) so it rides the same retry path, never a
   * silent negative on unresolved data (findings 6/7).
   */
  async txProofs(
    txHashes: readonly string[],
    neededScripts: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<Map<string, TxProof | null>> {
    const proofByHash = new Map<string, TxProof | null>(
      txHashes.map((h) => [h, null]),
    );
    // Consult the fetch-once cache first (serving tier only): a tx hash
    // content-addresses its CBOR, so anything banked by an earlier refresh never
    // hits Koios again. Best-effort — a cache read failure degrades to a full
    // fetch, never sinks the call.
    const cborByHash = this.cache
      ? await this.cache.proofCbor(txHashes).catch((err) => {
          console.warn(`tx proof cache read failed: ${String(err)}`);
          return new Map<string, string>();
        })
      : new Map<string, string>();
    const missing = txHashes.filter((h) => !cborByHash.has(h));
    for (let i = 0; i < missing.length; i += TX_CBOR_BATCH) {
      const batch = missing.slice(i, i + TX_CBOR_BATCH);
      try {
        const rows = await this.post<TxCborRow[]>(
          "/tx_cbor?select=tx_hash,cbor",
          { _tx_hashes: batch },
        );
        const fetched = new Map<string, string>();
        for (const r of rows) if (r.cbor) fetched.set(r.tx_hash, r.cbor);
        // Only bytes Koios actually returned are banked. A hash it returned no
        // row for is a node that hasn't caught up, not an answer — banking it
        // as "no evidence" would turn a retryable unknown into a permanent
        // unproven. (Its metadata twin banks absences precisely because an empty
        // metadata row *is* an answer.)
        if (this.cache && fetched.size > 0) {
          await this.cache
            .putProofCbor(fetched)
            .catch((err) =>
              console.warn(`tx proof cache write failed: ${String(err)}`),
            );
        }
        for (const [hash, cbor] of fetched) cborByHash.set(hash, cbor);
      } catch (err) {
        console.warn(
          `tx_cbor batch failed; its txs stay unproven: ${String(err)}`,
        );
      }
    }
    for (const [hash, cbor] of cborByHash) {
      proofByHash.set(hash, decodeTxProof(evolutionCodec, cbor));
    }
    await this.resolveMechanismAScripts(proofByHash, neededScripts);
    return proofByHash;
  }

  /**
   * Fold chain-resolved native scripts into `proofByHash` for the mechanism-A
   * script credentials in `neededScripts` that aren't already in their tx's
   * witness set (CIP-179 lets the script be resolved by hash, not only from the
   * carrying tx). Mutates `proofByHash` in place:
   *  - a resolved script is appended to its tx's `nativeScripts`;
   *  - a script whose `/script_info` fetch *succeeded* but returned no native
   *    script (never on-chain, or Plutus) is left out → mechanism A finds no
   *    match → a *final* unproven (so a bogus script-hash response is simply
   *    excluded, never a perpetual postponement);
   *  - a script whose fetch *failed* nulls its tx's proof → unknown/retry, so an
   *    unresolvable-this-refresh script is surfaced, not silently decided.
   */
  private async resolveMechanismAScripts(
    proofByHash: Map<string, TxProof | null>,
    neededScripts: ReadonlyMap<string, readonly string[]>,
  ): Promise<void> {
    // The script hashes actually missing from their own tx's witness set — the
    // only ones needing a chain lookup. Union them so `/script_info` is hit once.
    const missingByTx = new Map<string, string[]>();
    const wanted = new Set<string>();
    for (const [txHash, hashes] of neededScripts) {
      const proof = proofByHash.get(txHash);
      if (!proof) continue; // tx unknown already → nothing to add
      const witnessed = new Set(proof.nativeScripts.map((ns) => ns.scriptHash));
      const missing = [...new Set(hashes)].filter((h) => !witnessed.has(h));
      if (missing.length === 0) continue;
      missingByTx.set(txHash, missing);
      for (const h of missing) wanted.add(h);
    }
    if (wanted.size === 0) return;

    const { scripts, reliable } = await this.resolveNativeScripts([...wanted]);
    for (const [txHash, missing] of missingByTx) {
      const proof = proofByHash.get(txHash);
      if (!proof) continue;
      const add: TxProof["nativeScripts"][number][] = [];
      let unresolvable = false;
      for (const h of missing) {
        const script = scripts.get(h);
        if (script) add.push({ scriptHash: h, script });
        else if (!reliable) unresolvable = true; // couldn't ask → unknown, retry
        // reliable && no script: definitively not a native script → leave out.
      }
      if (unresolvable) {
        proofByHash.set(txHash, null);
        continue;
      }
      if (add.length > 0) {
        proofByHash.set(txHash, {
          ...proof,
          nativeScripts: [...proof.nativeScripts, ...add],
        });
      }
    }
  }

  /**
   * Resolve native scripts by hash via `/script_info` (batched). Returns the
   * decoded scripts keyed by their recomputed hash, and `reliable = false` iff a
   * batch request *threw* — the caller distinguishes "asked, no such native
   * script" (definitive) from "couldn't ask" (unknown, retry). Only `multisig`/
   * `timelock` rows (native scripts) are decoded; Plutus rows and undecodable
   * bytes are dropped (a Plutus credential has no mechanism-A path anyway).
   */
  async resolveNativeScripts(
    scriptHashes: readonly string[],
  ): Promise<{ scripts: Map<string, NativeScriptInfo>; reliable: boolean }> {
    const scripts = new Map<string, NativeScriptInfo>();
    let reliable = true;
    for (let i = 0; i < scriptHashes.length; i += SCRIPT_INFO_BATCH) {
      const batch = scriptHashes.slice(i, i + SCRIPT_INFO_BATCH);
      try {
        const rows = await this.post<ScriptInfoRow[]>(
          "/script_info?select=script_hash,type,bytes",
          { _script_hashes: batch },
        );
        for (const r of rows) {
          if (!r.bytes) continue;
          if (r.type !== "multisig" && r.type !== "timelock") continue;
          const decoded = decodeResolvedNativeScript(evolutionCodec, r.bytes);
          if (decoded) scripts.set(decoded.scriptHash, decoded.script);
        }
      } catch (err) {
        console.warn(
          `script_info batch failed; its scripts stay unresolved: ${String(err)}`,
        );
        reliable = false;
      }
    }
    return { scripts, reliable };
  }

  /**
   * `tx_block_index` (position within the block) per transaction, via
   * `/tx_info` — the §6.3 same-slot ordering input. A failed batch just leaves
   * its hashes out of the map (callers treat missing as "retry next refresh").
   */
  async txBlockIndices(
    txHashes: readonly string[],
  ): Promise<Map<string, number>> {
    const byHash = new Map<string, number>();
    for (let i = 0; i < txHashes.length; i += TX_METADATA_BATCH) {
      const batch = txHashes.slice(i, i + TX_METADATA_BATCH);
      try {
        const rows = await this.post<TxInfoRow[]>(
          "/tx_info?select=tx_hash,tx_block_index",
          { _tx_hashes: batch },
        );
        for (const r of rows) {
          if (r.tx_block_index !== null)
            byHash.set(r.tx_hash, r.tx_block_index);
        }
      } catch (err) {
        console.warn(`tx_info batch failed: ${String(err)}`);
      }
    }
    return byHash;
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

  /**
   * Always `null`: artifacts are emitted by the serving tier's finalization,
   * which the direct Koios path has no access to. The UI shows the raw
   * client-side tally instead (the pre-artifact behaviour).
   */
  async artifact(_ref: SurveyRef): Promise<TallyArtifact | null> {
    return null;
  }

  /**
   * Governance actions that could link a survey ending at one of `endEpochs`,
   * as on-chain rows: identity, expiry epoch, and the anchor each commits to.
   * Whether an action actually links a survey is decided by reading that anchor
   * ({@link resolveGovAnchors}), not by this call.
   *
   * Every column here is on-chain (db-sync), so the rows are small, immutable
   * and identical across nodes — no `meta_json`, whose off-chain resolution
   * flaps between Koios nodes and is null for most actions anyway.
   *
   * The scan is cut server-side to those epochs, losslessly: epoch alignment
   * (`expiration - 1 === end_epoch`) is the join key every consumer applies, so
   * an action expiring outside them is dead weight in every path. With no epochs
   * there is nothing to align to, so nothing is fetched. Any action kind may
   * carry a link (CIP-179 v5), so kind is not filtered. Koios requires a
   * filtered column to be selected — a filter over an unselected column is
   * silently ignored, and the rows come back unfiltered.
   *
   * Offset-paginate like the label scan (finding 37): a single unbounded GET
   * silently drops rows past Koios's ~1000-row cap, and *which* rows is
   * undefined — a linked survey could then render standalone, differently across
   * refreshes. `order=proposal_id.asc` (unique, and selected) makes pagination
   * stable so no row shuffles across a page boundary (finding 2). Links are
   * best-effort display enrichment (never a hashed input), so a scan that
   * somehow exceeds the page cap just logs and returns what it has.
   */
  async fetchGovProposals(
    endEpochs: readonly number[],
  ): Promise<GovProposal[]> {
    const expirations = [...new Set(endEpochs)]
      .sort((a, b) => a - b)
      .map((e) => e + 1);
    if (expirations.length === 0) return [];

    const proposals: GovProposal[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.get<ProposalRow[]>(
        `/proposal_list?select=proposal_id,expiration,meta_url,meta_hash` +
          `&expiration=in.(${expirations.join(",")})` +
          `&order=proposal_id.asc` +
          `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      );
      for (const row of rows) {
        const proposal = govProposal(row);
        if (proposal) proposals.push(proposal);
        else {
          console.warn(
            `proposal ${row.proposal_id} commits to no usable anchor — it can carry no verifiable link`,
          );
        }
      }
      if (rows.length < PAGE_SIZE) return proposals;
    }
    console.warn(
      `proposal_list exceeded ${MAX_PAGES * PAGE_SIZE} rows; governance links may be incomplete`,
    );
    return proposals;
  }

  /**
   * The links among those actions, resolving every anchor here and now. The
   * one-shot composition for callers with no place to bank a classification (a
   * browser load, a verifier run); the serving tier drives the two halves
   * itself so a verified anchor is fetched once ever, not once per refresh.
   */
  async fetchGovernanceLinks(
    endEpochs: readonly number[],
    opts: ResolveAnchorsOptions = {},
  ): Promise<GovLinkScan> {
    const proposals = await this.fetchGovProposals(endEpochs);
    if (proposals.length === 0) return { links: [], unresolved: [] };
    return govLinkScan(proposals, await resolveGovAnchors(proposals, opts));
  }

  private classify(
    payload: DecodedPayloadItems["payload"],
    txHash: string,
    pos: { slot: number; epochNo: number },
    out: {
      surveys: SurveyRecord[];
      responses: ResponseRecord[];
      cancellations: CancellationRecord[];
    },
  ): void {
    const { slot, epochNo } = pos;
    switch (payload.type) {
      case "definitions": {
        const txId = hexToBytes(txHash);
        for (const { index, value: definition } of payload.definitions) {
          out.surveys.push({
            txHash,
            slot,
            epochNo,
            ref: { txId, index },
            definition,
          });
        }
        break;
      }
      case "responses":
        for (const {
          index: responseIndex,
          value: response,
        } of payload.responses) {
          // The payload index is part of the §6.3 chain order (same-tx ties).
          out.responses.push({
            txHash,
            slot,
            epochNo,
            responseIndex,
            response,
          });
        }
        break;
      case "cancellations":
        for (const { value: target } of payload.cancellations) {
          // `proof` is filled in a second pass, which fetches the cancelling
          // tx's CBOR to read its owner-proof evidence.
          out.cancellations.push({
            txHash,
            slot,
            epochNo,
            target,
            proof: null,
          });
        }
        break;
    }
  }
}
