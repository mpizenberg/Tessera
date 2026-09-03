/**
 * `cardano-tessera-client` — the consumer side of a Tessera serving backend's
 * HTTP contract: the payload types and constants, a client with one method per
 * route that decodes bodies into `cip-179` types and checks the contract
 * version, the bundle collector, and the per-network epoch calendar.
 *
 * Best-effort and 0.x. The stability promise is the HTTP contract's own
 * version ({@link API_VERSION}, the backend's `CHANGELOG.md`), which this
 * package tracks; the API is first the seam between Tessera's own frontend
 * and backend, and this package exists so a host does not have to hand-write
 * that seam again.
 *
 * @module
 */

export * from "./network.js";
export * from "./payloads.js";
export * from "./bundle.js";
export * from "./decode.js";
export * from "./client.js";
