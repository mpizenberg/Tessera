/**
 * IPFS endpoints — read gateways and write (pinning) providers.
 *
 * Pure metadata + localStorage helpers, safe to import eagerly (the Settings
 * screen needs the provider list; the read path needs the gateway list). The
 * actual network calls live in the lazy chunks: reads in `content.ts`, pins in
 * `pin.ts`.
 */

/**
 * Public gateways tried (concurrently, staggered) when resolving an `ipfs://`
 * URI. Content addressing means any gateway serving the CID returns identical
 * bytes, so racing several just buys speed + resilience — the first that returns
 * hash-verified bytes wins and the rest are aborted. Order ≈ preference.
 */
export const IPFS_GATEWAYS: readonly string[] = [
  "https://ipfs.io/ipfs/",
  "https://ipfs.blockfrost.dev/ipfs/",
  "https://dweb.link/ipfs/",
  "https://c-ipfs-gw.nmkr.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

/** Milliseconds between successive gateway attempts (first fires immediately). */
export const GATEWAY_STAGGER_MS = 1000;

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

/** localStorage key for a provider's token. */
export function providerTokenKey(id: ProviderId): string {
  return `tessera.ipfs.${id}`;
}

/** Read all configured provider tokens from localStorage (best-effort). */
export function loadProviderTokens(): ProviderTokens {
  const tokens: ProviderTokens = {};
  for (const p of IPFS_PROVIDERS) {
    try {
      const v = localStorage.getItem(providerTokenKey(p.id));
      if (v && v.trim()) tokens[p.id] = v.trim();
    } catch {
      // storage unavailable — leave unset
    }
  }
  return tokens;
}

/** Persist (or clear, when empty) a provider token. */
export function storeProviderToken(id: ProviderId, token: string): void {
  const trimmed = token.trim();
  try {
    if (trimmed) localStorage.setItem(providerTokenKey(id), trimmed);
    else localStorage.removeItem(providerTokenKey(id));
  } catch {
    // storage unavailable — keep the in-memory value only
  }
}
