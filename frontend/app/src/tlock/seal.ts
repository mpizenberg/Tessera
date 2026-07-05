/**
 * Seal / reveal orchestration now lives in `@tessera/tlock` (shared with the
 * serving tier and the verifier). Re-exported here so existing `~/tlock/seal`
 * importers (`sealAnswers`, `revealResponses`) keep their path.
 */

export * from "@tessera/tlock";
