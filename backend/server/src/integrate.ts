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
 *
 * Governance links are the one input that is not always re-derived: this
 * refresh's pass covers only the epochs whose links can still move, and below
 * that horizon a survey's own stored slice is the frozen answer, carried
 * through every re-projection. That is what keeps the pass — and this
 * module's link read — bounded by the live surveys rather than by every
 * survey ever run. A survey the segment carries but no row holds is the one
 * case with no slice to carry: the settled epoch memo still has its links.
 */

import {
  refKey,
  scriptCredentialHash,
  type CancellationRecord,
  type ChainTip,
  type Cip179Records,
  type GovLink,
  type SurveyRecord,
} from "cip-179/domain";
import { fromJsonSafe } from "cip-179/tally";
import type { KoiosDataSource } from "cardano-tessera-koios";

import { cancellationRowOf, responseRowOf, surveyRowsOf } from "./materialize";
import type {
  GovLinkStore,
  ResponseCountBank,
  ResponseRow,
  SettledGovEpoch,
  SlotRange,
  SnapshotMeta,
  SnapshotStore,
  StoredResponse,
  TallyStore,
} from "./store";
import { responseIdentityKey, validationKey } from "./store";

/** The stored-row reads and the one write a segment integration performs. */
export type IntegrateStore = Pick<
  SnapshotStore,
  | "responsesInSlotRange"
  | "cancellationRowsInSlotRange"
  | "cancellationRowsForSurveys"
  | "responseIdentitiesFrom"
  | "settledResponseKeys"
  | "responseCountBanks"
  | "surveyRowsByKeys"
  | "surveyGovLinks"
  | "staleCancelledSurveyKeys"
  | "reconcileSegment"
> &
  Pick<GovLinkStore, "settledGovEpochs"> &
  Pick<TallyStore, "artifactKeysFor">;

/** What one refresh's governance pass answered, as integration reads it. */
export interface GovPass {
  /** The links it resolved. */
  readonly links: readonly GovLink[];
  /**
   * The end epochs it asked about — where {@link links} is authoritative. A
   * touched survey outside it carries its stored slice through untouched: its
   * epoch is settled, so the row already holds the final answer.
   */
  readonly scope: ReadonlySet<number>;
  /** The settlement floor it ran against — the link diff's horizon. */
  readonly floor: number;
}

export interface SegmentArgs {
  /** The segment scan's records. */
  readonly records: Cip179Records;
  /**
   * The slot range the scan safely covered — the sweep's deletion scope.
   * Null (incomplete scan, or nothing safely covered) upserts only.
   */
  readonly range: SlotRange | null;
  readonly tip: ChainTip;
  /**
   * This refresh's governance pass, or null when it asked nothing: a failed
   * fetch, or a second integration riding on what the first one already
   * wrote. Every touched survey is then its own link source and no
   * link-change diff runs — nothing was re-read, so nothing may change.
   */
  readonly govPass: GovPass | null;
  /**
   * The run's settlement horizon: no response row below this slot can be
   * added, replaced or deleted by this run's main segment or any later one
   * (only the drift-healing rescan reaches below it, and it recounts what it
   * touches from scratch). Recounted surveys bank their settled count as of
   * this slot.
   */
  readonly settledBelowSlot: number;
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
  const { records, range, tip, govPass, settledBelowSlot, meta } = args;
  const inRange = (slot: number): boolean =>
    range !== null && slot >= range.fromSlot && slot <= range.toSlot;

  // A stored row in the swept range that the segment listing lacks is about
  // to be deleted — a rollback — and its survey's aggregates must shed it.
  const preResponses = range ? await store.responsesInSlotRange(range) : [];
  const preCancels = range
    ? await store.cancellationRowsInSlotRange(range)
    : [];

