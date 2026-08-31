/**
 * The document layer for linking a survey to a governance action: build or
 * modify a CIP-108 governance-metadata document so its `body.cip179` carries
 * the CIP-179 survey link (spec v5), and own the emitted bytes.
 *
 * Pure and action-kind-independent — any governance action kind may carry a
 * link. The serialization here is the *exact* byte sequence that gets hashed
 * (blake2b-256), downloaded and pinned; the on-chain anchor commits to those
 * bytes, so any re-formatting after emission invalidates the hash.
 *
 * @module
 */

import { blake2b } from "@noble/hashes/blake2.js";

import { SPEC_VERSION } from "cip-179";
import {
  GOV_LINK_KIND,
  anchorContextMapsCip179Terms,
  bytesToHex,
  parseCip179Link,
  type SurveyRefLite,
} from "cip-179/domain";

import { t, n } from "~/i18n";

// ----------------------------------------------------------------------------
// Emitting a linked document
// ----------------------------------------------------------------------------

/** The CIP-179 namespace the emitted `@context`s point at. */
const CIP179_IRI =
  "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0179/README.md#";

/**
 * The `cip179` term mapping (CIP-179 linkage Change 3). The CIP-108 context
 * sets no `@vocab`, so without these mappings the link is silently dropped
 * during JSON-LD/RDF canonicalization and falls outside the author witness —
 * readable in raw JSON yet unwitnessed. `anchorContextMapsCip179Terms` is the
 * matching validator.
 */
const CIP179_TERM = {
  "@id": "CIP179:link",
  "@context": {
    specVersion: "CIP179:specVersion",
    kind: "CIP179:kind",
    surveyTxId: "CIP179:surveyTxId",
    surveyIndex: "CIP179:surveyIndex",
  },
} as const;

function surveyLinkObject(ref: SurveyRefLite) {
  return {
    specVersion: SPEC_VERSION,
    kind: GOV_LINK_KIND,
    surveyTxId: ref.txId,
    surveyIndex: ref.index,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The one serialization for every document this module emits — both entry
 * paths converge on these bytes, and they are what gets hashed and hosted.
 */
function serializeAnchor(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** The four CIP-108 body fields the from-scratch form collects. */
export interface AnchorBodyFields {
  readonly title: string;
  readonly abstract: string;
  readonly motivation: string;
  readonly rationale: string;
}

/**
 * A minimal, already-linked CIP-108 document from the four body fields. The
 * `@context` is the CIP-108 specification's own (so the base half can be
 * diffed against the spec example verbatim) plus the CIP-179 terms. `authors`
 * is present and empty: CIP-100 requires the field, and an unwitnessed anchor
 * is valid on-chain.
 */
export function buildLinkedAnchor(
  fields: AnchorBodyFields,
  ref: SurveyRefLite,
): string {
  return serializeAnchor({
    "@context": {
      "@language": "en-us",
      CIP100:
        "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#",
      CIP108:
        "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0108/README.md#",
      CIP179: CIP179_IRI,
      hashAlgorithm: "CIP100:hashAlgorithm",
      body: {
        "@id": "CIP108:body",
        "@context": {
          references: {
            "@id": "CIP108:references",
            "@container": "@set",
            "@context": {
              GovernanceMetadata: "CIP100:GovernanceMetadataReference",
              Other: "CIP100:OtherReference",
              label: "CIP100:reference-label",
              uri: "CIP100:reference-uri",
              referenceHash: {
                "@id": "CIP108:referenceHash",
                "@context": {
                  hashDigest: "CIP108:hashDigest",
                  hashAlgorithm: "CIP100:hashAlgorithm",
                },
              },
            },
          },
          title: "CIP108:title",
          abstract: "CIP108:abstract",
          motivation: "CIP108:motivation",
          rationale: "CIP108:rationale",
          cip179: CIP179_TERM,
        },
      },
      authors: {
        "@id": "CIP100:authors",
        "@container": "@set",
        "@context": {
          name: "http://xmlns.com/foaf/0.1/name",
          witness: {
            "@id": "CIP100:witness",
            "@context": {
              witnessAlgorithm: "CIP100:witnessAlgorithm",
              publicKey: "CIP100:publicKey",
              signature: "CIP100:signature",
            },
          },
        },
      },
    },
    hashAlgorithm: "blake2b-256",
    authors: [],
    body: {
      title: fields.title,
      abstract: fields.abstract,
      motivation: fields.motivation,
      rationale: fields.rationale,
      cip179: surveyLinkObject(ref),
    },
  });
}

export type InjectResult =
  | {
      readonly ok: true;
      /** The re-serialized document — the only bytes to hash and host. */
      readonly text: string;
      /** An `authors` witness was removed; the document needs re-signing. */
      readonly strippedAuthors: boolean;
    }
  | { readonly ok: false; readonly reason: "notJson"; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: "notObject" | "noBody" | "noContext";
    }
  | {
      readonly ok: false;
      readonly reason: "alreadyLinked";
      /** The survey the input already links, when its link is well-formed. */
      readonly linkedRef: SurveyRefLite | null;
    };

/**
 * Insert the survey link into a CIP-108 document produced by external
 * governance tooling: parse, empty `authors` (any witness signed the unlinked
 * body and can't survive the edit), set `body.cip179`, merge the CIP-179 terms
 * into the `@context`, re-serialize.
 *
 * Refuses an input that already carries `body.cip179`: external tooling never
 * emits that field, so its presence means a double-run or a hand-edit — worth
 * reporting, not overwriting. Also refuses anything that isn't a CIP-108
 * document (no `body`, no `@context` to merge into).
 */
export function injectSurveyLink(
  text: string,
  ref: SurveyRefLite,
): InjectResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: "notJson", detail: (e as Error).message };
  }
  if (!isObject(parsed)) return { ok: false, reason: "notObject" };
  const body = parsed["body"];
  if (!isObject(body)) return { ok: false, reason: "noBody" };
  const ctx = parsed["@context"];
  if (!isObject(ctx)) return { ok: false, reason: "noContext" };
  if (body["cip179"] !== undefined) {
    return {
      ok: false,
      reason: "alreadyLinked",
      linkedRef: parseCip179Link(parsed).surveyRef,
    };
  }
  const authors = parsed["authors"];
  const strippedAuthors =
    authors !== undefined && !(Array.isArray(authors) && authors.length === 0);
  if (authors !== undefined) parsed["authors"] = [];
  body["cip179"] = surveyLinkObject(ref);
  mergeCip179Context(ctx);
  return { ok: true, text: serializeAnchor(parsed), strippedAuthors };
}

