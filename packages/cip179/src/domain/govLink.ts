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

import { SPEC_VERSION } from "../constants.js";

/** Anchor's declared `body.cip179.kind` for a survey link. */
export const GOV_LINK_KIND = "survey-link";

/** The four `body.cip179` sub-fields the `@context` MUST map (CIP-179 Change 3). */
const CIP179_SUBTERMS = [
  "specVersion",
  "kind",
  "surveyTxId",
  "surveyIndex",
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Whether a CIP-108 anchor's `@context` maps the CIP-179 terms so that a
 * `body.cip179` link survives JSON-LD/RDF canonicalization and is covered by the
 * author witness (CIP-179 linkage Change 3). The CIP-108 context sets no
 * `@vocab`, so an unmapped field is silently dropped during canonicalization —
 * readable in raw JSON yet outside the witness, the exact inconsistency the
 * spec's MUST forbids. This is an *authoring-side* check only: readers
 * (`parseCip179Link`) intentionally accept the raw-JSON link regardless.
 *
 * Requires: the `CIP179` namespace at the context root, a nested `body`
 * `@context`, and a `cip179` term there whose own `@context` maps every one of
 * the four sub-fields. Values need only be non-empty strings (the exact IRIs are
 * the author's to choose); presence is what canonicalization needs.
 */
export function anchorContextMapsCip179Terms(parsed: unknown): boolean {
  if (!isObject(parsed)) return false;
  const ctx = parsed["@context"];
  if (!isObject(ctx)) return false;
  // CIP179 namespace at the context root.
  if (typeof ctx["CIP179"] !== "string" || ctx["CIP179"].length === 0) {
    return false;
  }
  // `cip179` term (with its sub-context) inside the body context.
  if (!isObject(ctx["body"])) return false;
  const bodyCtx = (ctx["body"] as Record<string, unknown>)["@context"];
  if (!isObject(bodyCtx)) return false;
  const cipTerm = bodyCtx["cip179"];
  if (!isObject(cipTerm)) return false;
  const cipCtx = cipTerm["@context"];
  if (!isObject(cipCtx)) return false;
  return CIP179_SUBTERMS.every(
    (k) => typeof cipCtx[k] === "string" && (cipCtx[k] as string).length > 0,
  );
}

/** The survey a well-formed anchor links to (tx id lower-cased, output index). */
export interface SurveyRefLite {
  readonly txId: string;
  readonly index: number;
}

export interface Cip179LinkResult {
  /** The extracted ref — only non-null when the link is fully well-formed. */
  readonly surveyRef: SurveyRefLite | null;
  /**
   * The link's declared CIP-179 revision, or `null` when absent or not an
   * integer. Advisory: it tells a reader which revision's linkage semantics the
   * author wrote against, ahead of resolving the survey — but the survey's own
   * `spec_version` is what the decoder answers to, so a foreign value here never
   * withholds the ref. See {@link parseCip179Link}.
   */
  readonly specVersion: number | null;
  /** Human-readable shape problems; empty means a well-formed survey link. */
  readonly problems: string[];
}

/**
 * Validate the `body.cip179` survey link inside an already-parsed CIP-108
 * anchor object (e.g. `JSON.parse` of the fetched document, or an indexer's
 * own resolved copy of it).
 * Returns the ref only when every required field checks out, alongside any
 * problems for callers that show them. `surveyTxId` must be 64-char hex — a
 * malformed id can never address a real survey, so it's rejected rather than
 * turned into a bogus ref.
 *
 * `specVersion` is reported, never enforced: the spec's validation rules for a
 * link are the ref resolving, the epoch alignment and the `kind`, so a link
 * declaring another revision is still a link, and dropping it would silently
 * unlink a survey that a conformant reader keeps. It surfaces as a problem for
 * the authoring side, which has no reason to write anything but the current
 * revision.
 */
export function parseCip179Link(parsed: unknown): Cip179LinkResult {
  const none = (problems: string[]): Cip179LinkResult => ({
    surveyRef: null,
    specVersion: null,
    problems,
  });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return none(["Top level must be a JSON object."]);
  }
  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const body = obj["body"];
  if (typeof body !== "object" || body === null) {
    problems.push('Missing CIP-108 "body" object.');
    return none(problems);
  }
  const cip = (body as Record<string, unknown>)["cip179"];
  if (typeof cip !== "object" || cip === null) {
    problems.push('Missing "body.cip179" survey link.');
    return none(problems);
  }
  const link = cip as Record<string, unknown>;

  const declared = link["specVersion"];
  const specVersion =
    typeof declared === "number" && Number.isInteger(declared)
      ? declared
      : null;
  if (specVersion === null) {
    problems.push(
      `"body.cip179.specVersion" must be an integer (got ${JSON.stringify(declared)}).`,
    );
  } else if (specVersion !== SPEC_VERSION) {
    problems.push(
      `"body.cip179.specVersion" is ${specVersion}; this tool writes v${SPEC_VERSION}.`,
    );
  }
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

  // A ref is extracted only when the whole *addressing* checks out — the
  // discovery layer treats a non-null ref as "this is a survey link", so a wrong
  // `kind` or malformed id must yield null, not a partial ref. `specVersion` is
  // deliberately not part of that conjunction.
  const surveyRef =
    kindOk && txOk && indexOk
      ? { txId: (txId as string).toLowerCase(), index: index as number }
      : null;
  return { surveyRef, specVersion, problems };
}

/**
 * What an anchor document contributes to a {@link GovLink}: the survey it
 * names and the CIP-108 title to show for it. The rest of a link — which
 * action carries it, and when that action expires — is the action's own
 * on-chain identity, not the document's.
 *
 * Keeping the two apart is what makes a classification addressable by anchor
 * hash: the same document behind two actions yields the same `GovLinkDoc`, and
 * a reader that has verified those bytes once never needs to fetch them again.
 */
export interface GovLinkDoc {
  /** Survey ref the document links to ("<txHex>:<index>"). */
  readonly surveyKey: string;
  /** The action's title from CIP-108 `body.title`, if present. */
  readonly title: string | null;
}

/**
 * Classify a governance action's anchor document: the survey link it carries,
 * or `null` for a document that carries none. Callers reach this with a
 * document they trust — parsed from bytes verified against the anchor hash, or
 * resolved by an indexer they accept — since nothing here re-checks provenance.
 */
export function parseGovLinkDoc(doc: unknown): GovLinkDoc | null {
  // Shared shape validation (single source of truth with the proposal builder);
  // here we need only the ref — a missing/malformed link yields null.
  const { surveyRef } = parseCip179Link(doc);
  if (!surveyRef) return null;

  // TODO(govlink-title-trust): `title` is attacker-controlled off-chain anchor
  // JSON. It's escaped before render (no XSS), and epoch-alignment is enforced,
  // but the title's *content* is not authenticated — a malicious Info Action can
  // claim e.g. "Official Cardano Foundation Poll" to lend a survey false
  // authority. The UI currently shows it as "Advertised by {title}". Later:
  // present it as unverified (length-clamp + an explicit caveat) and soften the
  // "Advertised by" wording so it doesn't overstate verification.
  //
  // A non-null ref means `parseCip179Link` already walked `body.cip179`, so the
  // body is an object here.
  const body = (doc as { body: Record<string, unknown> }).body;
  const title = typeof body["title"] === "string" ? body["title"] : null;

  return { surveyKey: `${surveyRef.txId}:${surveyRef.index}`, title };
}
