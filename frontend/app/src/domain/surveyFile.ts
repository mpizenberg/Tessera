/**
 * A survey definition as files: its label-17 metadata in cardano-cli's
 * detailed JSON schema (the file `cardano-cli … --json-metadata-detailed-schema`
 * submits) and, for an external-content survey, the presentation document its
 * content anchor names.
 */

import {
  Cip179DecodeError,
  decodePayload,
  encodePayload,
  type SurveyDefinition,
} from "cip-179";
import { blake2b256 } from "cip-179/content";

import {
  PRESENTATION_KIND,
  parsePresentation,
  sameHash,
  type Presentation,
} from "~/enrichment/presentation";
import { PLACEHOLDER_ANCHOR, type PresentationDoc } from "~/domain/create";
import {
  fromDetailedJson,
  toDetailedJson,
  type DetailedJsonProblem,
} from "~/domain/detailedJson";

/** The metadata label CIP-179 payloads live under. */
const LABEL = 17n;

export const SURVEY_FILE_PROBLEM_CODES = [
  "surveyFile.fileChoice",
  "surveyFile.noSurveyLabel",
  "surveyFile.notCip179",
  "surveyFile.definitionCount",
  "surveyFile.presentationMismatch",
] as const;

export type SurveyFileProblemCode = (typeof SURVEY_FILE_PROBLEM_CODES)[number];

/** Why chosen files are not one survey definition (and its document). */
export interface SurveyFileProblem {
  readonly code: SurveyFileProblemCode;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * The files for `definition`. With a presentation document, the document is
 * written compactly, as pinning uploads it, and the definition's anchor gets
 * that text's hash and the placeholder URI: pinning the document unchanged and
 * writing its URI in gives the survey.
 */
export function exportSurvey(
  definition: SurveyDefinition,
  presentation?: PresentationDoc,
): { metadata: string; presentation?: string } {
  if (presentation === undefined) return { metadata: metadataText(definition) };
  const doc = JSON.stringify(presentation);
  return {
    metadata: metadataText({
      ...definition,
      contentAnchor: {
        uri: PLACEHOLDER_ANCHOR.uri,
        hash: blake2b256(new TextEncoder().encode(doc)),
      },
    }),
    presentation: doc,
  };
}

const metadataText = (definition: SurveyDefinition): string =>
  toDetailedJson(
    new Map([
      [
        LABEL,
        encodePayload({ type: "definitions", definitions: [definition] }),
      ],
    ]),
  );

/**
 * The one survey definition in `files`, read byte for byte: one metadata
 * file, plus the presentation document its anchor names when there is one.
 * The document is told apart by its `kind`, so the files come in any order.
 */
export function importSurvey(
  files: readonly Uint8Array[],
):
  | { definition: SurveyDefinition; presentation?: Presentation }
  | { problem: SurveyFileProblem | DetailedJsonProblem } {
  const metadataFiles: string[] = [];
  const documents: { bytes: Uint8Array; json: unknown }[] = [];
  for (const bytes of files) {
    const text = new TextDecoder().decode(bytes);
    const json = parsedOrUndefined(text);
    if (isPresentationJson(json)) documents.push({ bytes, json });
    else metadataFiles.push(text);
  }
  if (metadataFiles.length !== 1 || documents.length > 1)
    return { problem: { code: "surveyFile.fileChoice" } };

  const read = fromDetailedJson(metadataFiles[0]!);
  if ("problem" in read) return read;
  const payload = read.metadata.get(LABEL);
  if (payload === undefined)
    return { problem: { code: "surveyFile.noSurveyLabel" } };

  let definitions: readonly SurveyDefinition[];
  try {
    const decoded = decodePayload(payload);
    definitions = decoded.type === "definitions" ? decoded.definitions : [];
  } catch (e) {
    if (!(e instanceof Cip179DecodeError)) throw e;
    return {
      problem: {
        code: "surveyFile.notCip179",
        params: { where: e.path === "" ? String(LABEL) : e.path },
      },
    };
  }
  const [definition] = definitions;
  if (definition === undefined || definitions.length > 1)
    return {
      problem: {
        code: "surveyFile.definitionCount",
        params: { count: String(definitions.length) },
      },
    };

  const [document] = documents;
  if (document === undefined) return { definition };
  const anchor = definition.contentAnchor;
  if (
    anchor === undefined ||
    !sameHash(blake2b256(document.bytes), anchor.hash)
  )
    return { problem: { code: "surveyFile.presentationMismatch" } };
  return { definition, presentation: parsePresentation(document.json) };
}

function parsedOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isPresentationJson = (json: unknown): boolean =>
  typeof json === "object" &&
  json !== null &&
  (json as Record<string, unknown>)["kind"] === PRESENTATION_KIND;
