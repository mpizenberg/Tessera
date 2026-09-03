# Changelog

All notable changes to the `cardano-tessera-client` package are documented
here. The HTTP contract it speaks has its own version (`API_VERSION`) and its
own changelog, `backend/server/CHANGELOG.md` in the Tessera repository; a
contract change reaches this package as a new `API_VERSION` and a line here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while `< 1.0.0`, breaking changes bump the **minor** version.

## [0.1.0] - unreleased

First release, speaking contract `1.0`.

- The payload types of every route (`SurveyListPayload`,
  `SurveyBundlePayload`, `SurveyFinalState`, `BackendHealth`,
  `BackendLiveness`, `RespondedPayload`, `TxResponsesPayload`), the list's
  filter, counts and parameters, and the contract's constants: `API_VERSION`
  with `apiMajor`, `SURVEY_KEY_RE`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`,
  `MAX_CREDENTIALS`, `MAX_TX_STATUS_HASHES`.
- `createTesseraClient({ baseUrl, network?, fetch?, timeoutMs? })` with one
  method per route — `liveness`, `health`, `surveys`, `surveysByRefs`,
  `bundle`, `wholeBundle`, `responded`, `responsesByTx`, `artifact`,
  `artifactByHash`, `tip`, `txStatus`, `pparams` — decoding bodies into
  `cip-179` types, refusing malformed input with a `RangeError` before any
  request, answering the backend's not-ready state as `{ ready: false }`,
  and refusing a backend on another network or another contract major on the
  first snapshot read.
- The envelope decoders (`decodeSurveyList`, `decodeSurveyBundle`, …), for a
  body obtained by other means; a shape error is a `Cip179DecodeError`
  naming the field.
- `collectSurveyBundle` and `MAX_BUNDLE_RESYNCS`, the paged-bundle collector
  with its restart rule.
- `NETWORKS`, `parseNetwork`, `SECONDS_PER_EPOCH`, `EPOCH_ZERO_UNIX` and
  `currentEpoch(network)`, the epoch a host passes to `<tessera-respond>` as
  `tipEpoch`.
