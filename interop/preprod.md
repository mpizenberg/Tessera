# Preprod interoperability record

The fixed contract a DRepTalk development client consumes during the preprod
interoperability test. `preprod-fixtures.json` beside this file pins the raw
on-chain label-17 metadata of each fixture transaction next to the exact wire
form Tessera serves for it, and `backend/server/src/interop.test.ts` replays
the backend's decode path over that file — so the recorded values cannot drift
from the published codec unnoticed. A consumer proving "we decode the same
bytes the same way" diffs its own decode of `label17` against `expected`.

`generate-fixtures.mjs` rebuilds the JSON from live sources — Koios for the
raw metadata, the deployed backend's own bundles for the expected wire forms.
Run `node interop/generate-fixtures.mjs && pnpm format` after adding a fixture
transaction there or intentionally changing the wire format, and review the
diff.

## Endpoint

The preprod backend serves
`https://tessera-backend-preprod.matthieu-pizenberg.workers.dev`; endpoint
shapes are documented in `backend/server/README.md`. `GET /api/health` reports
the deployed git commit in its `commit` field, so which code produced a
response is a live query rather than a figure recorded here.

## Packages

A host reaches the widget and codec through the published packages `cip-179`
(metadatum codec, domain model, and validation rules),
`cardano-tessera-respond` (the framework-free `<tessera-respond>` answering
widget), and `cardano-tessera-respond-react` (React wrapper — see
`examples/react-host`; a Svelte host lives in `examples/svelte-host`). Pin the
versions current on npm when the test run starts and record them with its
results.

## Fixtures

Both surveys were defined in one transaction,
`5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d`
(slot 130329077, epoch 305), owner key hash
`0ffd51f55075cc221d9e842943ef426e2d870e56366a111643765ba2`:

| Ref       | Title                       | Mode   | Eligible roles      | End epoch |
| --------- | --------------------------- | ------ | ------------------- | --------- |
| `…649d#0` | First Preprod Public Survey | public | `[3]` (Stakeholder) | 306       |
| `…649d#1` | First Preprod Sealed Survey | sealed | `[3]` (Stakeholder) | 306       |

Each asks one `singleChoice` question, "First question" — options `A`/`B` for
the public survey, `Alpha`/`Beta` for the sealed one. The sealed survey
timelocks against drand quicknet (chain hash `52db9ba7…e971`, round
`31287452`, padding size 5).

One transaction,
`2811d86267bbf2108a153b1598bb6a02460ca007d456ae2c0fa3f6f67c1fcb14`
(slot 130329197, epoch 305), carries both fixture responses from stakeholder
key credential `308ee9a8f22dcb1672a7334e811f8173c7c38eeef16ddb6fe2601f8f`:
response index 0 answers the public survey (option 0), response index 1 is a
sealed ciphertext for the sealed survey. Tessera has validated both
(`verdicts` reports `true`) and counts one response per survey.

## Minimal host contract

- The host reads a survey by exact reference from
  `GET /api/surveys/{txHash}/{index}` and feeds the bundle's decoded
  `definition` plus the survey ref into `<tessera-respond>`. The same bundle
  carries the survey's `govLinks`, so a host mirroring a chosen subset of
  surveys never has to read the list to know which action a survey is linked to
  — read the limits on what that linkage means below. Several surveys at once
  come from `GET /api/surveys?refs=<txHash>:<index>,…`, which answers the list
  payload for exactly the references named.
- The host supplies the connected responder's credential map (for the DRepTalk
  test: a key-DRep credential).
- The widget owns answer drafting, validation, and sealing, and emits the
  response metadatum. The host attaches it at label 17 exactly once.
- DRepTalk attribution rides separately at label 674. Tessera reads only
  label 17 from a transaction's metadata, so other labels are inert to it.
- The host's transaction builder adds the responding credential's key hash as
  a required signer — that is the CIP-179 mechanism-A ownership proof Tessera
  validates.
- Confirmation is polled through `GET /api/tx_status?hashes=…`; the decided
  validation verdict and counted state are read back from the bundle's
  `verdicts` and the list's `responseCounts`.
- A bundle serves its responses one page at a time. A host that only feeds
  `<tessera-respond>` needs page one, since the definition and the survey ref
  ride every page; a host that counts or displays responses itself follows
  `nextCursor` to the end, and starts over if a page answers `resync`.

## What a host must not claim

The host is the surface that can overstate this data, so four limits travel with
the contract above:

- A **sealed** response hides its answers until the pinned drand round, and
  nothing else. Role and credential are in clear on-chain from submission.
- A **governance link** is a discovery relation. It is not evidence that the
  action's proposer and the survey's owner are the same party — "linked by this
  action" is the honest label, and "official" is not.
- A response is authenticated by its carrying transaction. A host session may
  decide which call to action is shown, never which credential is submitted.
- Results are **per-role and never merged** into a single figure
  (`backend/TALLY-SPEC.md` §1), and a weighted aggregate is a Tessera profile
  rather than a CIP-179 result: name the policy and its ruleset.

## The operating question

Whether a host runs its own Tessera backend or depends on someone else's is
settled by measurement, not assertion. `backend/server/OPERATIONS.md` describes
the collector, the workloads worth separating, and the three answers the evidence
can produce. That study is the remaining deliverable of this record.

## Interoperability test sequence

1. Read the fixture surveys by exact reference.
2. Render all fixture questions through `<tessera-respond>`.
3. Submit an independent key-DRep response to a DRep-eligible survey.
4. Poll confirmation through `/api/tx_status`.
5. Observe a decided positive proof verdict and a counted response.
6. Submit a valid replacement and observe latest-valid-response-wins.
7. Verify both applications decode the same role, credential, reference, and
   answers — diff each side's decode of `preprod-fixtures.json`'s `label17`
   against `expected`.