/**
 * Merge the CIP-179 term mappings into an existing document's `@context`:
 * the `CIP179` namespace at the root and the `cip179` term inside the body
 * context. A `body` mapped as a plain string (`"CIP108:body"`) is promoted to
 * the object form so it can hold the nested context; everything already there
 * is preserved.
 */
function mergeCip179Context(ctx: Record<string, unknown>): void {
  ctx["CIP179"] = CIP179_IRI;
  const prior = ctx["body"];
  const body: Record<string, unknown> = isObject(prior)
    ? prior
    : { "@id": typeof prior === "string" ? prior : "CIP108:body" };
  const priorCtx = body["@context"];
  const bodyCtx: Record<string, unknown> = isObject(priorCtx) ? priorCtx : {};
  bodyCtx["cip179"] = CIP179_TERM;
  body["@context"] = bodyCtx;
  ctx["body"] = body;
}

// ----------------------------------------------------------------------------
// The prepared anchor: exact bytes, hash, validation
// ----------------------------------------------------------------------------

/**
 * A prepared anchor document: the *exact* bytes (what the on-chain hash
 * commits to and what gets served), their blake2b-256 hash, the text for
 * display, the survey ref pulled from `body.cip179`, and any shape problems
 * found while validating it.
 */
export interface LoadedAnchor {
  readonly fileName: string;
  // Backed by a plain ArrayBuffer, so it's a valid BlobPart for a download —
  // not a SharedArrayBuffer-backed view.
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly text: string;
  readonly hash: Uint8Array;
  readonly hashHex: string;
  readonly surveyRef: SurveyRefLite | null;
  /** Human-readable shape problems; empty means a well-formed survey link. */
  readonly problems: readonly string[];
}

/**
 * Wrap emitted document text as a {@link LoadedAnchor}: encode it (UTF-8),
 * hash the encoding, and validate the shape. Emitted documents should always
 * validate clean — the check is the belt that keeps the generator and the
 * validators from drifting apart.
 */
export function anchorFromText(fileName: string, text: string): LoadedAnchor {
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const hash = blake2b(bytes, { dkLen: 32 });
  const { surveyRef, problems } = validateAnchorShape(text);
  return {
    fileName,
    bytes,
    text,
    hash,
    hashHex: bytesToHex(hash),
    surveyRef,
    problems,
  };
}

/**
 * Validate a document against the CIP-108 + CIP-179 shape the discovery layer
 * (`parseGovLink`) requires, and pull out the survey ref. The rules mirror
 * `parseGovLink`, so what passes here is exactly what tooling will later treat
 * as a link — but with per-issue messages for the UI. Returns the ref (only when
 * the link is well-formed) plus any problems.
 */
