import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  type TallyArtifact,
  type TallyBody,
} from "cip-179/tally";

/**
 * Keep a verdict's two sides as files: `rebuilt.json` holds exactly the bytes
 * the rebuilt hash is computed over, so its blake2b-256 is that hash, and
 * `served.json` the artifact under test. The backend serves `JSON.stringify`
 * of its artifact, which parsing and re-serializing reproduces byte for byte.
 */
export async function saveTallies(
  dir: string,
  rebuilt: TallyBody,
  served: TallyArtifact,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rebuilt.json"), canonicalJson(rebuilt));
  await writeFile(join(dir, "served.json"), JSON.stringify(served));
}
