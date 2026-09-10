import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raw Ed25519 public keys of the aggregators' ancillary signing keys, read on
 * 2026-09-09 from the Mithril repository at
 * `mithril-infra/configuration/<aggregator>/ancillary.vkey`, where each is
 * the hex of a JSON byte array. Preview and preprod publish the same key.
 */
export const VERIFICATION_KEY: Record<string, string> = {
  mainnet: "174760852ffde288eb39a46aba02151d78a35979b18ad08ad6633a16003a0345",
  preprod: "bdc0d89672d8edd22d1215c4d0f69202fcf3fbc51c9dcc911e0ee4a881538824",
  preview: "bdc0d89672d8edd22d1215c4d0f69202fcf3fbc51c9dcc911e0ee4a881538824",
};

/** `ancillary_manifest.json`: archive path → sha256 hex, plus the signature. */
export interface Manifest {
  readonly data: Record<string, string>;
  readonly signature: string;
}

/**
 * What the aggregator signs: sha256 over each `path ‖ hash` in the order of
 * Rust's `BTreeMap<PathBuf, String>`, which compares paths component by
 * component, so `a/b` sorts before `a-b`.
 */
export function manifestDigest(data: Record<string, string>): Buffer {
  const hash = createHash("sha256");
  for (const path of Object.keys(data).sort(comparePaths)) {
    hash.update(path).update(data[path]!);
  }
  return hash.digest();
}

function comparePaths(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) {
      return Buffer.compare(Buffer.from(as[i]!), Buffer.from(bs[i]!));
    }
  }
  return as.length - bs.length;
}

const ED25519_SPKI_PREFIX = "302a300506032b6570032100";

export function verifyManifest(manifest: Manifest, keyHex: string): boolean {
  const key = createPublicKey({
    key: Buffer.from(ED25519_SPKI_PREFIX + keyHex, "hex"),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(manifest.signature, "hex");
  return verify(null, manifestDigest(manifest.data), key, signature);
}

async function sha256(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return hash.digest("hex");
}

async function main([network, dir]: (string | undefined)[]): Promise<void> {
  const key = network === undefined ? undefined : VERIFICATION_KEY[network];
  if (key === undefined || dir === undefined) {
    throw new Error("usage: verify <mainnet|preprod|preview> <extracted-dir>");
  }
  const manifest = JSON.parse(
    await readFile(join(dir, "ancillary_manifest.json"), "utf8"),
  ) as Manifest;
  if (!verifyManifest(manifest, key)) {
    throw new Error(
      `manifest signature does not verify against the ${network} key`,
    );
  }
  console.log(`manifest signature verifies against the ${network} key`);
  let stateChecked = false;
  for (const [path, expected] of Object.entries(manifest.data)) {
    const actual = await sha256(join(dir, path));
    if (actual === undefined) {
      console.log(`absent  ${path}`);
      continue;
    }
    if (actual !== expected) {
      throw new Error(`${path}: sha256 ${actual}, manifest says ${expected}`);
    }
    console.log(`ok      ${path}`);
    stateChecked ||= /^ledger\/\d+\/state$/.test(path);
  }
  if (!stateChecked) {
    throw new Error(`${dir} holds no ledger state listed by the manifest`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
