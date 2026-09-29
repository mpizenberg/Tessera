/**
 * IPFS pinning providers — where the app can upload off-chain content.
 *
 * Pure metadata + token storage, safe to import eagerly (the Settings
 * screen needs the provider list). The actual uploads live in the lazy `pin.ts`
 * chunk; the read side (gateways + hash-verified fetch) lives in
 * `cip-179/content`, shared with the serving tier.
 */

import { readText, writeText } from "~/storage";

/** Identifier of a pinning provider the app can upload to. */
export type ProviderId = "pinata" | "blockfrost" | "nmkr";

/** Display + input metadata for a pinning provider (no network logic here). */
export interface ProviderMeta {
  readonly id: ProviderId;
  readonly label: string;
  /** What the user pastes into the token field. */
  readonly tokenPlaceholder: string;
  /** One-line guidance shown under the field. */
  readonly hint: string;
}

export const IPFS_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: "pinata",
    label: "Pinata",
    tokenPlaceholder: "Pinata JWT",
    hint: "Account → API Keys → a JWT with pinFileToIPFS scope.",
  },
  {
    id: "blockfrost",
    label: "Blockfrost IPFS",
    tokenPlaceholder: "Blockfrost IPFS project id (ipfs…)",
    hint: "A Blockfrost project of type IPFS; paste its project_id.",
  },
  {
    id: "nmkr",
    label: "NMKR",
    tokenPlaceholder: "userId:apiKey",
    hint: "NMKR Studio: your user id (UUID, the UploadToIpfs path) and an API key, colon-separated. May need a CORS proxy.",
  },
];

/** Per-provider token map (absent / empty = not configured). */
export type ProviderTokens = Partial<Record<ProviderId, string>>;

/** Storage key for a provider's token. */
function providerTokenKey(id: ProviderId): string {
  return `tessera.ipfs.${id}`;
}

/** Read all configured provider tokens (best-effort). */
export function loadProviderTokens(): ProviderTokens {
  const tokens: ProviderTokens = {};
  for (const p of IPFS_PROVIDERS) {
    const v = readText(providerTokenKey(p.id))?.trim();
    if (v) tokens[p.id] = v;
  }
  return tokens;
}

/** Persist (or clear, when empty) a provider token. */
export function storeProviderToken(id: ProviderId, token: string): void {
  writeText(providerTokenKey(id), token.trim());
}
