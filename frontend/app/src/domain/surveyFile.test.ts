import { describe, expect, test } from "vitest";

import { Role, encodePayload, type SurveyDefinition } from "cip-179";
import { blake2b256 } from "cip-179/content";

import { parsePresentation } from "~/enrichment/presentation";
import {
  PLACEHOLDER_ANCHOR,
  buildDefinition,
  buildPresentationDoc,
  formFromDefinition,
  initDefinitionMeta,
  initQuestionDraft,
  type DefinitionMeta,
  type QuestionDraft,
} from "./create";
import { toDetailedJson } from "./detailedJson";
import { exportSurvey, importSurvey } from "./surveyFile";

const owner = { type: "key", keyHash: new Uint8Array(28).fill(5) } as const;

const meta = (over: Partial<DefinitionMeta> = {}): DefinitionMeta => ({
  ...initDefinitionMeta(),
  title: "Survey",
  description: "About things",
  eligibleRoles: [Role.Stakeholder],
  endEpoch: "500",
  ...over,
});

const questions: QuestionDraft[] = [
  {
    ...initQuestionDraft("singleChoice"),
    prompt: "Which?",
    labels: ["a", "b"],
  },
  {
    ...initQuestionDraft("rating"),
    prompt: "Judge them",
    labels: ["x", "y"],
    ratingScale: "labels",
    ratingLabels: ["bad", "good"],
  },
];

const definitionOf = (m: DefinitionMeta): SurveyDefinition => {
  const b = buildDefinition(owner, m, questions);
  if (!b.definition || b.problems.length > 0) throw new Error("invalid");
  return b.definition;
};

const bytes = (text: string) => new TextEncoder().encode(text);

const problemOf = (files: string[]) => {
  const r = importSurvey(files.map(bytes));
  if (!("problem" in r)) throw new Error("imported without a problem");
  return r.problem;
};

const metadataFile = (payload: Parameters<typeof encodePayload>[0]) =>
  toDetailedJson(new Map([[17n, encodePayload(payload)]]));

describe("exportSurvey / importSurvey", () => {
  test("an embedded survey comes back as exported", () => {
    const definition = definitionOf(meta());
    const files = exportSurvey(definition);
    expect(files.presentation).toBeUndefined();
    expect(importSurvey([bytes(files.metadata)])).toEqual({ definition });
  });

  test("an external survey travels with its document, in either order", () => {
    const m = meta({ contentMode: "external" });
    const doc = buildPresentationDoc(m, questions);
    const files = exportSurvey(definitionOf(m), doc);
    const presentation = files.presentation!;
    expect(presentation).toBe(JSON.stringify(doc));

    const forward = importSurvey([bytes(files.metadata), bytes(presentation)]);
    const backward = importSurvey([bytes(presentation), bytes(files.metadata)]);
    expect(backward).toEqual(forward);
    if ("problem" in forward) throw new Error(forward.problem.code);

    expect(forward.definition.contentAnchor).toEqual({
      uri: PLACEHOLDER_ANCHOR.uri,
      hash: blake2b256(bytes(presentation)),
    });
    expect(forward.presentation).toEqual(parsePresentation(doc));
    const form = formFromDefinition(forward.definition, forward.presentation);
    expect(form.meta.title).toBe("Survey");
    expect(form.questions.map((q) => q.prompt)).toEqual([
      "Which?",
      "Judge them",
    ]);
    expect(form.questions[1]!.ratingLabels).toEqual(["bad", "good"]);
  });

  test("an external survey imports without its document", () => {
    const m = meta({ contentMode: "external" });
    const files = exportSurvey(
      definitionOf(m),
      buildPresentationDoc(m, questions),
    );
    const r = importSurvey([bytes(files.metadata)]);
    expect(r).not.toHaveProperty("problem");
    expect(r).not.toHaveProperty("presentation");
  });

  describe("refuses", () => {
    const external = meta({ contentMode: "external" });
    const doc = buildPresentationDoc(external, questions);
    const { metadata, presentation } = exportSurvey(
      definitionOf(external),
      doc,
    );
    const embedded = exportSurvey(definitionOf(meta())).metadata;

    test.each([
      ["no metadata file", [presentation!]],
      ["two metadata files", [embedded, embedded]],
      ["two documents", [metadata, presentation!, presentation!]],
    ])("%s", (_name, files) => {
      expect(problemOf(files)).toEqual({ code: "surveyFile.fileChoice" });
    });

    test("a file that is not detailed-schema metadata, with the reader's problem", () => {
      expect(problemOf(["{"])).toEqual({ code: "detailedJson.notJson" });
    });

    test("metadata without label 17", () => {
      expect(problemOf([`{"674": {"string": "hi"}}`])).toEqual({
        code: "surveyFile.noSurveyLabel",
      });
    });

    test("label 17 that is not a CIP-179 payload", () => {
      expect(problemOf([`{"17": {"int": 1}}`])).toMatchObject({
        code: "surveyFile.notCip179",
      });
    });

    test("other than exactly one definition", () => {
      const definition = definitionOf(meta());
      expect(
        problemOf([
          metadataFile({
            type: "definitions",
            definitions: [definition, definition],
          }),
        ]),
      ).toEqual({
        code: "surveyFile.definitionCount",
        params: { count: "2" },
      });
    });

    test("a document the anchor does not name", () => {
      const edited = JSON.stringify({ ...doc, title: "Other" });
      expect(problemOf([metadata, edited])).toEqual({
        code: "surveyFile.presentationMismatch",
      });
      expect(problemOf([embedded, presentation!])).toEqual({
        code: "surveyFile.presentationMismatch",
      });
    });
  });
});
