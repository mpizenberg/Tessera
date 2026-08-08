/**
 * Segment integration: fold one slot segment of the label-17 scan into the
 * materialized rows, touching only what the segment (or an observed event)
 * bears on. This replaces the per-refresh full rebuild; `materializeSnapshot`
 * remains as the differential-test oracle — integration over any event
 * sequence must leave exactly the rows a full rebuild would produce.
 *
 * A survey is *touched* — its projection re-derived from scratch — when the
 * segment carries its definition, a response or cancellation targeting it,
 * when a stored response/cancellation in the swept range is about to vanish
 * (rolled back), when its governance link set differs from the stored one, or
 * when its verified-while-open cancellation expired at close. Every per-survey
 * aggregate is recomputed over stored rows merged with the segment's records,
 * never maintained by deltas.
 */

import {
  refKey,
  responseCounts,
  scriptCredentialHash,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type GovLink,
  type ResponseRecord,
  type SurveyRecord,
} from "cip-179/domain";
import { fromJsonSafe } from "cip-179/tally";
import type { KoiosDataSource } from "cardano-tessera-koios";

import { cancellationRowOf, responseRowOf, surveyRowsOf } from "./materialize";
import type { SlotRange, SnapshotMeta, SnapshotStore } from "./store";
import { validationKey } from "./store";

/** The stored-row reads and the one write a segment integration performs. */
export type IntegrateStore = Pick<
  SnapshotStore,
  | "responseRowsInSlotRange"
  | "cancellationRowsInSlotRange"
  | "cancellationRowsForSurveys"
  | "responseRowsForSurveys"
  | "surveyRowsByKeys"
  | "surveyGovLinks"
  | "staleCancelledSurveyKeys"
  | "reconcileSegment"
>;

export interface SegmentArgs {
  /** The segment scan's records. */
  readonly records: Cip179Records;
  /**
   * The slot range the scan safely covered — the sweep's deletion scope.
   * Null (incomplete scan, or nothing safely covered) upserts only.
   */
  readonly range: SlotRange | null;
  readonly tip: ChainTip;
  /** The full current link set (settled and unsettled epochs alike). */
  readonly govLinks: readonly GovLink[];
  /** False skips link-change detection: no link is comparable when all are unknown. */
  readonly govLinksReliable: boolean;
  /** Surveys a tally artifact finalized as cancelled (the overlay). */
  readonly finalizedCancelled: ReadonlySet<string>;
  readonly meta: SnapshotMeta;
}

export interface SegmentIntegration {
  /** Rows the reconcile changed (the envelope excluded). */
  readonly changes: number;
  /** Wire JSON bytes across the rows this run upserted — the growth metric. */
  readonly payloadBytes: number;
}

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Order-insensitive identity of a survey's link slice. */
const linkSliceText = (links: readonly GovLink[] | undefined): string =>
  JSON.stringify(
    [...(links ?? [])]
      .sort((a, b) => compareText(a.actionId, b.actionId))
      .map((l) => [l.actionId, l.endEpoch, l.surveyKey, l.title]),
  );

