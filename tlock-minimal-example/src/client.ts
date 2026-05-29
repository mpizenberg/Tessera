// Single integration point with the @mpizenberg/tlock-js fork.
//
// The fork ships as CommonJS (no "type":"module"). When this ESM project imports
// it, Node's CJS->ESM named-export synthesis yields `undefined` bindings (the
// fork's re-export style defeats cjs-module-lexer). `createRequire` returns the
// real module.exports, so we load it that way and re-export typed bindings.
// `import type * as` is erased at runtime, so it only supplies the static types.
import { createRequire } from "node:module";
import type * as TlockModule from "@mpizenberg/tlock-js/src/index";
import type * as ArmorModule from "@mpizenberg/tlock-js/src/age/armor";

const nodeRequire = createRequire(import.meta.url);
const tlock = nodeRequire("@mpizenberg/tlock-js/src/index") as typeof TlockModule;
const armor = nodeRequire("@mpizenberg/tlock-js/src/age/armor") as typeof ArmorModule;

// `mainnetClient()` is quicknet (BLS12-381, G1 sigs, scheme bls-unchained-g1-rfc9380,
// 3 s period); `defaultChainUrl` is its HTTP root. Aliased under quicknet names.
export const QUICKNET_CHAIN_URL = tlock.defaultChainUrl;

export type HttpChainClient = TlockModule.HttpChainClient;

export function quicknetClient(): HttpChainClient {
  return tlock.mainnetClient();
}

export const { timelockEncrypt, timelockDecrypt, roundAt, roundTime, Buffer } = tlock;
export const { decodeArmor, isProbablyArmored } = armor;