  // A survey whose current link slice differs from its stored one re-projects
  // even when no tx touched it (links resolve out-of-band, a proposal can
  // roll back). Compared order-insensitively so scan-order jitter between
  // runs never churns rows.
  const currentLinks = new Map<string, GovLink[]>();
  for (const l of govPass?.links ?? []) {
    const list = currentLinks.get(l.surveyKey);
    if (list) list.push(l);
    else currentLinks.set(l.surveyKey, [l]);
  }
  const linkTouched: string[] = [];
  if (govPass) {
    // Only an unsettled epoch's links can move, so the stored side of the
    // diff stops at the settlement horizon.
    const stored = await store.surveyGovLinks(Math.max(0, govPass.floor - 1));
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
  const storedRows = await store.surveyRowsByKeys([...touched]);
  const rowByKey = new Map(storedRows.map((row) => [row.surveyKey, row]));
  const storedRecords = storedRows
    .filter((row) => !segmentKeys.has(row.surveyKey) && !inRange(row.slot))
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
  const responseRows = records.responses.map(responseRowOf);
  const { countByKey, banks } = await responderCounts(
    store,
    touchedKeys,
    responseRows,
    range,
    preResponses,
    settledBelowSlot,
  );

  // A touched survey below the horizon with no row at all is one this segment
  // resurrects — a row lost out-of-band, which the drift-healing rescan walks
  // back into existence. There is no slice to carry forward, so the epoch memo
  // the slice was projected from is read instead; a survey whose epoch has not
  // settled yet is left unlinked and the next pass, which now sees its row,
  // puts its links back.
  const rowless = touchedRecords.filter(
    (s) =>
      !govPass?.scope.has(s.definition.endEpoch) &&
      !rowByKey.has(refKey(s.ref)),
  );
  const revived =
    rowless.length > 0
      ? await store.settledGovEpochs([
          ...new Set(rowless.map((s) => s.definition.endEpoch + 1)),
        ])
      : new Map<number, SettledGovEpoch>();

  // Links per touched survey: this refresh's, for the epochs it asked about;
  // the row's own frozen slice for the rest. Settled links are not re-derived
  // from the epoch memo on every pass — the projection they landed in IS the
  // copy, which is what bounds the pass to the epochs still in motion.
  const projectedLinks = touchedRecords.flatMap((s) => {
    const key = refKey(s.ref);
    if (govPass?.scope.has(s.definition.endEpoch))
      return currentLinks.get(key) ?? [];
    const row = rowByKey.get(key);
    if (row) return JSON.parse(row.govLinks) as GovLink[];
    return (revived.get(s.definition.endEpoch + 1)?.links ?? []).filter(
      (l) => l.surveyKey === key,
    );
  });

  // The finalized-cancelled overlay, read keyed by the touched surveys: the
  // artifact is the durable fact, so a re-derived row — a resurrected one
  // included — carries the flag whether or not the stored row did.
  const finalizedCancelled = (await store.artifactKeysFor(touchedKeys))
    .cancelled;
  const surveyRows = surveyRowsOf(
    touchedRecords,
    [...cancellations, ...storedCancels],
    countByKey,
    tip,
    projectedLinks,
    finalizedCancelled,
  );
  const cancellationRows = cancellations.map(cancellationRowOf);

  const changes = await store.reconcileSegment(
    range,
    surveyRows,
    responseRows,
    cancellationRows,
    banks,
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

/**
 * The touched surveys' responder counts — distinct (role, credential) keys
 * over each survey's response set — and the banks they write.
 *
 * Every touched survey is recounted, so a drifted count heals like any other
 * re-derived column; what varies is how much of the survey the recount reads.
 * A survey whose banked settled count still holds — the bank's slot is at or
 * below the run's horizon and below every row this integration adds,
 * replaces or deletes for it — is recounted from the bank plus the rows at or
 * above its slot: a keyed range read for the window's identities and one
 * index probe per key not yet seen. Any other survey — a change below its
 * bank (a rescan healing a settled row), a rewind, a survey never banked — is
 * recounted from all its identity rows. Either way no record is read, and the
 * recount banks its settled count as of the run's horizon.
 */
async function responderCounts(
  store: Pick<
    IntegrateStore,
    "responseIdentitiesFrom" | "settledResponseKeys" | "responseCountBanks"
  >,
  touchedKeys: readonly string[],
  segmentRows: readonly ResponseRow[],
  range: SlotRange | null,
  storedInRange: readonly StoredResponse[],
  settledBelowSlot: number,
): Promise<{
  countByKey: Record<string, number>;
  banks: ResponseCountBank[];
}> {
  const inRange = (slot: number): boolean =>
    range !== null && slot >= range.fromSlot && slot <= range.toSlot;
  const bySurvey = <T extends { surveyKey: string }>(
    rows: readonly T[],
  ): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const row of rows) {
      const list = out.get(row.surveyKey);
      if (list) list.push(row);
      else out.set(row.surveyKey, [row]);
    }
    return out;
  };
  const segmentBySurvey = bySurvey(segmentRows);
  const storedBySurvey = bySurvey(storedInRange);
  const rowKey = (r: StoredResponse): string =>
    validationKey(r.txHash, r.responseIndex);

  // The lowest slot at which this integration changes a survey's response
  // set: a segment row that is new or sits at another slot than its stored
  // counterpart (a response is content-addressed, so only its position can
  // differ — at either position), or a stored in-range row the segment no
  // longer lists (about to be swept). Infinity when nothing moves. With no
  // swept range the stored counterparts are unknown, so any segment row for
  // the survey counts as a change from the bottom.
  const lowestChange = (key: string): number => {
    const segment = segmentBySurvey.get(key) ?? [];
    if (range === null) return segment.length > 0 ? 0 : Infinity;
    const stored = new Map(
      (storedBySurvey.get(key) ?? []).map((r) => [rowKey(r), r]),
    );
    const listed = new Set(segment.map(rowKey));
    let lowest = Infinity;
    for (const r of segment) {
      const before = stored.get(rowKey(r));
      if (before === undefined) lowest = Math.min(lowest, r.slot);
      else if (before.slot !== r.slot)
        lowest = Math.min(lowest, r.slot, before.slot);
    }
    for (const [k, r] of stored)
      if (!listed.has(k)) lowest = Math.min(lowest, r.slot);
    return lowest;
  };

  const bankByKey = await store.responseCountBanks(touchedKeys);
  const usable = (key: string): ResponseCountBank | null => {
    const bank = bankByKey.get(key);
    return bank &&
      bank.belowSlot <= settledBelowSlot &&
      bank.belowSlot <= lowestChange(key)
      ? bank
      : null;
  };
  const stored = bySurvey(
    await store.responseIdentitiesFrom(
      touchedKeys.map((key) => ({
        surveyKey: key,
        fromSlot: usable(key)?.belowSlot ?? 0,
      })),
    ),
  );

  // Per survey: each identity key's lowest slot across the stored rows read
  // (in-range ones excluded — replaced by the segment or gone) and the
  // segment's own rows.
  type Seen = { role: number; credential: string; slot: number };
  const windows = new Map<string, Map<string, Seen>>();
  for (const key of touchedKeys) {
    const keys = new Map<string, Seen>();
    for (const r of [
      ...(stored.get(key) ?? []).filter((r) => !inRange(r.slot)),
      ...(segmentBySurvey.get(key) ?? []),
    ]) {
      const id = responseIdentityKey(r.role, r.credential);
      const seen = keys.get(id);
      if (!seen || r.slot < seen.slot)
        keys.set(id, { role: r.role, credential: r.credential, slot: r.slot });
    }
    windows.set(key, keys);
  }

  // Against a bank, a window key counts as new only if the survey holds no
  // row with it below the bank's slot.
  const settledKeys = await store.settledResponseKeys(
    touchedKeys.flatMap((key) => {
      const bank = usable(key);
      return bank
        ? [
            {
              surveyKey: key,
              belowSlot: bank.belowSlot,
              keys: [...windows.get(key)!.values()],
            },
          ]
        : [];
    }),
  );

  const countByKey: Record<string, number> = {};
  const banks: ResponseCountBank[] = [];
  for (const key of touchedKeys) {
    const bank = usable(key);
    const present = settledKeys.get(key) ?? new Set<string>();
    const fresh = [...windows.get(key)!.entries()].filter(
      ([id]) => !bank || !present.has(id),
    );
    const base = bank?.settledCount ?? 0;
    countByKey[key] = base + fresh.length;
    banks.push({
      surveyKey: key,
      settledCount:
        base + fresh.filter(([, k]) => k.slot < settledBelowSlot).length,
      belowSlot: settledBelowSlot,
    });
  }
  return { countByKey, banks };
}
