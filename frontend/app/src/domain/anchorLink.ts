/**
 * Kind-independent helpers for preparing a CIP-179 survey-linking anchor.
 *
 * A survey link lives in a CIP-108 governance-metadata document's `body.cip179`
 * (CIP-179 v5), and *any* governance action kind may carry it. Everything here —
 * shape validation, byte-exact hashing, epoch alignment — is about the anchor
 * document itself, independent of which action later references it. Tessera's
 * Info-Action helper uses these, but so can anyone linking a survey from an
 * action they build with other tooling: they load the same document, get the
 * same hash and the same alignment verdict.
 *
 * @module
 */

import { blake2b } from "@noble/hashes/blake2.js";

import {
  anchorContextMapsCip179Terms,
  bytesToHex,
  parseCip179Link,
  type SurveyRefLite,
} from "cip-179/domain";

import { t, n } from "~/i18n";

/**
 * An anchor document loaded from disk: the *exact* bytes (what the on-chain hash
 * commits to and what gets served), their blake2b-256 hash, the decoded text for
 * display, the survey ref pulled from `body.cip179`, and any shape problems
 * found while validating it.
 */
export interface LoadedAnchor {
  readonly fileName: string;
  // Backed by a plain ArrayBuffer (from File.arrayBuffer), so it's a valid
  // BlobPart for a download — not a SharedArrayBuffer-backed view.
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly text: string;
  readonly hash: Uint8Array;
  readonly hashHex: string;
  readonly surveyRef: SurveyRefLite | null;
  /** Human-readable shape problems; empty means a well-formed survey link. */
  readonly problems: readonly string[];
}

/**
 * Validate a document against the CIP-108 + CIP-179 shape the discovery layer
 * (`parseGovLink`) requires, and pull out the survey ref. The rules mirror
 * `parseGovLink`, so what passes here is exactly what tooling will later treat
 * as a link — but with per-issue messages for the UI. Returns the ref (only when
 * the link is well-formed) plus any problems. Action-kind-independent.
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
  const obj =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const hasContext =
    obj !== null &&
    typeof obj["@context"] === "object" &&
    obj["@context"] !== null;
  if (!hasContext) {
    // The discovery layer doesn't require a `@context`, but a linking anchor is
    // a JSON-LD document and needs one — flag its absence.
    result.problems.unshift(t("proposeInfoAction.problemMissingContext"));
  } else {
    // CIP-179 linkage: when the doc carries a `body.cip179` link, its
    // `@context` MUST map the CIP-179 terms, or the link is dropped during RDF
    // canonicalization and falls outside the author witness — readable in raw
    // JSON yet unwitnessed. Block that, since the reader side won't catch it.
    const body = obj?.["body"];
    const hasLink =
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>)["cip179"] === "object" &&
      (body as Record<string, unknown>)["cip179"] !== null;
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