export async function integrateSegment(
  store: IntegrateStore,
  source: Pick<KoiosDataSource, "txProofs">,
  args: SegmentArgs,
): Promise<SegmentIntegration> {
  const { records, range, tip, govLinks, finalizedCancelled, meta } = args;
  const inRange = (slot: number): boolean =>
    range !== null && slot >= range.fromSlot && slot <= range.toSlot;

  // A stored row in the swept range that the segment listing lacks is about
  // to be deleted — a rollback — and its survey's aggregates must shed it.
  const preResponses = range ? await store.responseRowsInSlotRange(range) : [];
  const preCancels = range
    ? await store.cancellationRowsInSlotRange(range)
    : [];

  // A survey whose current link slice differs from its stored one re-projects
  // even when no tx touched it (links resolve out-of-band, a proposal can
  // roll back). Compared order-insensitively so scan-order jitter between
  // runs never churns rows.
  const currentLinks = new Map<string, GovLink[]>();
  for (const l of govLinks) {
    const list = currentLinks.get(l.surveyKey);
    if (list) list.push(l);
    else currentLinks.set(l.surveyKey, [l]);
  }
  const linkTouched: string[] = [];
  if (args.govLinksReliable) {
    const stored = await store.surveyGovLinks();
    for (const key of new Set([...stored.keys(), ...currentLinks.keys()])) {
      if (
        linkSliceText(stored.get(key)) !== linkSliceText(currentLinks.get(key))
      )
        linkTouched.push(key);
    }
  }

  const touched = new Set([
    ...records.surveys.map((s) => refKey(s.ref)),
    ...records.responses.map((r) => refKey(r.response.surveyRef)),
    ...records.cancellations.map((c) => refKey(c.target)),
    ...preResponses.map((r) => r.surveyKey),
    ...preCancels.map((r) => r.surveyKey),
    ...linkTouched,
    ...(await store.staleCancelledSurveyKeys(tip.epoch)),
  ]);

  // Definitions: the segment's records are authoritative for what they carry;
  // every other touched survey revives from its stored row. A stored
  // definition whose slot lies in the swept range but which the segment did
  // not re-list has rolled back — projecting it would resurrect the row the
  // sweep is about to delete.
  const segmentKeys = new Set(records.surveys.map((s) => refKey(s.ref)));
  const storedRecords = (
    await store.surveyRowsByKeys(
      [...touched].filter((k) => !segmentKeys.has(k)),
    )
  )
    .filter((row) => !inRange(row.slot))
    .map((row) => fromJsonSafe(JSON.parse(row.record)) as SurveyRecord);
  const touchedRecords = [...records.surveys, ...storedRecords];
  const defByKey = new Map(
    touchedRecords.map((s) => [refKey(s.ref), s.definition]),
  );
  const touchedKeys = [...defByKey.keys()];

  // The scan attaches cancellation owner-proofs only when the target survey
  // is in the same listing; a segment cancellation of an open survey defined
  // outside the segment still needs its evidence for the verified-cancelled
  // flag. Backed by the proof CBOR cache, so re-listed margin cancellations
  // cost no repeat fetch; best-effort — a miss stays an unverified claim and
  // the next margin re-derivation retries.
  const needProof = records.cancellations.filter((c) => {
    if (c.proof !== null) return false;
    const def = defByKey.get(refKey(c.target));
    return def !== undefined && tip.epoch <= def.endEpoch;
  });
  let cancellations = records.cancellations;
  if (needProof.length > 0) {
    const neededScripts = new Map<string, string[]>();
    for (const c of needProof) {
      const scriptHash = scriptCredentialHash(
        defByKey.get(refKey(c.target))!.owner,
      );
      if (!scriptHash) continue;
      const list = neededScripts.get(c.txHash);
      if (list) list.push(scriptHash);
      else neededScripts.set(c.txHash, [scriptHash]);
    }
    const proofs = await source
      .txProofs([...new Set(needProof.map((c) => c.txHash))], neededScripts)
      .catch((err) => {
        console.warn(`cancellation proof fetch failed: ${String(err)}`);
        return new Map<string, null>();
      });
    const attach = new Set(needProof);
    cancellations = records.cancellations.map((c) =>
      attach.has(c) ? { ...c, proof: proofs.get(c.txHash) ?? null } : c,
    );
  }

  // Aggregation inputs per touched survey: stored rows outside the swept
  // range (in-range ones are replaced by the segment's own listing, or gone),
  // merged with the segment's records.
  const segmentCancelKeys = new Set(
    cancellations.map((c) => `${c.txHash}|${refKey(c.target)}`),
  );
  const storedCancels = (await store.cancellationRowsForSurveys(touchedKeys))
    .filter(
      (row) =>
        !inRange(row.slot) &&
        !segmentCancelKeys.has(`${row.txHash}|${row.surveyKey}`),
    )
    .map((row) => fromJsonSafe(JSON.parse(row.record)) as CancellationRecord);
  const segmentResponseKeys = new Set(
    records.responses.map((r) => validationKey(r.txHash, r.responseIndex)),
  );
  const storedResponses = (await store.responseRowsForSurveys(touchedKeys))
    .filter(
      (row) =>
        !inRange(row.slot) &&
        !segmentResponseKeys.has(validationKey(row.txHash, row.responseIndex)),
    )
    .map((row) => fromJsonSafe(JSON.parse(row.record)) as ResponseRecord);

  const surveyRows = surveyRowsOf(
    touchedRecords,
    [...cancellations, ...storedCancels],
    responseCounts([...records.responses, ...storedResponses]),
    tip,
    govLinks,
    finalizedCancelled,
  );
  const responseRows = records.responses.map(responseRowOf);
  const cancellationRows = cancellations.map(cancellationRowOf);

  const changes = await store.reconcileSegment(
    range,
    surveyRows,
    responseRows,
    cancellationRows,
    meta,
  );
  return {
    changes,
    payloadBytes:
      surveyRows.reduce(
        (n, r) =>
          n + r.record.length + r.cancellations.length + r.govLinks.length,
        0,
      ) +
      responseRows.reduce((n, r) => n + r.record.length, 0) +
      cancellationRows.reduce((n, r) => n + r.record.length, 0),
  };
}
