import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, type TallyArtifact } from "cip-179/tally";

/**
 * Keep a verdict's two sides as files, each a whole artifact: `rebuilt.json`
 * this verifier's, canonical, and `served.json` the artifact under test as
 * the backend served it (the backend serves `JSON.stringify` of its
 * artifact, which parsing and re-serializing reproduces byte for byte). Only
 * the `tally` sections are compared: on a MATCH their canonical forms are
 * identical, and their blake2b-256 is the survey's `artifactHash`.
 */
export async function saveArtifacts(
  dir: string,
  rebuilt: TallyArtifact,
  served: TallyArtifact,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rebuilt.json"), canonicalJson(rebuilt));
  await writeFile(join(dir, "served.json"), JSON.stringify(served));
}
