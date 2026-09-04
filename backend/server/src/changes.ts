/**
 * The change selection's cursor (`GET /api/surveys?changes=<cursor>`): two
 * keyset positions, one per axis the selection reads — survey rows in
 * `(changed_at, survey_key)` order, tombstones in `(deleted_at, survey_key)`
 * order — so the two stay separate keyed reads with no union and no sort.
 * Minted by the server, opaque to the consumer, which stores the string and
 * hands it back. It carries no generation to compare against the snapshot:
 * both axes are read at or below the generation published when the request
 * arrives, so a refresh landing mid-walk is invisible to it.
 */

/**
 * A position on one axis: strictly after `key` at `stamp`, or — with a null
 * key — everything at or below `stamp`. The second form is where an axis
 * lands when a page came back short: exhausted up to the published
 * generation, so a quiet corpus never ages a cursor.
 */
export interface AxisPosition {
  readonly stamp: number;
  readonly key: string | null;
}

export interface ChangesCursor {
  readonly rows: AxisPosition;
  readonly removed: AxisPosition;
}

/**
 * Both axes exhausted at `generation` — what a paged list answer hands a
 * consumer as `changesCursor`, so a full walk that finished at one generation
 * continues as a delta from there.
 */
export const changesCursorAt = (generation: number): ChangesCursor => ({
  rows: { stamp: generation, key: null },
  removed: { stamp: generation, key: null },
});

const KEY = "[0-9a-f]{64}:(?:0|[1-9][0-9]*)";
const AXIS = `(\\d+)\\.(${KEY}|-)`;
const CURSOR_RE = new RegExp(`^${AXIS}\\.${AXIS}$`);

const encodeAxis = (p: AxisPosition): string => `${p.stamp}.${p.key ?? "-"}`;

const parseAxis = (stamp: string, key: string): AxisPosition => ({
  stamp: Number(stamp),
  key: key === "-" ? null : key,
});

/** Wire form "<stamp>.<key|->.<stamp>.<key|->": the rows axis, then the removed axis. */
export const encodeChangesCursor = (c: ChangesCursor): string =>
  `${encodeAxis(c.rows)}.${encodeAxis(c.removed)}`;

export function parseChangesCursor(s: string): ChangesCursor | null {
  const m = CURSOR_RE.exec(s);
  if (!m) return null;
  return {
    rows: parseAxis(m[1]!, m[2]!),
    removed: parseAxis(m[3]!, m[4]!),
  };
}

/**
 * Where an axis stands after a page read with `limit + 1` items requested:
 * on the page's last item when more followed, at `publishedAt` when the axis
 * is exhausted up to it.
 */
export function advanceAxis(
  items: readonly { readonly stamp: number; readonly key: string }[],
  limit: number,
  publishedAt: number,
): AxisPosition {
  const last = items.length > limit ? items[limit - 1] : undefined;
  return last
    ? { stamp: last.stamp, key: last.key }
    : { stamp: publishedAt, key: null };
}
