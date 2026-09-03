# cardano-tessera-client

The typed client for a [Tessera](https://github.com/mpizenberg/Tessera)
serving backend: the CIP-179 survey list, one survey's bundle, the responses
a transaction carried, tally artifacts and health, decoded into
[`cip-179`](../cip179) types, with the contract's version checked before the
first read is trusted.

Best-effort and 0.x. The stability promise is the HTTP contract's own version
(`API_VERSION`, changelog in `backend/server/CHANGELOG.md` of the Tessera
repository), which this package tracks: the API is first the seam between
Tessera's own frontend and backend, and this package exists so a host does
not have to hand-write that seam again.

## Install

```sh
npm install cardano-tessera-client cip-179
```

`cip-179` is a peer dependency: the client returns its types and throws its
`Cip179DecodeError`, and a host that also uses `cip-179` directly must see one
copy of that class for `instanceof` to hold.

## Read a survey

```ts
import { createTesseraClient, currentEpoch } from "cardano-tessera-client";

const client = createTesseraClient({
  baseUrl: "https://tessera-backend-preprod.matthieu-pizenberg.workers.dev",
  network: "preprod",
});

const answer = await client.wholeBundle(
  "5910e44ca9bb9a41625280a1335a4a59941a15716d6959901c9b8e20a058649d:0",
);
if (!answer.ready) {
  // The backend has not completed its first refresh — wait, do not alarm.
} else {
  const { survey, responses, verdicts, govLinks, tip } = answer.body;
  // survey.definition and survey.ref feed <tessera-respond>, with
  // tipEpoch: currentEpoch("preprod").
}
```

Every snapshot-derived method (`surveys`, `surveysByRefs`, `bundle`,
`wholeBundle`, `responded`, `responsesByTx`) answers
`{ ready: true, body } | { ready: false }`; the false branch is the backend's
own `503 {"error":"snapshot not ready"}`, an ordinary state before its first
refresh. Any other non-2xx answer throws `TesseraHttpError` with the status.
The first of those reads also fetches `/health` and refuses a backend serving
another network than the one given, or another contract major than
`API_VERSION`'s; a minor the client does not know is accepted.

Input the contract would refuse is refused here first, with a `RangeError`
and no request: a survey key not matching `SURVEY_KEY_RE`, a `limit` outside
1–`MAX_PAGE_LIMIT`, more than `MAX_CREDENTIALS` credentials, more than
`MAX_TX_STATUS_HASHES` hashes, a hash that is not 64 lowercase hex characters.

## Methods

| Method                                      | Route                               | Answer                                |
| :------------------------------------------ | :---------------------------------- | :------------------------------------ |
| `liveness()`                                | `GET /health`                       | `BackendLiveness`                     |
| `health()`                                  | `GET /api/health`                   | `BackendHealth`                       |
| `surveys(params?)`                          | `GET /api/surveys` (paged)          | `SnapshotAnswer<SurveyListPayload>`   |
| `surveysByRefs(keys)`                       | `GET /api/surveys?refs=`            | `SnapshotAnswer<SurveyListPayload>`   |
| `bundle(survey, cursor?)`                   | `GET /api/surveys/{txHash}/{index}` | `SnapshotAnswer<SurveyBundlePayload>` |
| `wholeBundle(survey)`                       | every page of the above             | `SnapshotAnswer<SurveyBundlePayload>` |
| `responded(credentials)`                    | `GET /api/responded`                | `SnapshotAnswer<RespondedPayload>`    |
| `responsesByTx(txHash)`                     | `GET /api/responses/{txHash}`       | `SnapshotAnswer<TxResponsesPayload>`  |
| `artifact(survey)` / `artifactByHash(hash)` | the artifact routes                 | `TallyArtifact \| null`               |
| `tip()`                                     | `GET /api/tip`                      | `ChainTip`                            |
| `txStatus(hashes)`                          | `GET /api/tx_status`                | `Record<string, number \| null>`      |
| `pparams()`                                 | `GET /api/pparams`                  | `unknown` (evolution-sdk's shape)     |

A survey is named by its record's `ref` or by its key, `<txHash>:<index>`.
`bundle` is one page — enough for a host that only renders the survey, since
the definition rides every page; `wholeBundle` follows `nextCursor` to the end
with `collectSurveyBundle`'s restart rule, for anything that counts or
displays responses.

## Which epoch a host passes as `tipEpoch`

`currentEpoch(network)` — the calendar's epoch, from `EPOCH_ZERO_UNIX` and
`SECONDS_PER_EPOCH`. A survey accepts responses through its `endEpoch`
inclusive and the ledger's epoch is wall-clock, so the calendar is what
decides "still open". A stored snapshot's `tip.epoch` lags it by up to one
refresh interval, which around an epoch boundary shows a just-closed survey
as open.

## What a host must not claim

The host contract in `interop/preprod.md` of the Tessera repository lists the
limits that travel with this data: a sealed response hides its answers and
nothing else; a governance link is a discovery relation, not an endorsement;
results are per role and never merged; `countedByRole` is provisional while a
survey has no artifact.

## Development

```sh
pnpm install
pnpm --filter cardano-tessera-client type-check
pnpm --filter cardano-tessera-client test
pnpm --filter cardano-tessera-client build   # emits dist/ for publishing
```

In the workspace the package is consumed straight from `src`; `dist/` is only
produced for publishing, where `publishConfig.exports` swaps the entry points
to the compiled output at `pnpm publish` time.
