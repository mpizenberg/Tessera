/**
 * The tlock client seam now lives in `cip-179/tlock` (shared with the serving
 * tier and the verifier). Re-exported here so existing `~/tlock/client`
 * importers keep their path and the lazy code-split still happens inside the
 * shared package.
 */

export * from "cip-179/tlock";
