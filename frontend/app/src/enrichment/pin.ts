/**
 * IPFS pinning — uploading off-chain content (presentation documents, voter
 * rationales) from inside the app, so authoring an external-content survey or an
 * anchored rationale doesn't require a separate hosting step.
 *
 * A document is pinned to **every configured provider in parallel**; the upload
 * succeeds if at least one does (wider availability, no single point of
 * failure). We compute the on-chain anchor hash ourselves as the
 * **blake2b-256 of the exact bytes uploaded** — never trusting a provider — so
 * the resulting `{uri, hash}` reads back and verifies through the gateway race
 * in `cip-179/content`.
 *
 * Best-effort + browser-dependent: provider APIs must allow authenticated CORS
 * uploads. Failures are collected per-provider, not thrown, as long as one pin
 * lands. Lazy-loaded (its own chunk) — only pulled in when a user actually pins.
 */

import { blake2b256 } from "cip-179/content";
import {
  IPFS_PROVIDERS,
  type ProviderId,
  type ProviderTokens,
} from "./providers";

export interface PinResult {
  /** `ipfs://<cid>` — the anchor URI to record on-chain. */
  readonly uri: string;
  /** blake2b-256 of the exact bytes pinned — the anchor hash. */
  readonly hash: Uint8Array;
  readonly cid: string;
  /** Providers holding the pin under exactly {@link cid} — the ones that make `uri` resolvable. */
  readonly pinnedBy: ProviderId[];
  /** Providers that failed (non-fatal as long as `pinnedBy` is non-empty). */
  readonly failures: ReadonlyArray<{ id: ProviderId; error: string }>;
}

const enc = new TextEncoder();

/** Pin a JSON document (stringified compactly). */
export function pinJson(
  obj: unknown,
  name: string,
  tokens: ProviderTokens,
): Promise<PinResult> {
  return pinBytes(
    enc.encode(JSON.stringify(obj)),
    name,
    "application/json",
    tokens,
  );
}

/** Pin raw bytes to every configured provider; resolve once at least one wins. */
export async function pinBytes(
  bytes: Uint8Array,
  name: string,
  mime: string,
  tokens: ProviderTokens,
): Promise<PinResult> {
  const enabled = IPFS_PROVIDERS.filter((p) => tokens[p.id]?.trim());
  if (enabled.length === 0) {
    throw new Error("No IPFS provider configured — add a token in Settings.");
  }
  const settled = await Promise.allSettled(
    enabled.map((p) => pinTo(p.id, tokens[p.id]!.trim(), bytes, name, mime)),
  );

  const accepted: { id: ProviderId; cid: string }[] = [];
  const failures: { id: ProviderId; error: string }[] = [];
  settled.forEach((r, i) => {
    const id = enabled[i]!.id;
    if (r.status === "fulfilled") {
      accepted.push({ id, cid: r.value });
    } else {
      failures.push({
        id,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  const cid = accepted[0]?.cid;
  if (cid === undefined) {
    throw new Error(
      "All IPFS pins failed — " +
        failures.map((f) => `${f.id}: ${f.error}`).join("; "),
    );
  }
  // Two CIDs for the same bytes name *different blocks* (CID version, chunker,
  // raw-leaves all feed the hash), so a provider that pinned under another CID
  // does not make `cid` resolvable — crediting it would overstate redundancy.
  const pinnedBy: ProviderId[] = [];
  for (const a of accepted) {
    if (a.cid === cid) pinnedBy.push(a.id);
    else
      failures.push({ id: a.id, error: `pinned a different CID (${a.cid})` });
  }
  return {
    uri: `ipfs://${cid}`,
    hash: blake2b256(bytes),
    cid,
    pinnedBy,
    failures,
  };
}

function pinTo(
  id: ProviderId,
  token: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<string> {
  switch (id) {
    case "pinata":
      return pinPinata(token, bytes, name, mime);
    case "blockfrost":
      return pinBlockfrost(token, bytes, name, mime);
    case "nmkr":
      return pinNmkr(token, bytes, name, mime);
  }
}

function fileForm(bytes: Uint8Array, name: string, mime: string): FormData {
  const form = new FormData();
  // Cast: the DOM lib types BlobPart over Uint8Array<ArrayBuffer>, but our bytes
  // are Uint8Array<ArrayBufferLike>; the runtime accepts any typed array.
  form.append(
    "file",
    new Blob([bytes as unknown as BlobPart], { type: mime }),
    name,
  );
  return form;
}

/** Pinata: a single multipart POST authorized by a JWT → `{ IpfsHash }`. */
async function pinPinata(
  jwt: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<string> {
  const form = fileForm(bytes, name, mime);
  // Pin CIDv0 explicitly: Pinata's default is undocumented (their newer API
  // already defaults to CIDv1), while Blockfrost's kubo endpoint and NMKR
  // return CIDv0 — an unpinned default here would silently fork the CIDs.
  form.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Pinata HTTP ${res.status}`);
  const j = (await res.json()) as { IpfsHash?: unknown };
  if (typeof j.IpfsHash !== "string")
    throw new Error("no IpfsHash in response");
  return j.IpfsHash;
}

/** Blockfrost IPFS: add (temporary) then pin/add (persistent), keyed by project_id. */
async function pinBlockfrost(
  projectId: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<string> {
  const addRes = await fetch("https://ipfs.blockfrost.io/api/v0/ipfs/add", {
    method: "POST",
    headers: { project_id: projectId },
    body: fileForm(bytes, name, mime),
  });
  if (!addRes.ok) throw new Error(`add HTTP ${addRes.status}`);
  const added = (await addRes.json()) as { ipfs_hash?: unknown };
  if (typeof added.ipfs_hash !== "string") throw new Error("no ipfs_hash");
  const cid = added.ipfs_hash;
  const pinRes = await fetch(
    `https://ipfs.blockfrost.io/api/v0/ipfs/pin/add/${cid}`,
    { method: "POST", headers: { project_id: projectId } },
  );
  if (!pinRes.ok) throw new Error(`pin HTTP ${pinRes.status}`);
  return cid;
}

/**
 * NMKR Studio: base64 JSON upload to `UploadToIpfs/{userId}`, authorized by an
 * API key. Token is `userId:apiKey`. The success body is a **bare JSON string —
 * the CID itself** (per the cardano-gov-voting reference); the base64 must omit
 * the `data:…;base64,` prefix. Best-effort: NMKR may not send browser CORS
 * headers, in which case the request fails (a server proxy would be needed —
 * out of scope here).
 */
async function pinNmkr(
  token: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<string> {
  const sep = token.indexOf(":");
  if (sep < 0) throw new Error("token must be userId:apiKey");
  const userId = token.slice(0, sep).trim();
  const apiKey = token.slice(sep + 1).trim();
  const res = await fetch(
    `https://studio-api.nmkr.io/v2/UploadToIpfs/${userId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mimetype: mime,
        name,
        fileFromBase64: base64FromBytes(bytes),
      }),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Success is a bare JSON string (the CID); tolerate an object wrapper too.
  const body = (await res.json()) as unknown;
  const cid =
    typeof body === "string"
      ? body
      : typeof (body as Record<string, unknown>)?.["ipfsHash"] === "string"
        ? ((body as Record<string, unknown>)["ipfsHash"] as string)
        : null;
  if (!cid) throw new Error("no CID in response");
  return cid.trim().replace(/^ipfs:\/\//, "");
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
