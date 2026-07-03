/**
 * Pure owner-proof verification for cancellations. Moved to `@tessera/core`
 * (shared with the serving tier and verifier); this re-export keeps the
 * `~/domain/cancellation` import path stable.
 */
export { nativeScriptSatisfied, cancellationVerified } from "@tessera/core";