export function validateAnchorShape(text: string): {
  surveyRef: SurveyRefLite | null;
  problems: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      surveyRef: null,
      problems: [
        t("proposeInfoAction.problemNotJson", {
          message: (e as Error).message,
        }),
      ],
    };
  }
  // The survey-link shape itself is validated by the shared parser (single
  // source of truth with the discovery layer).
  const result = parseCip179Link(parsed);
  const hasContext = isObject(parsed) && isObject(parsed["@context"]);
  if (!hasContext) {
    // The discovery layer doesn't require a `@context`, but a linking anchor is
    // a JSON-LD document and needs one — flag its absence.
    result.problems.unshift(t("proposeInfoAction.problemMissingContext"));
  } else {
    // CIP-179 linkage: when the doc carries a `body.cip179` link, its
    // `@context` MUST map the CIP-179 terms, or the link is dropped during RDF
    // canonicalization and falls outside the author witness — readable in raw
    // JSON yet unwitnessed. Block that, since the reader side won't catch it.
    const body = isObject(parsed) ? parsed["body"] : undefined;
    const hasLink = isObject(body) && isObject(body["cip179"]);
    if (hasLink && !anchorContextMapsCip179Terms(parsed)) {
      result.problems.unshift(
        t("proposeInfoAction.problemContextMissingCip179Terms"),
      );
    }
  }
  return result;
}

/**
 * Read a chosen file as raw bytes (never re-encoded), hash it, and parse the
 * survey ref. Reading the bytes verbatim is what keeps the on-chain hash valid
 * against the document that later gets pinned/hosted. Throws if the file can't
 * be read.
 */
export async function loadAnchorFile(file: File): Promise<LoadedAnchor> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const hash = blake2b(bytes, { dkLen: 32 });
  const { surveyRef, problems } = validateAnchorShape(text);
  return {
    fileName: file.name,
    bytes,
    text,
    hash,
    hashHex: bytesToHex(hash),
    surveyRef,
    problems,
  };
}

// ----------------------------------------------------------------------------
// Epoch alignment
// ----------------------------------------------------------------------------

/** The three alignment severities, matching {@link Note}'s `kind` values. */
export type AlignmentLevel = "ok" | "warn" | "danger";

/**
 * Whether an anchor's linked survey aligns in time with the action that will
 * carry it. An action submitted in the current epoch gets an expiry epoch of
 * `tip.epoch + gov_action_lifetime` — the ledger rule is identical for every
 * proposal kind — and the discovery layer links a survey only when its
 * `end_epoch` equals that expiry. So the two align exactly when the action is
 * submitted in epoch `survey.end_epoch − gov_action_lifetime`.
 *
 * Returns `null` when the anchor carries no link (nothing to align). The copy is
 * phrased around "your governance action", so it fits any action kind.
 */
export function computeAlignment(params: {
  hasLink: boolean;
  tip: { epoch: number; govActionLifetime: number } | undefined;
  surveyEndEpoch: number | undefined;
}): { level: AlignmentLevel; text: string } | null {
  if (!params.hasLink) return null; // no link → nothing to align
  const { tip } = params;
  if (!tip)
    return { level: "warn", text: t("proposeInfoAction.alignTipNotLoaded") };
  if (params.surveyEndEpoch === undefined)
    return {
      level: "warn",
      text: t("proposeInfoAction.alignSurveyNotOnchain"),
    };
  const lifetime = tip.govActionLifetime;
  if (lifetime <= 0)
    return {
      level: "warn",
      text: t("proposeInfoAction.alignLifetimeUnknown"),
    };
  const surveyEnd = params.surveyEndEpoch;
  const deadlineIfNow = tip.epoch + lifetime;
  const submitEpoch = surveyEnd - lifetime;
  if (deadlineIfNow === surveyEnd)
    return {
      level: "ok",
      text: t("proposeInfoAction.alignAligned", {
        epoch: tip.epoch,
        end: surveyEnd,
      }),
    };
  if (tip.epoch < submitEpoch)
    return {
      level: "danger",
      text: t("proposeInfoAction.alignTooEarly", {
        submitEpoch,
        remaining: n(submitEpoch - tip.epoch),
        end: surveyEnd,
        deadline: deadlineIfNow,
      }),
    };
  return {
    level: "danger",
    text: t("proposeInfoAction.alignWindowPassed", {
      end: surveyEnd,
      submitEpoch,
      epoch: tip.epoch,
      deadline: deadlineIfNow,
    }),
  };
}
