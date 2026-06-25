/**
 * Shared validation for the CIP-179 survey link carried by a Conway Info
 * Action's CIP-108 anchor. The link lives at `body.cip179`, is tagged
 * `kind: "survey-link"`, and points at a survey via `surveyTxId`/`surveyIndex`.
 *
 * Two call sites validate the *same* shape and must agree on what counts as a
 * link: the discovery layer (`parseGovLink` in {@link "~/data/koios"}, which
 * just needs the ref) and the proposal builder (`ProposeInfoAction`, which
 * surfaces per-field problems). This module is the single source of truth so
 * the two can't drift — pure, no I/O, unit-testable.
 */

/** Anchor's declared `body.cip179.kind` for a survey link. */
export const GOV_LINK_KIND = "survey-link";

/** The survey a well-formed anchor links to (tx id lower-cased, output index). */
export interface SurveyRefLite {
  readonly txId: string;
  readonly index: number;
}

export interface Cip179LinkResult {
  /** The extracted ref — only non-null when the link is fully well-formed. */
  readonly surveyRef: SurveyRefLite | null;
  /** Human-readable shape problems; empty means a well-formed survey link. */
  readonly problems: string[];
}

/**
 * Validate the `body.cip179` survey link inside an already-parsed CIP-108
 * anchor object (e.g. Koios `meta_json`, or `JSON.parse` of a loaded file).
 * Returns the ref only when every required field checks out, alongside any
 * problems for callers that show them. `surveyTxId` must be 64-char hex — a
 * malformed id can never address a real survey, so it's rejected rather than
 * turned into a bogus ref.
 */
export function parseCip179Link(parsed: unknown): Cip179LinkResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { surveyRef: null, problems: ["Top level must be a JSON object."] };
  }
  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const body = obj["body"];
  if (typeof body !== "object" || body === null) {
    problems.push('Missing CIP-108 "body" object.');
    return { surveyRef: null, problems };
  }
  const cip = (body as Record<string, unknown>)["cip179"];
  if (typeof cip !== "object" || cip === null) {
    problems.push('Missing "body.cip179" survey link.');
    return { surveyRef: null, problems };
  }
  const link = cip as Record<string, unknown>;
  const kindOk = link["kind"] === GOV_LINK_KIND;
  if (!kindOk) {
    problems.push(
      `"body.cip179.kind" must be "${GOV_LINK_KIND}" (got ${JSON.stringify(link["kind"])}).`,
    );
  }
  const txId = link["surveyTxId"];
  const txOk = typeof txId === "string" && /^[0-9a-fA-F]{64}$/.test(txId);
  if (!txOk) {
    problems.push(
      '"body.cip179.surveyTxId" must be a 64-char hex transaction id.',
    );
  }
  const index = link["surveyIndex"];
  const indexOk =
    typeof index === "number" && Number.isInteger(index) && index >= 0;
  if (!indexOk) {
    problems.push('"body.cip179.surveyIndex" must be a non-negative integer.');
  }

  // A ref is extracted only when the whole link checks out — the discovery
  // layer treats a non-null ref as "this is a survey link", so a wrong `kind`
  // or malformed id must yield null, not a partial ref.
  const surveyRef =
    kindOk && txOk && indexOk
      ? { txId: (txId as string).toLowerCase(), index: index as number }
      : null;
  return { surveyRef, problems };
}
