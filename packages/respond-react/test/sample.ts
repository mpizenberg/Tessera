/**
 * Offline mock props for the wrapper tests — the widget never fetches, the
 * host always supplies. One single-choice question so a submit needs exactly
 * two clicks. Typed entirely off the published element contract; role 4 is
 * Keyholder, proved by a payment key.
 */

import type { TesseraRespondProps } from "../src/index";

const bytes = (length: number, fill: number): Uint8Array =>
  new Uint8Array(length).fill(fill);

export const definition: TesseraRespondProps["definition"] = {
  // cip-179 SPEC_VERSION — the widget validates the responses it builds
  // against the definition's version, so a stale value fails every submit.
  specVersion: 5,
  owner: { type: "key", keyHash: bytes(28, 0x00) },
  title: "React wrapper survey",
  description: "One question, answered by the tests via DOM clicks.",
  eligibleRoles: [4],
  endEpoch: 600,
  submissionMode: { type: "public" },
  questions: [
    {
      type: "singleChoice",
      prompt: "Pick one",
      required: true,
      options: { type: "options", labels: ["First", "Second"] },
    },
  ],
};

export const surveyRef: TesseraRespondProps["surveyRef"] = {
  txId: bytes(32, 0x11),
  index: 0,
};

export const responder: TesseraRespondProps["responder"] = {
  4: { type: "key", keyHash: bytes(28, 0xaa) },
};

export const REQUIRED: Pick<
  TesseraRespondProps,
  "definition" | "surveyRef" | "responder" | "tipEpoch"
> = { definition, surveyRef, responder, tipEpoch: 500 };
