# Preprod interoperability record

The fixed contract a DRepTalk development client consumes during the preprod
interoperability test. `preprod-fixtures.json` beside this file pins the raw
on-chain label-17 metadata of each fixture transaction next to the exact wire
form Tessera serves for it, and `backend/server/src/interop.test.ts` replays
the backend's decode path over that file — so the recorded values cannot drift
from the published codec unnoticed. A consumer proving "we decode the same
bytes the same way" diffs its own decode of `label17` against `expected`.

## Deployment identity

- Network: `preprod` (Koios `https://preprod.koios.rest/api/v1`)
- Backend: Worker `tessera-backend-preprod` at
  `https://tessera-backend-preprod.matthieu-pizenberg.workers.dev`
- Deployed commit: `f2b86aa` (Worker version
  `2cdc2701-73b6-4dc1-a78f-9ce9f4d60f7d`, deployed `2026-08-06T16:24Z`)
- Cron cadence `*/3 * * * *`; a steady-state refresh spends 3 Koios calls.

Update this block whenever a new commit is deployed to preprod, so the figures
and fixtures here always name the code that produced them. Endpoint shapes are
documented in `backend/server/README.md`; D1 and account identifiers are
operator state and deliberately absent here.

## Published packages

A host pins exactly these versions:

- `cip-179@0.3.0` — metadatum codec, domain model, and validation rules.
- `cardano-tessera-respond@0.1.2` — the framework-free `<tessera-respond>`
  answering widget.
- `cardano-tessera-respond-react@0.1.0` — React wrapper around the widget
  (see `examples/react-host`; a Svelte host lives in `examples/svelte-host`).

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
  `definition` plus the survey ref into `<tessera-respond>`.
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

## Interoperability checklist

1. Read the fixture by exact reference — **passing**; this record was produced
   from those responses.
2. Render all fixture questions through `<tessera-respond>` — pending the
   DRepTalk development client.
3. Submit an independent key-DRep response — **blocked on a DRep-eligible
   fixture** (see gaps below).
4. Poll confirmation — pending step 3.
5. Observe a decided positive proof verdict and counted response — pending
   step 3.
6. Submit a valid replacement and observe latest-valid-response-wins — pending
   step 3.
7. Verify both applications decode the same role, credential, reference, and
   answers — `preprod-fixtures.json` is the diff basis; pending the DRepTalk
   side of the comparison.

## Known gaps

- **No DRep-eligible survey exists yet.** Both fixtures admit only role 3
  (Stakeholder), and both counted responses are stakeholder responses. The
  key-DRep proof needs one more public survey with eligible roles including 0
  (DRep) — an owner-wallet action. Add it to this record and
  `preprod-fixtures.json` when it lands.
- **Finalization is not yet observable.** Both fixtures end at epoch 306, so
  `GET /api/surveys/{txHash}/{index}/artifact` correctly answers 404 while
  they are open. Tally artifacts, and the sealed survey's reveal-cost
  measurement, wait for the chain to pass epoch 306 (preprod epochs are five
  days; roughly 2026-08-14).
