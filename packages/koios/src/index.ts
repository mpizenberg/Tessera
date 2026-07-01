/**
 * `@tessera/koios` — the Koios-backed `DataSource` and its wire adapters.
 *
 * Impure (it does HTTP + CBOR decoding) but portable: it runs in the browser
 * (the direct/power-user path) and in the serving tier (behind a token secret or
 * the anonymous tier). Everything downstream is provenance-agnostic, so the
 * eventual node+indexer replaces this behind the same seam.
 *
 * @module
 */

export * from "./koios";
export * from "./metadatum";
