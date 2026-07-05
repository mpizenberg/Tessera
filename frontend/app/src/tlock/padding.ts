/**
 * The worst-case sealed-response padding estimate now lives in `@tessera/tlock`
 * (shared with the serving tier). Re-exported here so existing `~/tlock/padding`
 * importers (`maxPlaintextSize`) keep their path.
 */

export * from "@tessera/tlock";
