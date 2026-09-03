/**
 * `GET /api/surveys/{txHash}/{index}` for the first preprod fixture survey, as
 * the preprod backend answered it on 2026-09-03 — the wire form
 * `cardano-tessera-client` decodes (bytes under `$bytes`), recorded so the
 * example runs offline and CI needs no network. The survey is the one
 * `interop/preprod.md` pins; re-record with `curl` when it changes.
 */

export const PREPROD_SURVEY_KEY =
  "5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d:0";

export const PREPROD_BUNDLE = {
  survey: {
    txHash: "5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d",
    slot: 130329077,
    epochNo: 305,
    ref: {
      txId: {
        $bytes:
          "5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d",
      },
      index: 0,
    },
    definition: {
      specVersion: 5,
      owner: {
        type: "key",
        keyHash: {
          $bytes: "0ffd51f55075cc221d9e842943ef426e2d870e56366a111643765ba2",
        },
      },
      title: "First Preprod Public Survey",
      description: "",
      eligibleRoles: [3],
      endEpoch: 306,
      submissionMode: {
        type: "public",
      },
      questions: [
        {
          type: "singleChoice",
          prompt: "First question",
          options: {
            type: "options",
            labels: ["A", "B"],
          },
        },
      ],
    },
  },
  responses: [
    {
      txHash:
        "2811d86267bbf2108a153b1598bb6a02460ca007d456ae2c0fa3f6f67c1fcb14",
      slot: 130329197,
      epochNo: 305,
      responseIndex: 0,
      response: {
        specVersion: 5,
        surveyRef: {
          txId: {
            $bytes:
              "5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d",
          },
          index: 0,
        },
        role: 3,
        credential: {
          type: "key",
          keyHash: {
            $bytes: "308ee9a8f22dcb1672a7334e811f8173c7c38eeef16ddb6fe2601f8f",
          },
        },
        answers: {
          type: "public",
          answers: [
            {
              type: "singleChoice",
              questionIndex: 0,
              optionIndex: 0,
            },
          ],
        },
      },
    },
    {
      txHash:
        "2445243f8ddeb28174f5992f7428037c01783491f8fbe5cf0112c51ce676c73b",
      slot: 130786004,
      epochNo: 306,
      responseIndex: 0,
      response: {
        specVersion: 5,
        surveyRef: {
          txId: {
            $bytes:
              "5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d",
          },
          index: 0,
        },
        role: 3,
        credential: {
          type: "key",
          keyHash: {
            $bytes: "308ee9a8f22dcb1672a7334e811f8173c7c38eeef16ddb6fe2601f8f",
          },
        },
        answers: {
          type: "public",
          answers: [
            {
              type: "singleChoice",
              questionIndex: 0,
              optionIndex: 1,
            },
          ],
        },
      },
    },
  ],
  cancellations: [],
  govLinks: [],
  tip: {
    epoch: 311,
    slot: 132794998,
    time: 1788478198,
    epochSlot: 84598,
    govActionLifetime: 6,
  },
  verdicts: {
    "2811d86267bbf2108a153b1598bb6a02460ca007d456ae2c0fa3f6f67c1fcb14:0": true,
    "2445243f8ddeb28174f5992f7428037c01783491f8fbe5cf0112c51ce676c73b:0": true,
  },
  nextCursor: null,
  fetchedAt: 1788478204,
};
